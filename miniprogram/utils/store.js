/* 状态中心：唯一数据源 + 发布订阅。
 * 铁律：页面渲染只读 state，由 notify() 统一触发；渲染函数之间互不调用。 */
const { pickSettings } = require('./settings-utils');

const STATE_KEY = 'wb_life_state';
const COLLECTIONS = ['money', 'habit', 'plan', 'fitness', 'shopping', 'media', 'accounts', 'settings', 'memories'];

const state = {
  records: {},
  since: 0,          // 本地见过的最大 updatedAt（客户端时钟口径）
  queue: [],         // 待写队列 [{type:'put'|'del', collection, id, data?, updatedAt}]
  syncState: 'idle', // idle | syncing | offline
  ready: false
};
for (const c of COLLECTIONS) state.records[c] = {};

const subs = new Set();

function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
function notify() { subs.forEach((fn) => { try { fn(); } catch (e) { console.error('notify', e); } }); }

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      wx.setStorageSync(STATE_KEY, {
        records: state.records, since: state.since, queue: state.queue
      });
    } catch (e) { console.error('persist fail', e); }
  }, 250);
}

function loadLocal() {
  try {
    const raw = wx.getStorageSync(STATE_KEY);
    if (raw && raw.records) {
      for (const c of COLLECTIONS) state.records[c] = raw.records[c] || {};
      state.since = raw.since || 0;
      state.queue = Array.isArray(raw.queue) ? raw.queue : [];

      let migrated = false;
      const appSettings = state.records.settings.app;
      if (appSettings && appSettings.data) {
        const cleaned = pickSettings(appSettings.data);
        if (JSON.stringify(cleaned) !== JSON.stringify(appSettings.data)) {
          appSettings.data = cleaned;
          migrated = true;
        }
      }
      state.queue = state.queue.map((item) => {
        if (!item || item.type !== 'put' || item.collection !== 'settings' || !item.data) return item;
        const cleaned = pickSettings(item.data);
        if (JSON.stringify(cleaned) === JSON.stringify(item.data)) return item;
        migrated = true;
        return { ...item, data: cleaned };
      });
      if (migrated) persist();
    }
  } catch (e) { console.error('loadLocal fail', e); }
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
function bumpSince(t) { if (t > state.since) state.since = t; }

function enqueue(item) {
  state.queue.push(item);
  persist();
}

function resetLocal() {
  clearTimeout(persistTimer);
  for (const collection of COLLECTIONS) state.records[collection] = {};
  state.since = 0;
  state.queue = [];
  state.syncState = 'idle';
  state.ready = false;
  try { wx.removeStorageSync(STATE_KEY); } catch (e) { /* ignore */ }
  notify();
}

module.exports = { state, COLLECTIONS, subscribe, notify, loadLocal, persist, setSyncState, applyLocalUpsert, applyLocalDelete, enqueue, resetLocal };
