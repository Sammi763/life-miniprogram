/*
 * 找回与复盘闭环回归（U07/U13）。
 * 锁住：搜索第 101 条及更早结果可继续加载；习惯/体重记录纳入检索且范围有说明；
 *       复盘「下周一个调整」显式转为日程/习惯；待买完成记账经 shoppingId 来源关联去重。
 */
const assert = require('assert');
const path = require('path');

const storage = {};
const originalWx = global.wx;
const toasts = [];
const nav = [];
global.wx = {
  getStorageSync: (key) => storage[key],
  setStorageSync: (key, value) => { storage[key] = value; },
  removeStorageSync: (key) => { delete storage[key]; },
  getStorageInfoSync: () => ({ keys: Object.keys(storage) }),
  showToast: (options) => toasts.push(options.title),
  navigateTo: (options) => nav.push(['navigateTo', options.url]),
  switchTab: (options) => nav.push(['switchTab', options.url]),
  vibrateShort: () => {}
};

const store = require('../miniprogram/utils/store');
const sync = require('../miniprogram/utils/sync');
const { searchAll } = require('../miniprogram/utils/search-utils');
const { validateRecordData } = require('../miniprogram/utils/record-validation');

function loadPage(name) {
  const target = path.resolve(__dirname, '../miniprogram/pages/' + name + '/' + name + '.js');
  const originalPage = global.Page;
  let definition;
  global.Page = (page) => { definition = page; };
  delete require.cache[require.resolve(target)];
  require(target);
  global.Page = originalPage;
  return definition;
}
function assignPath(target, key, value) {
  const keys = key.split('.');
  let cur = target;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}
function makePage(definition) {
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) { for (const key of Object.keys(update)) assignPath(this.data, key, update[key]); }
  };
}
const record = (id, data, updatedAt) => ({ id, data, updatedAt: updatedAt || 1, deletedAt: 0 });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const originalUpsert = sync.upsert;
  const writes = [];
  // 本地应用间谍：既记录写入供断言，也真实落到 store（记账去重逻辑读 store.state.records.money）。
  // 不走真实 sync.upsert —— 那会入队并触发 flush 的无限重试定时器，进程永不退出。
  sync.upsert = (collection, data, id, options) => {
    const rid = id || 'spy-' + writes.length;
    const updatedAt = options && Number(options.updatedAt) > 0 ? Number(options.updatedAt) : Date.now();
    store.applyLocalUpsert(collection, { id: rid, data, updatedAt });
    writes.push([collection, data, rid, options]);
    return rid;
  };

  try {
    /* ---------- U07 · 搜索第 101 条及更早结果可继续加载 ---------- */
    for (const key of Object.keys(storage)) delete storage[key];
    store.resetLocal({ keepAuxiliary: true });
    const memories = {};
    for (let i = 0; i < 150; i++) memories['m' + i] = record('m' + i, { content: '重复关键词第' + i + '条', occurredAt: '2026-09-20T09:00' }, 10000 - i);
    store.state.records.memories = memories;
    const search = makePage(loadPage('search'));
    search.data.keyword = '重复关键词';
    search.visibleResults = 100;
    search.render.call(search);
    assert.strictEqual(search.data.results.length, 100, '首批最多下发 100 条');
    assert.strictEqual(search.data.resultTotal, 150, '总数如实上报');
    assert.strictEqual(search.data.resultsTruncated, true, '截断状态可见');
    search.loadMoreResults.call(search);
    assert.strictEqual(search.data.results.length, 150, '「加载更多」后第 101 条及更早结果全部可及');
    assert.strictEqual(search.data.results[100].id, 'm100', '第 101 条是按更新时间排序的下一批');
    // 深链进入详情再返回：页面实例保留，关键词与已加载结果不丢（筛选/滚动位置由框架保留，数据层不得清空）
    search.openResult.call(search, { currentTarget: { dataset: { kind: 'memory', id: 'm100' } } });
    search.render.call(search);
    assert.strictEqual(search.data.results.length, 150, '返回后重渲染必须保留已加载结果');
    assert.strictEqual(search.data.keyword, '重复关键词', '返回后关键词保留');

    /* ---------- U07 · 范围补全：习惯打卡与体重纳入检索 ---------- */
    store.state.records.habit = {
      d1: record('d1', { kind: 'def', name: '喝水', mode: 'count', target: 8 }, 1),
      e1: record('e1', { kind: 'entry', habitId: 'd1', date: '2026-09-20', value: 5 }, 2)
    };
    store.state.records.fitness = {
      w1: record('w1', { kind: 'weight', date: '2026-09-20', weight: 72.3, bodyfat: 20 }, 3),
      g1: record('g1', { kind: 'deficit', date: '2026-09-20', intake: 1800, burned: 300 }, 4)
    };
    const source = {};
    for (const collection of ['memories', 'plan', 'shopping', 'media', 'money', 'habit', 'fitness']) {
      source[collection] = Object.values(store.state.records[collection] || {}).filter((item) => !item.deletedAt && item.data);
    }
    const habitHits = searchAll(source, { keyword: '喝水' });
    assert.ok(habitHits.some((item) => item.kind === 'habit' && item.id === 'e1' && /喝水/.test(item.title)), '习惯打卡必须可按习惯名检索');
    const weightHits = searchAll(source, { keyword: '72.3' });
    assert.ok(weightHits.some((item) => item.kind === 'fitness' && item.id === 'w1'), '体重记录必须可按数值检索');
    const scoped = searchAll(source, { keyword: '喝水', kind: 'habit' });
    assert.ok(scoped.length === 1 && scoped[0].kind === 'habit', '按「习惯」范围过滤只返回习惯记录');
    const wxml = require('fs').readFileSync(path.resolve(__dirname, '../miniprogram/pages/search/search.wxml'), 'utf8');
    assert.match(wxml, /习惯打卡/, '搜索范围说明必须包含习惯打卡');
    assert.match(wxml, /体重/, '搜索范围说明必须包含体重');

    /* ---------- U07 · 深链：habit 经 pending-open，fitness 直达编辑 ---------- */
    const habitPage = makePage(loadPage('habit'));
    habitPage.consumePendingOpen.call(habitPage);
    storage['wb_life_pending_open'] = { kind: 'habit', id: 'e1', action: '', at: Date.now() };
    habitPage.consumePendingOpen.call(habitPage);
    assert.strictEqual(habitPage.data.historyShow, 'd1', '习惯深链必须展开对应习惯的历史视图');
    assert.strictEqual(storage['wb_life_pending_open'], undefined, '深链意图消费后清除（一次性）');

    const fitnessPage = makePage(loadPage('fitness'));
    fitnessPage.onLoad.call(fitnessPage, { id: 'w1' });
    assert.strictEqual(fitnessPage.data.weightSheet, true, '体重深链必须打开编辑弹层');
    assert.strictEqual(fitnessPage.data.weightForm.id, 'w1', '体重深链定位到正确记录');

    /* ---------- U13 · 复盘「下周一个调整」显式转日程/习惯 ---------- */
    for (const key of Object.keys(storage)) delete storage[key];
    store.resetLocal({ keepAuxiliary: true });
    writes.length = 0;
    const review = makePage(loadPage('review'));
    review.onAdjustInput.call(review, { detail: { value: '周三交周报' } });
    review.adjustToPlan.call(review);
    assert.strictEqual(writes.length, 1, '转日程必须产生一次显式写入');
    const planWrite = writes.pop();
    assert.strictEqual(planWrite[0], 'plan');
    assert.deepStrictEqual(planWrite[1], { title: '周三交周报', date: planWrite[1].date, time: '', done: false }, '转出的日程落在下周一、未完成');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(planWrite[1].date), '日程日期合法');
    assert.strictEqual(review.data.adjustText, '周三交周报', '转换后保留复盘内容');

    review.onAdjustInput.call(review, { detail: { value: '睡前拉伸' } });
    review.adjustToHabit.call(review);
    const habitWrite = writes.pop();
    assert.strictEqual(habitWrite[0], 'habit');
    assert.deepStrictEqual(habitWrite[1], { kind: 'def', name: '睡前拉伸', mode: 'check', target: 1, unit: '' }, '转出的习惯是每日勾选');
    // 超长输入被拒绝，不静默截断
    toasts.length = 0;
    review.onAdjustInput.call(review, { detail: { value: '这个调整的名字实在长得离谱超过十二个字' } });
    review.adjustToHabit.call(review);
    assert.ok(toasts.some((text) => /最多 12 个字/.test(text)), '超长习惯名必须拒绝并提示');

    /* ---------- U13 · 待买完成记账：shoppingId 来源关联去重 ---------- */
    store.state.records.shopping = { s1: record('s1', { name: '咖啡豆 250g', price: 58, done: false }, 1) };
    store.state.records.money = {};
    const shopping = makePage(loadPage('shopping'));
    shopping.toggle.call(shopping, { currentTarget: { dataset: { id: 's1' } } });
    assert.strictEqual(store.state.records.shopping.s1.data.done, true, '完成待买立即生效');
    assert.strictEqual(shopping.data.ledgerSheetShow, true, '完成后打开可选记账弹层');
    assert.strictEqual(shopping.data.ledgerForm.amount, '58', '金额用预估价预填');
    shopping.onLedgerAmount.call(shopping, { detail: { value: '62' } });
    shopping.onLedgerCategory.call(shopping, { currentTarget: { dataset: { cat: '居家用品' } } });
    shopping.confirmLedger.call(shopping);
    const ledgerWrite = writes.find((w) => w[0] === 'money');
    assert.ok(ledgerWrite, '确认记账必须产生一次账目写入');
    assert.strictEqual(ledgerWrite[0], 'money');
    assert.strictEqual(ledgerWrite[1].shoppingId, 's1', '账目必须带来源关联');
    assert.strictEqual(ledgerWrite[1].amount, 62, '记账金额为用户确认的实际金额');
    assert.ok(validateRecordData('money', ledgerWrite[1]) === '', '关联账目必须通过字段校验');
    assert.strictEqual(ledgerWrite[2], 's1', '多台设备为同一待买项补记时使用同一流水 ID');
    assert.strictEqual(ledgerWrite[3].createOnly, true, '另一台设备的补记不能覆盖先前的流水');
    const money = makePage(loadPage('money'));
    const itemEvent = { currentTarget: { dataset: { id: 's1' } } };
    shopping.onLedgerAction(itemEvent);
    assert.deepStrictEqual(nav.pop(), ['switchTab', '/pages/money/money']);
    money.consumePendingOpen();
    money.onNote({ detail: { value: '修改备注' } });
    money.save();
    assert.strictEqual(store.state.records.money.s1.data.shoppingId, 's1', '编辑流水保留来源关联');
    await wait(410);
    shopping.toggle(itemEvent);
    assert.strictEqual(store.state.records.shopping.s1.data.done, false);
    await wait(410);
    shopping.toggle(itemEvent);
    assert.strictEqual(store.state.records.shopping.s1.data.done, true);
    assert.strictEqual(shopping.data.ledgerSheetShow, false, '取消后再次完成也不弹重复记账');
    assert.strictEqual(Object.keys(store.state.records.money).length, 1);

    shopping.buyAgain(itemEvent);
    const purchase = writes.at(-1);
    assert.strictEqual(purchase[0], 'shopping');
    assert.notStrictEqual(purchase[2], 's1');
    assert.deepStrictEqual(purchase[1], { name: '咖啡豆 250g', note: '', price: 58, link: '', done: false });
    assert.strictEqual(store.state.records.money.s1.data.amount, 62);
    const repeatEvent = { currentTarget: { dataset: { id: purchase[2] } } };
    const today = makePage(loadPage('today'));
    today.completeQueueItem({ kind: 'shopping', sourceId: purchase[2] });
    shopping.onLedgerAction(repeatEvent);
    assert.strictEqual(shopping.data.ledgerSheetShow, true, '在今日页标记买到后仍能补记花费');
    assert.strictEqual(shopping.data.ledgerForm.id, purchase[2]);
    console.log('find-review-loop.test.js 通过');
  } finally {
    sync.upsert = originalUpsert;
    if (originalWx) global.wx = originalWx;
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
