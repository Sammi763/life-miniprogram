const assert = require('assert');
const fs = require('fs');
const path = require('path');
const store = require('../miniprogram/utils/store');

const root = path.resolve(__dirname, '..');
const TIMELINE_PAGE_SIZE = 60;

function read(relative) { return fs.readFileSync(path.join(root, relative), 'utf8'); }
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
/* perDay 条/天，便于构造「一天超量」这类边界 */
function buildMemories(total, perDay) {
  const records = {};
  for (let i = 0; i < total; i += 1) {
    const day = '2026-09-' + String(Math.floor(i / perDay) + 1).padStart(2, '0');
    records['m' + i] = {
      id: 'm' + i,
      data: { content: '第 ' + i + ' 条随记', occurredAt: day + 'T08:00', mood: '', tags: [] },
      updatedAt: i + 1,
      deletedAt: 0
    };
  }
  return records;
}
function shownOf(page) { return page.data.groups.reduce((sum, group) => sum + group.items.length, 0); }

const originalMemories = store.state.records.memories;
const originalWx = global.wx;
try {
  global.wx = {
    getStorageSync: () => undefined,
    setStorageSync() {},
    removeStorageSync() {},
    showToast() {},
    stopPullDownRefresh() {}
  };

  /* ---------- 1. 运行时：分批下发 ---------- */
  store.state.records.memories = buildMemories(200, 20);
  const page = makePage(loadPage());
  page.render.call(page);

  assert.strictEqual(page.data.total, 200, '顶部统计必须是完整条数，不随分批变化');
  assert.strictEqual(page.data.dayCount, 10, '天数统计必须是完整天数');
  assert.strictEqual(shownOf(page), TIMELINE_PAGE_SIZE, '首批只下发一页');
  assert.strictEqual(page.data.shownCount, TIMELINE_PAGE_SIZE);
  assert.strictEqual(page.data.hasMore, true, '还有剩余内容时必须给出加载更多入口');
  assert.strictEqual(page.data.groups.length, 3, '60 条应落在前 3 天（每天 20 条）');

  page.loadMore.call(page);
  assert.strictEqual(shownOf(page), TIMELINE_PAGE_SIZE * 2, '加载更多应累加而不是替换');
  assert.strictEqual(page.data.hasMore, true);

  page.loadMore.call(page);
  page.loadMore.call(page);
  assert.strictEqual(shownOf(page), 200, '继续加载应最终覆盖全部内容');
  assert.strictEqual(page.data.hasMore, false, '全部下发后不应再显示加载更多');

  page.loadMore.call(page);
  assert.strictEqual(shownOf(page), 200, '没有更多内容时重复点击不改变结果');

  page.resetTimeline.call(page);
  assert.strictEqual(shownOf(page), TIMELINE_PAGE_SIZE, '筛选条件变化后应回到第一批');

  /* ---------- 2. 边界：同一天超过预算 ---------- */
  store.state.records.memories = buildMemories(200, 200);
  page.render.call(page);
  assert.strictEqual(page.data.dayCount, 1, '同日记录只算一个日子');
  assert.strictEqual(shownOf(page), TIMELINE_PAGE_SIZE, '同一天超过预算也要按条截断');
  assert.strictEqual(page.data.hasMore, true);
  assert.strictEqual(page.data.groups[0].items.length, TIMELINE_PAGE_SIZE);

  /* ---------- 3. 边界：记录不足一批 ---------- */
  store.state.records.memories = buildMemories(5, 5);
  page.render.call(page);
  assert.strictEqual(shownOf(page), 5);
  assert.strictEqual(page.data.hasMore, false, '记录很少时不应出现加载更多');

  /* ---------- 4. 边界：没有任何记录 ---------- */
  store.state.records.memories = {};
  page.render.call(page);
  assert.strictEqual(page.data.total, 0);
  assert.strictEqual(page.data.groups.length, 0);
  assert.strictEqual(page.data.hasMore, false, '空时间线不应出现加载更多');
} finally {
  store.state.records.memories = originalMemories;
  global.wx = originalWx;
}

/* ---------- 5. 结构契约：入口、样式与筛选回位 ---------- */
const memWxml = read('miniprogram/pages/memory/memory.wxml');
assert.match(memWxml, /wx:if="\{\{hasMore\}\}"/, '时间线需要「加载更多」入口');
assert.match(memWxml, /bindtap="loadMore"/, '加载更多必须绑定 loadMore');
assert.match(memWxml, /\{\{shownCount\}\}/, '需要说明当前已显示多少条');
assert.match(read('miniprogram/pages/memory/memory.wxss'), /\.memory-more\b/, '加载更多需要样式');

const memJs = read('miniprogram/pages/memory/memory.js');
assert.match(memJs, /loadMore\(\)/, '需要提供 loadMore 方法');
assert.match(memJs, /resetTimeline\(\)/, '需要提供回到第一批的方法');
assert.match(memJs, /onKeyword\(event\)[^\n]*resetTimeline\(\)/, '关键词变化后必须回到第一批');
assert.match(memJs, /setFilterMood\(event\)[\s\S]{0,200}?resetTimeline\(\)/, '心情筛选变化后必须回到第一批');
assert.match(memJs, /setFilterTag\(event\)[\s\S]{0,200}?resetTimeline\(\)/, '标签筛选变化后必须回到第一批');
assert.match(memJs, /clearFilters\(\)[^\n]*resetTimeline\(\)/, '清除筛选后必须回到第一批');

console.log('MEMORY_TIMELINE_TEST_PASSED');
