/* 状态中心：唯一数据源 + 发布订阅。
 * 铁律：页面渲染只读 state，由 notify() 统一触发；渲染函数之间互不调用。 */
const { pickSettings } = require('./settings-utils');
const { migrateSettingsCategories } = require('./category-utils');

const STATE_KEY = 'wb_life_state';
const COLLECTIONS = ['money', 'habit', 'plan', 'fitness', 'shopping', 'media', 'accounts', 'settings', 'memories'];

/*
 * 微信本地缓存：单个 key 上限 1MB、全部 key 合计上限 10MB（官方 wx.setStorageSync 文档）。
 * 这里把 9 个集合的全量快照写进同一个 key，记录变多后会撞上限；超限时 setStorageSync 会抛错，
 * 若不处理就是「用户以为记下了、重启后本机缓存回退」的静默数据风险。
 * 阈值留在 1MB 以下并留出余量，超限前先做无损瘦身（只丢墓碑），并把状态暴露给「我的」页提示用户。
 */
const MAX_PERSIST_CHARS = 900000;
const TOMBSTONE_KEEP_MS = 7 * 24 * 3600 * 1000;
/* 被服务端明确拒绝的写入最多保留这么多条，够用户判断问题、又不至于把本机缓存撑大 */
const MAX_REJECTED_WRITES = 20;

const state = {
  records: {},
  since: 0,          // 本地见过的最大 updatedAt（客户端时钟口径）
  queue: [],         // 待写队列 [{type:'put'|'del', collection, id, data?, updatedAt}]
  syncState: 'idle', // idle | syncing | offline
  ready: false,
  persistSize: 0,        // 上次成功序列化的字符数
  persistError: '',      // 非空表示本机缓存写入失败，需要用户处理
  prunedCount: 0,        // 累计因超限被清理的旧墓碑数
  /*
   * 被服务端拒绝（4xx）而丢弃的写入 [{ item, statusCode, code, at }]。
   * 这类写入永远不会成功，继续重试只会堵住整条队列并刷屏控制台；
   * 但直接丢掉又是静默丢数据，所以留在这里由「我的 → 数据状态」提示用户并可手动重试。
   */
  rejectedWrites: []
};
for (const c of COLLECTIONS) state.records[c] = {};

const subs = new Set();

function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
function notify() { subs.forEach((fn) => { try { fn(); } catch (e) { console.error('notify', e); } }); }

function buildSnapshot() {
  return { records: state.records, since: state.since, queue: state.queue, rejectedWrites: state.rejectedWrites };
}

/* 估算持久化体积（字符数）。微信按字符数计 1MB，失败前先算清楚，别等 setStorageSync 抛错。 */
function snapshotChars(snapshot) {
  try { return JSON.stringify(snapshot).length; } catch (error) { return 0; }
}

/*
 * 无损瘦身：丢弃超过保留窗口的墓碑。
 * 墓碑只用于把「删除」事件带到别的设备，服务端仍保留墓碑并在增量拉取时下发，所以本机丢弃是安全的。
 * 未过窗口的墓碑保留，避免同一设备短时间内重复删除时被其他设备的旧写入覆盖。
 */
function pruneTombstones() {
  const now = Date.now();
  let removed = 0;
  for (const collection of COLLECTIONS) {
    for (const id of Object.keys(state.records[collection])) {
      const record = state.records[collection][id];
      if (record && record.deletedAt && now - record.deletedAt > TOMBSTONE_KEEP_MS) {
        delete state.records[collection][id];
        removed++;
      }
    }
  }
  if (removed) state.prunedCount += removed;
  return removed;
}

/* 本机缓存占用（字符数 → KB 展示用） */
function localCacheChars() {
  return snapshotChars(buildSnapshot());
}

/*
 * 重建本机缓存：清空本地记录并从 since=0 全量重拉。
 * 只在写入已失败、或用户主动要求时使用；云端数据不受影响，拉取完成前页面会短暂显示为空。
 * queue 必须保留 —— 那是还没上送成功的写，一旦丢掉就是真丢数据。
 */
function rebuildCache() {
  for (const collection of COLLECTIONS) state.records[collection] = {};
  state.since = 0;
  state.persistError = '';
  persist();
  notify();
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    // 超限前先做一次无损瘦身，尽量不进入失败分支
    if (snapshotChars(buildSnapshot()) > MAX_PERSIST_CHARS) pruneTombstones();
    const snapshot = buildSnapshot();
    const chars = snapshotChars(snapshot);
    state.persistSize = chars;
    try {
      wx.setStorageSync(STATE_KEY, snapshot);
      if (state.persistError) { state.persistError = ''; notify(); }
    } catch (error) {
      // 写失败必须让用户看见：本地缓存无法落盘，重启后可能回退到上一次成功保存的状态
      const next = '本机缓存写入失败（约 ' + Math.round(chars / 1024) + 'KB）。请到「我的 → 数据与隐私」导出备份后重建本机缓存。';
      console.error('persist fail', error);
      if (state.persistError !== next) { state.persistError = next; notify(); }
    }
  }, 250);
}

function loadLocal() {
  try {
    const raw = wx.getStorageSync(STATE_KEY);
    if (raw && raw.records) {
      for (const c of COLLECTIONS) state.records[c] = raw.records[c] || {};
      state.since = raw.since || 0;
      state.queue = Array.isArray(raw.queue) ? raw.queue : [];
      state.rejectedWrites = Array.isArray(raw.rejectedWrites) ? raw.rejectedWrites : [];

      let migrated = false;
      const appSettings = state.records.settings.app;
      if (appSettings && appSettings.data) {
        const cleaned = pickSettings(appSettings.data);
        // 分类配置旧格式迁移：扁平名字数组 → 方向+名称条目（见 utils/category-utils.js）
        const categoryMigrated = migrateSettingsCategories(cleaned);
        const merged = categoryMigrated ? { ...cleaned, ...categoryMigrated } : cleaned;
        if (JSON.stringify(merged) !== JSON.stringify(appSettings.data)) {
          appSettings.data = merged;
          migrated = true;
        }
      }
      state.queue = state.queue.map((item) => {
        if (!item || item.type !== 'put' || item.collection !== 'settings' || !item.data) return item;
        const cleaned = pickSettings(item.data);
        const categoryMigrated = migrateSettingsCategories(cleaned);
        const nextData = categoryMigrated ? { ...cleaned, ...categoryMigrated } : cleaned;
        if (JSON.stringify(nextData) === JSON.stringify(item.data)) return item;
        migrated = true;
        return { ...item, data: nextData };
      });
      if (migrated) persist();
    }
  } catch (e) { console.error('loadLocal fail', e); }
  state.persistSize = snapshotChars(buildSnapshot());
  state.ready = true;
}

function setSyncState(s) { if (state.syncState !== s) { state.syncState = s; notify(); } }

// ---- 数据变更入口（页面/引擎统一从这里改数据） ----
function applyLocalUpsert(collection, record) {
  const rec = state.records[collection];
  const old = rec[record.id];
  if (old && (old.updatedAt || 0) > (record.updatedAt || 0)) return false;
  rec[record.id] = { id: record.id, data: record.data || {}, updatedAt: record.updatedAt, deletedAt: record.deletedAt || 0 };
  bumpSince(record.updatedAt);
  persist();
  return true;
}
function applyLocalDelete(collection, id, updatedAt) {
  const rec = state.records[collection];
  const old = rec[id];
  if (old && (old.updatedAt || 0) > updatedAt) return false;
  rec[id] = { id, data: old ? old.data : {}, updatedAt, deletedAt: updatedAt };
  bumpSince(updatedAt);
  persist();
  return true;
}

/* 服务端权威回写（导入冲突 reason=exists 等场景）：无条件以服务端记录覆盖本地，含墓碑。
 * 不做 LWW —— 服务端明确说「以云端为准」时，本地较新的 updatedAt 不能推翻这个决定。 */
function forceApplyServer(collection, record) {
  if (!record || !record.id || !state.records[collection]) return false;
  state.records[collection][record.id] = {
    id: record.id,
    data: record.data || {},
    updatedAt: record.updatedAt || 0,
    deletedAt: record.deletedAt || 0
  };
  bumpSince(record.updatedAt || 0);
  persist();
  return true;
}
function bumpSince(t) { if (t > state.since) state.since = t; }

function enqueue(item) {
  state.queue.push(item);
  persist();
}

/*
 * 记录一条被服务端明确拒绝的写入（4xx）。
 * 同一条记录（collection + id）只保留最近一次，避免用户反复操作把列表刷爆。
 */
function recordRejectedWrite(entry) {
  if (!entry || !entry.item) return;
  const record = {
    item: entry.item,
    statusCode: entry.statusCode || 0,
    code: entry.code || '',
    at: Date.now()
  };
  state.rejectedWrites = state.rejectedWrites
    .filter((r) => !(r.item && r.item.collection === record.item.collection && r.item.id === record.item.id))
    .concat(record)
    .slice(-MAX_REJECTED_WRITES);
  persist();
  notify();
}

function clearRejectedWrites() {
  if (!state.rejectedWrites.length) return;
  state.rejectedWrites = [];
  persist();
  notify();
}

/*
 * 手动重试被拒写入：放回待写队列头部。
 * 必须换一个新的 updatedAt —— 服务端按 LWW 以 updatedAt 大者为准，
 * 沿用原来那个（已被拒过的）时间戳会被判为旧写入而直接丢弃。
 */
function retryRejectedWrites() {
  const pending = state.rejectedWrites;
  if (!pending.length) return 0;
  state.rejectedWrites = [];
  const now = Date.now();
  state.queue = pending.map((r, index) => ({ ...r.item, updatedAt: now + index })).concat(state.queue);
  persist();
  notify();
  return pending.length;
}

function resetLocal() {
  clearTimeout(persistTimer);
  for (const collection of COLLECTIONS) state.records[collection] = {};
  state.since = 0;
  state.queue = [];
  state.syncState = 'idle';
  state.ready = false;
  state.persistSize = 0;
  state.persistError = '';
  state.prunedCount = 0;
  state.rejectedWrites = [];
  try { wx.removeStorageSync(STATE_KEY); } catch (e) { /* ignore */ }
  notify();
}

module.exports = {
  state, COLLECTIONS, MAX_PERSIST_CHARS,
  subscribe, notify, loadLocal, persist, setSyncState,
  applyLocalUpsert, applyLocalDelete, forceApplyServer, enqueue, resetLocal,
  localCacheChars, pruneTombstones, rebuildCache,
  recordRejectedWrite, clearRejectedWrites, retryRejectedWrites
};
