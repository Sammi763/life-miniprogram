const assert = require('assert');
const path = require('path');
const store = require('../miniprogram/utils/store');
const sync = require('../miniprogram/utils/sync');

function loadPage() {
  const target = path.resolve(__dirname, '../miniprogram/pages/memory/memory.js');
  const original = global.Page;
  let definition;
  global.Page = (page) => { definition = page; };
  delete require.cache[require.resolve(target)];
  require(target);
  global.Page = original;
  return definition;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function assignPath(target, key, value) {
  const keys = key.split('.');
  let current = target;
  keys.slice(0, -1).forEach((part) => { current[part] = current[part] || {}; current = current[part]; });
  current[keys[keys.length - 1]] = value;
}
function makePage(definition) {
  return {
    ...definition,
    data: clone(definition.data),
    setData(update) { Object.keys(update).forEach((key) => assignPath(this.data, key, update[key])); }
  };
}

const originalMemories = store.state.records.memories;
const originalUpsert = sync.upsert;
const originalRemove = sync.remove;
const originalWx = global.wx;
try {
  const storage = {};
  const writes = [];
  global.wx = {
    getStorageSync: (key) => storage[key],
    setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: (key) => { delete storage[key]; },
    showToast() {},
    stopPullDownRefresh() {}
  };
  store.state.records.memories = {
    old: { id: 'old', data: { content: '旧随记', occurredAt: '2026-09-03T08:00', mood: 'calm', tags: ['日常'] }, updatedAt: 1, deletedAt: 0 }
  };
  sync.upsert = (...args) => writes.push(['upsert', ...args]);
  sync.remove = (...args) => writes.push(['remove', ...args]);

  const page = makePage(loadPage());
  storage.wb_life_memory_draft_new = { content: '未保存的想法', occurredAt: '2026-09-04T09:30', mood: 'happy', tags: ['草稿'] };
  page.openComposer.call(page);
  assert.strictEqual(page.data.form.content, '未保存的想法', '新随记应恢复本地草稿');
  assert.strictEqual(page.data.restoredDraft, true, '恢复草稿应有明确反馈状态');

  page.data.form = { id: '', content: '明确保存后才同步', date: '2026-09-04', time: '10:20', mood: 'energized', tagsInput: '工作，日常，工作' };
  page.saveDraft.call(page);
  assert.deepStrictEqual(storage.wb_life_memory_draft_new.tags, ['工作', '日常'], '草稿应在本机去重标签');
  page.saveMemory.call(page);
  assert.deepStrictEqual(writes.pop(), ['upsert', 'memories', {
    content: '明确保存后才同步', occurredAt: '2026-09-04T10:20', mood: 'energized', tags: ['工作', '日常']
  }, undefined], '明确保存才应进入同步队列');
  assert.strictEqual(storage.wb_life_memory_draft_new, undefined, '成功保存应清理草稿');

  page.removeMemory.call(page, { currentTarget: { dataset: { id: 'old' } } });
  assert.deepStrictEqual(writes.pop(), ['remove', 'memories', 'old'], '删除必须走同步墓碑协议');
  page.undoDelete.call(page);
  assert.deepStrictEqual(writes.pop(), ['upsert', 'memories', store.state.records.memories.old.data, 'old'], '短暂撤销应恢复原记录与原 id');
} finally {
  store.state.records.memories = originalMemories;
  sync.upsert = originalUpsert;
  sync.remove = originalRemove;
  global.wx = originalWx;
}

console.log('MEMORY_PAGE_TEST_PASSED');
