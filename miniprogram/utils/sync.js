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
function upsert(collection, data, id) {
  const rid = id || ('u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
  const updatedAt = Date.now();
  store.applyLocalUpsert(collection, { id: rid, data, updatedAt });
  store.enqueue({ type: 'put', collection, id: rid, data, updatedAt });
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
      ? api.apiPut(item.collection, item.id, item.data, item.updatedAt)
      : api.apiDelete(item.collection, item.id, item.updatedAt);
    p.then((res) => {
      // 服务端拒绝旧写入：以服务端为准回写本地
      if (res && res.applied === false && res.record) {
        store.applyLocalUpsert(item.collection, res.record);
      }
      q.shift();
      store.persist();
      store.setSyncState('idle');
      step();
    }).catch((error) => {
      flushLock = false;
      store.setSyncState('offline'); // 保留队列，15s 后自动重试
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
