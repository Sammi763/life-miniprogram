/* 状态中心：唯一数据源 + 发布订阅。
 * 铁律：页面渲染只读 state，由 notify() 统一触发；渲染函数之间互不调用。 */
const { pickSettings } = require('./settings-utils');
const { migrateSettingsCategories } = require('./category-utils');

const STATE_KEY = 'wb_life_state';
/* 待同步与被拒写入一起落盘，避免主快照写入失败或进程退出时丢失本地副本。 */
const QUEUE_KEY = 'wb_life_queue';
/* 退出/删除账号时按说明清除的本机辅助数据（R07：清理范围与文案一致） */
const SEARCH_HISTORY_KEY = 'wb_life_search_history';
const PENDING_OPEN_KEY = 'wb_life_pending_open';
const DRAFT_KEY_PREFIX = 'wb_life_memory_draft_';

const COLLECTIONS = ['money', 'habit', 'plan', 'fitness', 'shopping', 'media', 'accounts', 'settings', 'memories', 'focusSessions', 'weeklyReviews', 'moneyRules'];

/*
 * 微信本地缓存：单个 key 上限 1MB、全部 key 合计上限 10MB（官方 wx.setStorageSync 文档）。
 * 这里把 9 个集合的全量快照写进同一个 key，记录变多后会撞上限；超限时 setStorageSync 会抛错，
 * 若不处理就是「用户以为记下了、重启后本机缓存回退」的静默数据风险。
 * 阈值留在 1MB 以下并留出余量，超限前先做无损瘦身（只丢墓碑），并把状态暴露给「我的」页提示用户。
 */
const MAX_PERSIST_CHARS = 900000;
const TOMBSTONE_KEEP_MS = 7 * 24 * 3600 * 1000;

const state = {
  records: {},
  since: 0,          // legacy 拉取游标：本机见过的最大服务端 updatedAt。只由服务端来源的写入推进（R03）
  syncGeneration: '',
  sinceSeq: 0,       // 下载游标：服务端单调变更序号。本机写入永不推进；-1 哨兵 = 旧版本快照，需一次完整补拉
  queue: [],         // 待写队列 [{type:'put'|'del', collection, id, data?, updatedAt}]
  syncState: 'idle', // idle | syncing | offline
  ready: false,
  persistSize: 0,        // 当前缓存最近一次序列化的字符数
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
/* 集合版本号：每次记录变化自增，供派生数据缓存（月汇总/最近记录等）做失效 key（性能方案 §5） */
const versions = Object.fromEntries(COLLECTIONS.map((c) => [c, 0]));
function bumpVersion(collections) {
  (collections || COLLECTIONS).forEach((c) => { if (c in versions) versions[c] += 1; });
}
function version(collection) { return versions[collection] || 0; }

/*
 * 订阅。collections 是可选的集合名单（数组）：只关心这些集合或 '__sync__'（同步状态/队列/被拒写入）
 * 的页面传入名单，notify 时命中才执行 —— 减少全局广播造成的无关渲染（性能方案 §5）。
 * 不传名单 = 广播订阅（数据状态页、主题同步等需要全量刷新的场景）。
 * 回调收到 changed（本次变化的集合数组；广播时为 undefined）。
 */
function subscribe(fn, collections) {
  const entry = { fn, filter: Array.isArray(collections) && collections.length ? new Set(collections) : null };
  subs.add(entry);
  return () => subs.delete(entry);
}
function notify(changed) {
  subs.forEach((entry) => {
    if (entry.filter && changed && !changed.some((name) => entry.filter.has(name))) return;
    try { entry.fn(changed); } catch (e) { console.error('notify', e); }
  });
}

function buildSnapshot() {
  return { records: state.records, since: state.since, sinceSeq: state.sinceSeq, syncGeneration: state.syncGeneration, queue: state.queue, rejectedWrites: state.rejectedWrites };
}

/* 估算持久化体积（字符数）。微信按字符数计 1MB，失败前先算清楚，别等 setStorageSync 抛错。 */
function snapshotChars(snapshot) {
  try { return JSON.stringify(snapshot).length; } catch (error) { return 0; }
}

/* ---------- 写队列的独立持久化：同步、即时的专用 key ---------- */
let queueSaveFailed = false;

function persistQueue(queue = state.queue, rejectedWrites = state.rejectedWrites) {
  try {
    wx.setStorageSync(QUEUE_KEY, { queue, rejectedWrites });
    if (queueSaveFailed) {
      queueSaveFailed = false;
      state.persistError = '';
      notify(['__sync__']);
    }
    return true;
  } catch (error) {
    console.error('persistQueue fail', error);
    queueSaveFailed = true;
    state.persistError = '本机待同步记录保存失败。请释放本机空间后重试，或先导出备份。';
    notify(['__sync__']);
    return false;
  }
}

function readQueueKey() {
  try {
    const raw = wx.getStorageSync(QUEUE_KEY);
    if (Array.isArray(raw)) return { queue: raw };
    if (raw && Array.isArray(raw.queue) && Array.isArray(raw.rejectedWrites)) return raw;
    return null;
  } catch (error) { return null; }
}

/*
 * 无损瘦身：丢弃超过保留窗口的墓碑。
 * 墓碑只用于把「删除」事件带到别的设备，服务端仍保留墓碑并在增量拉取时下发，所以本机丢弃是安全的。
 * 未过窗口的墓碑保留，避免同一设备短时间内重复删除时被其他设备的旧写入覆盖。
 */
function pruneTombstones(records = state.records) {
  const now = Date.now();
  let removed = 0;
  for (const collection of COLLECTIONS) {
    for (const id of Object.keys(records[collection])) {
      const record = records[collection][id];
      if (record && record.deletedAt && now - record.deletedAt > TOMBSTONE_KEEP_MS &&
          !(collection === 'money' && /^(cycle|repay)-/.test(id))) {
        delete records[collection][id];
        removed++;
      }
    }
  }
  if (removed && records === state.records) state.prunedCount += removed;
  return removed;
}

/* 本机缓存占用（字符数 → KB 展示用） */
function localCacheChars() {
  return snapshotChars(buildSnapshot());
}

/* 快照同步落盘（不带防抖）。persist() 的防抖路径与 App.onHide 的兜底路径都走这里。 */
function writeSnapshot(snapshot = buildSnapshot()) {
  let chars = snapshotChars(snapshot);
  if (chars > MAX_PERSIST_CHARS && pruneTombstones(snapshot.records)) chars = snapshotChars(snapshot);
  if (snapshot.records === state.records) state.persistSize = chars;
  try {
    wx.setStorageSync(STATE_KEY, snapshot);
    state.persistSize = chars;
    if (!queueSaveFailed && state.persistError) { state.persistError = ''; notify(['__sync__']); }
    return true;
  } catch (error) {
    const next = '本机缓存写入失败（约 ' + Math.round(chars / 1024) + 'KB）。请到「我的 → 数据管理」导出备份后重建本机缓存。';
    console.error('persist fail', error);
    if (state.persistError !== next) { state.persistError = next; notify(['__sync__']); }
    return false;
  }
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeSnapshot();
  }, 250);
}
/* 切后台只写已载入、有改动或需要重试的快照。 */
function persistNow() {
  if (state.ready && queueSaveFailed) persistQueue();
  if (!state.ready || (persistTimer === null && !state.persistError)) return;
  flushSnapshot();
}

function flushSnapshot() {
  clearTimeout(persistTimer);
  persistTimer = null;
  writeSnapshot();
}

function overlayLocalWrites(records, queue, rejectedWrites) {
  const latest = new Map();
  for (const item of [...rejectedWrites.map((entry) => entry.item), ...queue]) {
    if (!item || !records[item.collection] || !item.id) continue;
    const key = item.collection + '|' + item.id;
    const previous = latest.get(key);
    if (!previous || (item.updatedAt || 0) >= (previous.updatedAt || 0)) latest.set(key, item);
  }
  for (const item of latest.values()) {
    const previous = records[item.collection][item.id];
    const updatedAt = Number(item.updatedAt) || 0;
    if (previous && previous.updatedAt > updatedAt) continue;
    const deleted = item.type === 'del' || (item.collection === 'money' && item.createOnly && item.data && item.data.skipped);
    records[item.collection][item.id] = {
      id: item.id, data: deleted ? (previous && previous.data) || {} : item.data || {},
      updatedAt, deletedAt: deleted ? updatedAt : 0
    };
  }
}

function cleanedSettings(data) {
  const cleaned = pickSettings(data);
  const migrated = migrateSettingsCategories(cleaned);
  return migrated ? { ...cleaned, ...migrated } : cleaned;
}

function loadLocal() {
  try {
    const dedicatedQueue = readQueueKey();
    const raw = wx.getStorageSync(STATE_KEY) || {};
    queueSaveFailed = false;
    const records = Object.fromEntries(COLLECTIONS.map((c) => [c, (raw.records && raw.records[c]) || {}]));
    state.records = records;
    state.since = raw.since || 0;
    state.syncGeneration = typeof raw.syncGeneration === 'string' ? raw.syncGeneration : '';
    state.sinceSeq = typeof raw.sinceSeq === 'number' && raw.sinceSeq >= -1 ? raw.sinceSeq : (raw.records ? -1 : 0);
    state.queue = dedicatedQueue ? dedicatedQueue.queue : Array.isArray(raw.queue) ? raw.queue : [];
    state.rejectedWrites = dedicatedQueue && dedicatedQueue.rejectedWrites ||
      (Array.isArray(raw.rejectedWrites) ? raw.rejectedWrites : []);
    let migrated = false;
    state.queue = state.queue.map((item) => {
      if (!item || item.type !== 'put' || item.collection !== 'settings' || !item.data) return item;
      const data = cleanedSettings(item.data);
      if (JSON.stringify(data) === JSON.stringify(item.data)) return item;
      migrated = true;
      return { ...item, data };
    });
    overlayLocalWrites(records, state.queue, state.rejectedWrites);
    const appSettings = records.settings.app;
    if (appSettings && appSettings.data) {
      const data = cleanedSettings(appSettings.data);
      if (JSON.stringify(data) !== JSON.stringify(appSettings.data)) {
        appSettings.data = data;
        migrated = true;
      }
    }
    if ((!dedicatedQueue || !dedicatedQueue.rejectedWrites || migrated) && (state.queue.length || state.rejectedWrites.length)) persistQueue();
    if (migrated || state.queue.length || state.rejectedWrites.length) persist();
    bumpVersion(COLLECTIONS);
  } catch (e) {
    state.ready = false;
    console.error('loadLocal fail', e);
    return;
  }
  state.persistSize = snapshotChars(buildSnapshot());
  state.ready = true;
}

function setSyncState(s) { if (state.syncState !== s) { state.syncState = s; notify(['__sync__']); } }

// ---- 数据变更入口（页面/引擎统一从这里改数据） ----
/*
 * options.fromServer：服务端来源的回写（增量拉取/服务端权威回写）才推进 since。
 * 本机编辑（sync.upsert/remove）一律不推进下载游标 —— 否则「另一台设备刚写的记录」
 * 会被 since 一刀切掉，表现为「其他设备的内容怎么少了」（R03）。
 */
function applyLocalUpsert(collection, record, options) {
  const rec = state.records[collection];
  const old = rec[record.id];
  if (old && (old.updatedAt || 0) > (record.updatedAt || 0)) return false;
  rec[record.id] = { id: record.id, data: record.data || {}, updatedAt: record.updatedAt, deletedAt: record.deletedAt || 0 };
  if (options && options.fromServer) bumpSince(record.updatedAt);
  bumpVersion([collection]);
  persist();
  return true;
}
function applyLocalDelete(collection, id, updatedAt, options) {
  const rec = state.records[collection];
  const old = rec[id];
  if (old && (old.updatedAt || 0) > updatedAt) return false;
  rec[id] = { id, data: old ? old.data : {}, updatedAt, deletedAt: updatedAt };
  if (options && options.fromServer) bumpSince(updatedAt);
  bumpVersion([collection]);
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
  bumpVersion([collection]);
  persist();
  return true;
}
function bumpSince(t) { if (t > state.since) state.since = t; }

function advanceSinceSeq(seq, generation) {
  if (typeof generation === 'string' && state.syncGeneration !== generation) {
    state.syncGeneration = generation;
    persist();
  }
  const next = Number(seq) || 0;
  if (next > state.sinceSeq) { state.sinceSeq = next; persist(); }
}

function enqueue(item) {
  state.queue.push(item);
  persistQueue();
  persist();
}

/*
 * 记录一条被服务端明确拒绝的写入（4xx）。
 * 同一条记录（collection + id）只保留最近一次，避免用户反复操作把列表刷爆。
 */
function recordRejectedWrite(entry) {
  if (!entry || !entry.item) return false;
  const { item, statusCode, code } = entry;
  const index = state.queue.indexOf(item);
  const queue = state.queue.filter((record) => record !== item);
  const rejectedWrites = state.rejectedWrites
    .filter((record) => record.item && (record.item.collection !== item.collection || record.item.id !== item.id))
    .concat({ item, statusCode: statusCode || 0, code: code || '', at: Date.now() });
  // The same synchronous write moves the only copy between the two lists.
  if (!persistQueue(queue, rejectedWrites)) return false;
  if (index >= 0) state.queue.splice(index, 1);
  state.rejectedWrites = rejectedWrites;
  persist();
  notify(['__sync__']);
  return true;
}

function clearRejectedWrites() {
  if (!state.rejectedWrites.length || !persistQueue(state.queue, [])) return;
  state.rejectedWrites = [];
  persist();
  notify(['__sync__']);
}

/* Move rejected writes back to the queue in one durable update. */
function retryRejectedWrites() {
  const pending = state.rejectedWrites;
  if (!pending.length) return 0;
  const now = Date.now();
  const retries = pending.map((entry, index) => ({ ...entry.item, updatedAt: now + index }));
  if (!persistQueue(retries.concat(state.queue), [])) return 0;
  state.queue.unshift(...retries);
  state.rejectedWrites = [];
  persist();
  notify(['__sync__']);
  return retries.length;
}

/*
 * 原子换装（R06 缓存重建）：新快照在 staging 校验完成后一次性替换旧记录，
 * 失败路径永不触碰 state.records（页面不会先变空白）。
 * 游标以服务端返回值为准；未同步队列由调用方在 staging 上叠加后再换装。
 */
function swapRecords(nextRecords, nextSinceSeq, nextSince, generation) {
  if (!nextRecords || typeof nextRecords !== 'object') return false;
  for (const c of COLLECTIONS) {
    if (!nextRecords[c] || typeof nextRecords[c] !== 'object') return false;
  }
  const sinceSeq = typeof nextSinceSeq === 'number' ? nextSinceSeq : -1;
  const since = typeof nextSince === 'number' ? nextSince : 0;
  const syncGeneration = typeof generation === 'string' ? generation : '';
  const snapshot = { ...buildSnapshot(), records: nextRecords, since, sinceSeq, syncGeneration };
  if (!writeSnapshot(snapshot)) return false;
  clearTimeout(persistTimer);
  persistTimer = null;
  state.records = nextRecords;
  state.since = since;
  state.sinceSeq = sinceSeq;
  state.syncGeneration = syncGeneration;
  bumpVersion(COLLECTIONS);
  return true;
}

/* ---------- R02/R01：真实数据状态的一致口径（首页/业务页/「我的」共用） ---------- */
/*
 * 优先级：本机保存失败 → 云端拒绝 → 待同步 N 条 → 同步中 → 等待连接 → 已同步。
 * 队列非空时绝不显示「已安全同步」；有持久化错误时绝不承诺「已暂存本机」。
 */
function syncStatus(s) {
  const source = s || state;
  if (source.persistError) {
    return { level: 'error', text: '本机保存失败', detail: source.persistError, tone: 'status-offline' };
  }
  const pending = source.queue.length;
  const rejected = source.rejectedWrites.length;
  if (rejected) {
    const tail = pending ? '另有 ' + pending + ' 条改动待同步。' : '';
    return {
      level: 'rejected',
      text: '部分未同步',
      detail: rejected + ' 条改动被云端拒绝，本机已保留你填的值，不会自动重试，可到「我的」重试或导出备份。' + tail,
      tone: 'status-offline'
    };
  }
  if (source.syncState === 'syncing') {
    return {
      level: 'syncing',
      text: pending ? '正在同步 ' + pending + ' 条' : '正在同步',
      detail: '正在把最新记录安全保存',
      tone: 'status-syncing'
    };
  }
  if (pending) {
    return {
      level: 'pending',
      text: '待同步 ' + pending + ' 条',
      detail: '已保存到本机，网络恢复后自动同步到云端',
      tone: 'status-offline'
    };
  }
  if (source.syncState === 'offline') {
    return { level: 'offline', text: '等待连接', detail: '网络恢复后会自动继续同步', tone: 'status-offline' };
  }
  return { level: 'synced', text: '已安全同步', detail: '本机与云端记录一致', tone: 'status-ready' };
}


/*
 * R01：退出前的数据风险评估。
 * hasLocalOnly = 存在只在本机的写入（待同步队列、被云端拒绝的写入）或本机缓存已写失败 ——
 * 这些是唯一副本，未经用户确认处置前不得清除。
 */
function assessDataSafety(s) {
  const source = s || state;
  return {
    pendingCount: source.queue.length,
    rejectedCount: source.rejectedWrites.length,
    persistError: source.persistError || '',
    hasLocalOnly: Boolean(source.queue.length || source.rejectedWrites.length || source.persistError)
  };
}

/* R07：退出/删除账号时清除说明过的本机辅助数据（随记草稿、记账草稿、上次分类/账户、搜索历史、临时深链）。
 * 只动本文件认识的 key，不误清无关存储。队列 key 属主状态，由 resetLocal 直接清除。 */
const MONEY_DRAFT_KEY = 'wb_life_money_form_draft';
const MONEY_RECENT_KEY = 'wb_life_money_recent';
function clearAuxiliaryLocalData() {
  try {
    const info = wx.getStorageInfoSync ? wx.getStorageInfoSync() : null;
    const keys = (info && Array.isArray(info.keys)) ? info.keys : [];
    keys.forEach((key) => {
      if (String(key).indexOf(DRAFT_KEY_PREFIX) === 0 || String(key).indexOf('wb_life_focus:') === 0) {
        try { wx.removeStorageSync(key); } catch (e) { /* ignore */ }
      }
    });
  } catch (e) { /* getStorageInfoSync 不可用时跳过草稿清扫 */ }
  [SEARCH_HISTORY_KEY, PENDING_OPEN_KEY, MONEY_DRAFT_KEY, MONEY_RECENT_KEY].forEach((key) => {
    try { wx.removeStorageSync(key); } catch (e) { /* ignore */ }
  });
  // Earlier trial builds wrote temporary backup copies into the app sandbox.
  try {
    const directory = wx.env && wx.env.USER_DATA_PATH;
    const fs = directory && wx.getFileSystemManager && wx.getFileSystemManager();
    if (!fs) return;
    for (const name of fs.readdirSync(directory)) {
      if (!/^life-backup-\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
      try { fs.unlinkSync(directory + '/' + name); } catch (error) { /* best effort */ }
    }
  } catch (error) { /* file system unavailable */ }
}

function resetLocal(options) {
  clearTimeout(persistTimer);
  persistTimer = null;
  if (!(options && options.keepAuxiliary)) clearAuxiliaryLocalData();
  for (const collection of COLLECTIONS) state.records[collection] = {};
  state.since = 0;
  state.sinceSeq = 0;
  state.syncGeneration = '';
  state.queue = [];
  state.syncState = 'idle';
  state.ready = false;
  state.persistSize = 0;
  state.persistError = '';
  state.prunedCount = 0;
  state.rejectedWrites = [];
  queueSaveFailed = false;
  try { wx.removeStorageSync(STATE_KEY); } catch (e) { /* ignore */ }
  try { wx.removeStorageSync(QUEUE_KEY); } catch (e) { /* ignore */ }
  notify();
}

/*
 * 重建本机缓存（legacy 兜底路径）：清空本地记录并从 since=0 全量重拉。
 * 只在写入已失败、或用户主动要求时使用；云端数据不受影响。
 * queue 必须保留 —— 那是还没上送成功的写，一旦丢掉就是真丢数据。
 * 原子重建（先拉取校验再换装）见 sync.rebuild()；本函数无生产调用方，
 * 仅为 local-cache-guard 测试保留的 legacy 语义快照。
 */
function rebuildCache() {
  for (const collection of COLLECTIONS) state.records[collection] = {};
  state.since = 0;
  state.persistError = '';
  persist();
  notify();
}

module.exports = {
  state, COLLECTIONS, MAX_PERSIST_CHARS,
  subscribe, notify, loadLocal, persist, persistNow, setSyncState,
  applyLocalUpsert, applyLocalDelete, forceApplyServer, overlayLocalWrites, enqueue, resetLocal,
  localCacheChars, pruneTombstones, rebuildCache,
  recordRejectedWrite, clearRejectedWrites, retryRejectedWrites,
  persistQueue, advanceSinceSeq, swapRecords,
  syncStatus, assessDataSafety, clearAuxiliaryLocalData,
  version
};
