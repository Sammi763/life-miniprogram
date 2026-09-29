/* 同步引擎：先渲染本地缓存 → 拉云端增量 → 写队列乐观上送 → 失败可见可重试
 * 架构约束：本文件是唯一发起网络读写的地方；页面只调 upsert/remove/refresh，
 * 渲染由 store.notify() 统一驱动，页面渲染函数之间互不调用。 */
const api = require('./api');
const store = require('./store');

const SEED_FLAG = 'wb_life_seeded';
let wsTask = null;
let wsRetry = 0;
let pullTimer = null;
let flushTimer = null;
let retryTimer = null;
let reconnectTimer = null;
let pullLock = false;
let flushLock = false;
let flushWaiters = [];
let pullingDebounce = null;
let initialized = false;
let networkHandler = null;

// ---------- 拉取（增量） ----------
function pull() {
  if (pullLock) return Promise.resolve(false);
  pullLock = true;
  store.setSyncState('syncing');
  return api.apiSync(store.state.since)
    .then((res) => {
      applyChanges(res.changes || {});
      store.setSyncState('idle');
      flush().catch(() => {});
      return true;
    })
    .catch(() => {
      store.setSyncState('offline');
      return false;
    })
    .then((synced) => {
      pullLock = false;
      return synced;
    });
}
function pullSoon() {
  clearTimeout(pullingDebounce);
  pullingDebounce = setTimeout(pull, 1200);
}

function applyChanges(changes) {
  let touched = false;
  for (const coll of Object.keys(changes)) {
    if (!store.state.records[coll]) continue;
    for (const r of changes[coll]) {
      if (r.deletedAt) {
        touched = store.applyLocalDelete(coll, r.id, r.updatedAt) || touched;
      } else {
        touched = store.applyLocalUpsert(coll, { id: r.id, data: r.data, updatedAt: r.updatedAt }) || touched;
      }
    }
  }
  if (touched) { store.persist(); store.notify(); }
}

// ---------- 写入（乐观更新 + 队列） ----------
function upsert(collection, data, id, options) {
  const rid = id || ('u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
  // options.updatedAt 供需要固定时间戳的写入使用（如导入恢复）；默认仍取当前时钟。
  const updatedAt = options && Number(options.updatedAt) > 0 ? Number(options.updatedAt) : Date.now();
  store.applyLocalUpsert(collection, { id: rid, data, updatedAt });
  const queued = { type: 'put', collection, id: rid, data, updatedAt };
  // createOnly：导入恢复语义 —— 服务端仅在该记录不存在时创建，已存在（存活或墓碑）以云端为准
  if (options && options.createOnly) queued.createOnly = true;
  store.enqueue(queued);
  store.notify();
  scheduleFlush();
  return rid;
}

function remove(collection, id) {
  const updatedAt = Date.now();
  store.applyLocalDelete(collection, id, updatedAt);
  store.enqueue({ type: 'del', collection, id, updatedAt });
  store.notify();
  scheduleFlush();
}

// ---------- 队列冲刷 ----------
function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flush().catch(() => {}); }, 800);
}

/*
 * 服务端明确拒绝（4xx）区别于传输失败：这条写入重发多少次都不会成功。
 * 旧实现把它当传输失败处理 —— 保留队首 + 15 秒后再冲。而 flush() 是严格 FIFO（只看 q[0]），
 * 于是一条被永久拒绝的写入会永久堵住整个队列，并且每 15 秒往控制台打一次同样的错误
 * （实测 PUT settings/app 因服务端旧版本不认 aiConsent 返回 422，3 分钟内重发 15 次、
 * 「我的 → 待同步」永不归零）。
 * 例外：401 是登录态失效（重新登录后可能成功）、408/429 本身是暂时性错误，都保留重试语义。
 */
function isPermanentRejection(error) {
  const status = Number(error && error.statusCode) || 0;
  if (status < 400 || status >= 500) return false;
  return status !== 401 && status !== 408 && status !== 429;
}

function flush() {
  const completion = new Promise((resolve, reject) => {
    if (!store.state.queue.length && !flushLock) { resolve(); return; }
    flushWaiters.push({ resolve, reject });
  });
  if (flushLock) return completion;
  const q = store.state.queue;
  if (!q.length) return completion;
  flushLock = true;
  const settle = (error) => {
    const waiters = flushWaiters;
    flushWaiters = [];
    waiters.forEach((waiter) => error ? waiter.reject(error) : waiter.resolve());
  };
  const step = () => {
    const item = q[0];
    if (!item) { flushLock = false; store.setSyncState('idle'); settle(); return; }
    const p = item.type === 'put'
      ? api.apiPut(item.collection, item.id, item.data, item.updatedAt, item.createOnly)
      : api.apiDelete(item.collection, item.id, item.updatedAt);
    p.then((res) => {
      // 服务端拒绝旧写入：以服务端为准回写本地。
      // reason=exists（导入恢复冲突）：服务端现状是权威 —— 云端已有的存活记录/墓碑必须原样覆盖本地，
      // 不能走 LWW（本地导入写入的 updatedAt 更新，普通合并会错误地保住导入值）。
      if (res && res.applied === false && res.record) {
        if (res.reason === 'exists') store.forceApplyServer(item.collection, res.record);
        else store.applyLocalUpsert(item.collection, res.record);
      }
      q.shift();
      store.persist();
      store.setSyncState('idle');
      step();
    }).catch((error) => {
      if (isPermanentRejection(error)) {
        /*
         * 丢弃队首并继续冲刷后面的写入。
         * 本地记录保留用户填的值（不静默回滚），把拒绝原因记进 store 由「我的」页提示并可手动重试。
         */
        q.shift();
        store.recordRejectedWrite({
          item,
          statusCode: Number(error && error.statusCode) || 0,
          code: (error && error.code) || ''
        });
        store.persist();
        step();
        return;
      }
      flushLock = false;
      store.setSyncState('offline'); // 传输类失败：保留队列，15s 后自动重试
      settle(error);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { retryTimer = null; flush().catch(() => {}); }, 15000);
    });
  };
  step();
  return completion;
}

// ---------- WebSocket 实时通知 ----------
function shouldUseRealtime() {
  const runtime = api.getRuntimeConfig();
  // 本地开发以 HTTP 增量同步为准：服务未启动时不会额外制造 WebSocket 控制台错误。
  // 正式版才在已配置的受控 HTTPS 域名上建立实时通知通道。
  return Boolean(runtime && runtime.isProduction && runtime.apiConfigured);
}

function connectWS() {
  if (!shouldUseRealtime()) return;
  const token = wx.getStorageSync('wb_life_token');
  if (!token || wsTask) return;
  const base = api.getBaseUrl().replace(/^http/, 'ws');
  wsTask = wx.connectSocket({
    url: base + '/ws?token=' + encodeURIComponent(token),
    fail: () => { wsTask = null; scheduleReconnect(); }
  });
  if (!wsTask) return;
  wsTask.onOpen(() => { wsRetry = 0; });
  wsTask.onMessage(() => pullSoon());
  wsTask.onClose(() => { wsTask = null; scheduleReconnect(); });
  wsTask.onError(() => { try { wsTask && wsTask.close({}); } catch (e) { /* ignore */ } });
}
function scheduleReconnect() {
  if (!initialized || !shouldUseRealtime()) return;
  wsRetry = Math.min(wsRetry + 1, 6);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!initialized) return;
    pull().then((synced) => { if (synced) connectWS(); });
  }, 5000 * wsRetry);
}

// ---------- 示例数据（首次启动预置，可一键清空） ----------
function fmtDate(d) {
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function yesterday() { const d = new Date(); d.setDate(d.getDate() - 1); return fmtDate(d); }

function seedDemo() {
  // 演示数据只能帮助本地开发；体验版、审核版和正式版必须从干净的个人空间开始。
  if (api.getRuntimeConfig().isProduction) return;
  try { if (wx.getStorageSync(SEED_FLAG)) return; } catch (e) { /* ignore */ }
  const now = Date.now();
  const t = fmtDate(new Date());
  const y = yesterday();
  const seed = (coll, id, data) => upsert(coll, data, id);
  const s = now - 1000;
  // 记账（5 条）
  seed('money', 'demo-money-1', { type: 'expense', amount: 18, category: '餐饮', date: t, note: '早餐·豆浆油条' }, s);
  seed('money', 'demo-money-2', { type: 'expense', amount: 4.5, category: '交通', date: t, note: '地铁' }, s + 1);
  seed('money', 'demo-money-3', { type: 'expense', amount: 32, category: '餐饮', date: t, note: '午餐' }, s + 2);
  seed('money', 'demo-money-4', { type: 'income', amount: 8500, category: '工资', date: y, note: '9月工资' }, s + 3);
  seed('money', 'demo-money-5', { type: 'expense', amount: 89, category: '学习', date: y, note: '《摄影构图》' }, s + 4);
  // 习惯定义（3 条）
  seed('habit', 'demo-habit-d-1', { kind: 'def', name: '喝水', mode: 'count', target: 8, unit: '杯', color: '#378ADD' }, s + 5);
  seed('habit', 'demo-habit-d-2', { kind: 'def', name: '阅读 30 分钟', mode: 'check', target: 1, unit: '', color: '#639922' }, s + 6);
  seed('habit', 'demo-habit-d-3', { kind: 'def', name: '步行', mode: 'value', target: 8000, unit: '步', color: '#BA7517' }, s + 7);
  // 今日打卡（喝水 3/8）
  seed('habit', 'demo-habit-e-1', { kind: 'entry', habitId: 'demo-habit-d-1', date: t, value: 3 }, s + 8);
  // 日程（1 条昨日未完成 = 逾期示例）
  seed('plan', 'demo-plan-1', { title: '还花呗账单', date: y, time: '', done: false }, s + 9);
  seed('plan', 'demo-plan-2', { title: '19:00 出门拍胶片扫街素材', date: t, time: '19:00', done: false }, s + 10);
  // 待买（3 条）
  seed('shopping', 'demo-shop-1', { name: '咖啡豆 250g', note: '上个月喝完的牌子', done: false }, s + 11);
  seed('shopping', 'demo-shop-2', { name: '挂耳滤纸', note: '', done: false }, s + 12);
  seed('shopping', 'demo-shop-3', { name: '镜头清洁笔', note: '闲鱼看看二手', done: false }, s + 13);
  // 书影音（2 条）
  seed('media', 'demo-media-1', { kind: 'book', title: '《光影的秘密》', status: 'doing', rating: 4, comment: '布光那章值得反复看', date: t }, s + 14);
  seed('media', 'demo-media-2', { kind: 'movie', title: '《银翼杀手2049》', status: 'done', rating: 5, comment: '每一帧都能当壁纸', date: y }, s + 15);
  // 体重（2 条）
  seed('fitness', 'demo-fit-1', { kind: 'weight', date: y, weight: 72.5, bodyfat: 20.1 }, s + 16);
  seed('fitness', 'demo-fit-2', { kind: 'weight', date: t, weight: 72.3, bodyfat: 20.0 }, s + 17);
  // 设置（月预算）
  seed('settings', 'app', { budget: 3000 }, s + 18);
  try { wx.setStorageSync(SEED_FLAG, true); } catch (e) { /* ignore */ }
}

function clearDemo() {
  let n = 0;
  for (const coll of store.COLLECTIONS) {
    for (const id of Object.keys(store.state.records[coll])) {
      if (id.indexOf('demo-') === 0) { remove(coll, id); n++; }
    }
  }
  return n;
}

// ---------- 初始化 ----------
function init() {
  if (initialized) return;
  initialized = true;
  store.loadLocal();
  store.notify(); // 先渲染本地缓存，避免白屏
  seedDemo();
  api.ensureLogin()
    .then(() => pull())
    .then((synced) => { if (synced) connectWS(); })
    .catch(() => { store.setSyncState('offline'); });
  pullTimer = setInterval(() => {
    // 离线后交由网络恢复事件或用户下拉触发，避免后端未启动时持续刷错误日志。
    if (store.state.syncState !== 'offline') pull().then((synced) => { if (synced) connectWS(); });
  }, 60000);
  networkHandler = (res) => {
    if (res.isConnected) {
      pull().then((synced) => {
        flush().catch(() => {});
        if (synced) connectWS();
      });
    }
  };
  wx.onNetworkStatusChange(networkHandler);
}

function destroy() {
  clearInterval(pullTimer);
  clearTimeout(flushTimer);
  clearTimeout(retryTimer);
  clearTimeout(reconnectTimer);
  clearTimeout(pullingDebounce);
  try { wsTask && wsTask.close({}); } catch (e) { /* ignore */ }
  if (networkHandler && wx.offNetworkStatusChange) wx.offNetworkStatusChange(networkHandler);
  wsTask = null;
  wsRetry = 0;
  retryTimer = null;
  reconnectTimer = null;
  networkHandler = null;
  pullLock = false;
  flushLock = false;
  flushWaiters = [];
  initialized = false;
}

module.exports = { init, destroy, pull, flush, upsert, remove, clearDemo, connectWS, shouldUseRealtime, fmtDate };
