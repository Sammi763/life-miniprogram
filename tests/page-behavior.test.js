/*
 * 行为级覆盖：补齐 search / review / shopping 三个页面此前只有「文件存在性」断言的缺口。
 * 这三个页面各自承担了搜索聚合、周复盘聚合、待买清单增删改的入口逻辑，
 * 之前在 tests/ 里没有任何 require 页面逻辑的断言。
 */
const assert = require('assert');
const path = require('path');
const store = require('../miniprogram/utils/store');
const sync = require('../miniprogram/utils/sync');

function loadPage(name) {
  const target = path.resolve(__dirname, '../miniprogram/pages/' + name + '/' + name + '.js');
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
function record(id, data, updatedAt) { return { id, data, updatedAt: updatedAt || 1, deletedAt: 0 }; }

const originalState = clone(store.state.records);
const originalUpsert = sync.upsert;
const originalRemove = sync.remove;
const originalWx = global.wx;

try {
  const writes = [];
  const toasts = [];
  const nav = [];
  const modals = [];
  let modalAnswer = true;

  global.wx = {
    getStorageSync: () => undefined,
    setStorageSync() {},
    removeStorageSync() {},
    showToast: (options) => toasts.push(options.title),
    stopPullDownRefresh() {},
    navigateTo: (options) => nav.push(['navigateTo', options.url]),
    switchTab: (options) => nav.push(['switchTab', options.url]),
    setClipboardData() {},
    showModal: (options) => { modals.push(options.title); if (options.success) options.success({ confirm: modalAnswer }); }
  };
  sync.upsert = (...args) => writes.push(['upsert', ...args]);
  sync.remove = (...args) => writes.push(['remove', ...args]);

  /* ================= search ================= */
  store.state.records.memories = {
    m1: record('m1', { content: '今天的咖啡很好', occurredAt: '2026-09-20T09:00', mood: 'calm', tags: ['日常'] }, 10)
  };
  store.state.records.money = {
    a1: record('a1', { type: 'expense', amount: 32, category: '餐饮', note: '买了咖啡豆', date: '2026-09-20' }, 11)
  };
  store.state.records.plan = { p1: record('p1', { title: '写周报', date: '2026-09-21', done: false }, 12) };
  store.state.records.shopping = { s1: record('s1', { name: '牛奶', done: false }, 13) };
  store.state.records.media = { d1: record('d1', { kind: 'book', title: '孤独星球', status: 'done' }, 14) };

  const search = makePage(loadPage('search'));

  search.data.keyword = '';
  search.render.call(search);
  assert.deepStrictEqual(search.data.results, [], '未输入关键词时不返回任何结果');
  assert.strictEqual(search.data.searched, false, '未搜索时不应展示「无结果」状态');

  search.data.keyword = '咖啡';
  search.render.call(search);
  assert.strictEqual(search.data.results.length, 2, '应同时命中随记与账本');
  assert.strictEqual(search.data.searched, true, '有关键词即视为已搜索');
  const memoryHit = search.data.results.find((item) => item.kind === 'memory');
  const moneyHit = search.data.results.find((item) => item.kind === 'money');
  assert.strictEqual(memoryHit.kindText, '随记', '随记结果需要中文类型标签');
  assert.strictEqual(moneyHit.kindText, '账本', '账本结果需要中文类型标签');

  search.data.kind = 'money';
  search.render.call(search);
  assert.strictEqual(search.data.results.length, 1, '按类型筛选后只保留该类型');
  assert.strictEqual(search.data.results[0].kind, 'money');

  /* 书影音走自己的标题字段，确认五类来源都可检索 */
  search.data.kind = '';
  search.data.keyword = '孤独';
  search.render.call(search);
  assert.strictEqual(search.data.results.length, 1, '书影音标题应可被检索');
  assert.strictEqual(search.data.results[0].kindText, '书影音');

  search.data.kind = '';
  search.data.keyword = '不存在的关键词';
  search.render.call(search);
  assert.deepStrictEqual(search.data.results, [], '无命中时结果为空');
  assert.strictEqual(search.data.searched, true, '搜索过但无命中，仍要显示空状态而不是初始态');

  /* 打开结果：随记带 id 跳详情，账本只能 switchTab 回 tab 页 */
  nav.length = 0;
  search.data.results = [{ id: 'm1', kind: 'memory' }, { id: 'a1', kind: 'money' }];
  search.openResult.call(search, { currentTarget: { dataset: { id: 'm1', kind: 'memory' } } });
  assert.deepStrictEqual(nav.pop(), ['navigateTo', '/pages/memory/memory?id=m1'], '随记结果应带 id 直达该条');
  search.openResult.call(search, { currentTarget: { dataset: { id: 'a1', kind: 'money' } } });
  assert.deepStrictEqual(nav.pop(), ['switchTab', '/pages/money/money'], '账本是 tab 页，必须用 switchTab');
  search.openResult.call(search, { currentTarget: { dataset: { id: 'ghost', kind: 'memory' } } });
  assert.strictEqual(nav.length, 0, '结果不存在时不应发生任何跳转');

  /* ================= review ================= */
  store.state.records.money = {
    w1: record('w1', { type: 'expense', amount: 30, category: '餐饮', date: '2026-09-15' }, 20),
    w2: record('w2', { type: 'income', amount: 100, category: '奖金', date: '2026-09-16' }, 21),
    w3: record('w3', { type: 'expense', amount: 50, category: '居家', date: '2026-09-30' }, 22)
  };
  store.state.records.memories = {
    w4: record('w4', { content: '这周留个念', occurredAt: '2026-09-17T21:00', tags: ['日常'] }, 23),
    w5: record('w5', { content: '上周的', occurredAt: '2026-09-08T21:00', tags: ['日常'] }, 24)
  };
  store.state.records.plan = {};
  store.state.records.habit = {};
  store.state.records.fitness = {};

  const review = makePage(loadPage('review'));
  review.data.weekStart = '2026-09-14';
  review.render.call(review);

  assert.strictEqual(review.data.review.period.start, '2026-09-14', '周起始日期应原样回填');
  assert.strictEqual(review.data.review.period.end, '2026-09-20', '周期应为起始日 + 6 天');
  assert.strictEqual(review.data.weekLabel, '09 月 14 日 - 09 月 20 日', '周期文案应为起止日期');
  assert.strictEqual(review.data.review.finance.income, 100, '只统计周内的收入');
  assert.strictEqual(review.data.review.finance.expense, 30, '周外支出不得计入（09-30 应被排除）');
  assert.strictEqual(review.data.review.finance.balance, 70, '结余应为收入减支出');
  assert.strictEqual(review.data.review.memories.count, 1, '只统计周内的随记');
  assert.strictEqual(review.data.canNext, true, '查看历史周时应允许切到下一周');

  /* 空数据边界：不应抛错，比率回落为 0 */
  store.state.records.money = {};
  store.state.records.memories = {};
  review.data.weekStart = '2026-09-14';
  review.render.call(review);
  assert.strictEqual(review.data.review.finance.income, 0);
  assert.strictEqual(review.data.review.plan.rate, 0, '没有日程时完成率应为 0 而不是 NaN');
  assert.strictEqual(review.data.review.habit.rate, 0, '没有习惯定义时达标率应为 0');

  /* ================= shopping ================= */
  store.state.records.shopping = {
    s1: record('s1', { name: '牛奶', price: 15, done: false }, 10),
    s2: record('s2', { name: '面包', price: 8.5, done: true }, 5),
    s3: record('s3', { name: '', price: 3, done: false }, 1),
    s4: { id: 's4', data: { name: '已删', done: false }, updatedAt: 2, deletedAt: 123 }
  };

  const shopping = makePage(loadPage('shopping'));
  shopping.render.call(shopping);

  assert.strictEqual(shopping.data.total, 1, '未买数量只算未完成的有效条目');
  assert.strictEqual(shopping.data.completedCount, 1, '已买数量应只算已完成条目');
  assert.strictEqual(shopping.data.completedAmountText, '8.5', '已买合计应为已完成条目价格之和（格式化展示）');
  assert.deepStrictEqual(shopping.data.pendingItems.map((item) => item.id), ['s1'], '未买列表只含未完成条目');
  assert.deepStrictEqual(shopping.data.doneItems.map((item) => item.id), ['s2'], '已买列表只含已完成条目');
  /* 金额显示统一走 finance.formatMoney：整数不带小数、小数去末尾 0（详见 tests/money-format.test.js） */
  assert.strictEqual(shopping.data.pendingItems[0].priceText, '¥15', '价格需要格式化展示');
  assert.strictEqual(shopping.data.doneItems[0].priceText, '¥8.5');

  /* 勾选为切换语义：写入的是取反后的值，且带 id 走 upsert */
  writes.length = 0;
  shopping.toggle.call(shopping, { currentTarget: { dataset: { id: 's1' } } });
  assert.deepStrictEqual(writes.pop(), ['upsert', 'shopping', { name: '牛奶', price: 15, done: true }, 's1'], '勾选应写回取反后的 done');
  writes.length = 0;
  shopping.toggle.call(shopping, { currentTarget: { dataset: { id: 'ghost' } } });
  assert.strictEqual(writes.length, 0, '不存在的条目不应产生写入');

  /* 保存校验：空名称、超长名称、负价格都要拦住 */
  shopping.data.form = { id: '', name: '   ', price: '', note: '', link: '', done: false, pinned: false };
  writes.length = 0; toasts.length = 0;
  shopping.save.call(shopping);
  assert.strictEqual(writes.length, 0, '空名称不得写入');
  assert.ok(toasts.includes('请填写物品名称'), '空名称要给出提示');

  shopping.data.form = { id: '', name: '鸡'.repeat(31), price: '', note: '', link: '', done: false, pinned: false };
  writes.length = 0; toasts.length = 0;
  shopping.save.call(shopping);
  assert.strictEqual(writes.length, 0, '超长名称不得写入');
  assert.ok(toasts.includes('名称最多 30 个字'), '超长名称要给出提示');

  shopping.data.form = { id: '', name: '鸡蛋', price: '-1', note: '', link: '', done: false, pinned: false };
  writes.length = 0; toasts.length = 0;
  shopping.save.call(shopping);
  assert.strictEqual(writes.length, 0, '负价格不得写入');

  shopping.data.form = { id: '', name: '鸡蛋', price: '12.5', note: ' 早餐 ', link: ' https://x ', done: false, pinned: true };
  writes.length = 0;
  delete shopping.__lastTapAt;
  shopping.save.call(shopping);
  assert.deepStrictEqual(writes.pop(), ['upsert', 'shopping', { name: '鸡蛋', note: '早餐', price: 12.5, link: 'https://x', done: false, pinned: true }, undefined], '保存应裁剪空白并保留两位价格');
  assert.strictEqual(shopping.data.sheetShow, false, '保存成功应关闭弹层');

  /* 防重复：600ms 内的第二次保存不得再写一条 */
  writes.length = 0;
  shopping.data.form = { id: '', name: '鸡蛋', price: '12.5', note: '', link: '', done: false, pinned: false };
  shopping.save.call(shopping);
  assert.strictEqual(writes.length, 0, '连续点击保存只应写入一次');

  /* 清空已买：范式统一后不再弹确认框，立即执行并挂撤销条（tests/ui-interaction.test.js 同约定） */
  writes.length = 0;
  shopping.data.completedCount = 0;
  shopping.clearDone.call(shopping);
  assert.strictEqual(writes.length, 0, '没有已买条目时不应触发删除');

  writes.length = 0;
  shopping.data.completedCount = 1;
  shopping.clearDone.call(shopping);
  assert.deepStrictEqual(writes, [['remove', 'shopping', 's2']], '清空已买立即执行，只删除已完成条目');
  assert.strictEqual(shopping.data.undoShow, true, '删除后应浮出撤销条');
  clearTimeout(shopping.__undoTimer);

  /* 撤销：恢复被清空的已完成条目 */
  writes.length = 0;
  shopping.onUndoTap.call(shopping);
  assert.deepStrictEqual(writes, [['upsert', 'shopping', { name: '面包', price: 8.5, done: true }, 's2']], '撤销应恢复原记录与原 id');
} finally {
  store.state.records = originalState;
  sync.upsert = originalUpsert;
  sync.remove = originalRemove;
  global.wx = originalWx;
}

console.log('PAGE_BEHAVIOR_TEST_PASSED');
