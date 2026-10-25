/*
 * v2.11 记账列表分批渲染：列表视图首批只下发 10 个日期分组，触底/「加载更多」
 * 每次追加 10 组；筛选、当天过滤、月份切换、视图切换时重置回首批；
 * 月汇总、分类 chips、月历与角标始终按全月计算（只裁剪 setData 的 groups 载荷）。
 *
 * 运行：node tests/money-batch.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sync = require(path.join(root, 'miniprogram', 'utils', 'sync'));
const store = require(path.join(root, 'miniprogram', 'utils', 'store'));

function loadPage(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const originalPage = global.Page;
  let definition = null;
  global.Page = (page) => { definition = page; };
  delete require.cache[require.resolve(absolutePath)];
  require(absolutePath);
  global.Page = originalPage;
  return definition;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function assignPath(target, key, value) {
  const parts = key.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function makePage(definition) {
  return {
    ...definition,
    data: clone(definition.data),
    setData(update, callback) {
      Object.keys(update).forEach((key) => assignPath(this.data, key, update[key]));
      if (callback) callback();
    }
  };
}

(async () => {
  const originalWx = global.wx;
  global.wx = {
    showToast: () => {}, showLoading: () => {}, hideLoading: () => {},
    vibrateShort: () => {}, setNavigationBarColor: () => {}, setBackgroundColor: () => {},
    getStorageSync: () => '', setStorageSync: () => {}, removeStorageSync: () => {},
    switchTab: () => {}, navigateTo: () => {}, onNetworkStatusChange() {},
    connectSocket: () => ({ onOpen() {}, onMessage() {}, onClose() {}, onError() {}, close() {}, send() {} })
  };

  try {
    store.loadLocal();
    for (const coll of store.COLLECTIONS) store.state.records[coll] = {};

    const today = sync.fmtDate(new Date());
    // 25 个不同日期、每天 1 笔支出 → 25 个日期分组，全部在本月
    for (let i = 0; i < 25; i++) {
      const date = new Date();
      date.setDate(1);
      date.setDate(Math.min(25, date.getDate() + i));
      const d = sync.fmtDate(date);
      if (d.slice(0, 7) !== today.slice(0, 7)) continue;
      store.applyLocalUpsert('money', { id: 'mb-' + i, data: { type: 'expense', amount: 10 + i, category: '餐饮', date: d, note: '第' + i + '天' }, updatedAt: 1000 + i, deletedAt: 0 });
    }
    const seeded = Object.values(store.state.records.money).filter((r) => !r.deletedAt && r.data.date.slice(0, 7) === today.slice(0, 7));
    assert.ok(seeded.length >= 24, '测试前置：本月应有多于一批的日期分组（实际 ' + seeded.length + '）');

    const money = makePage(loadPage('miniprogram/pages/money/money.js'));
    money.setData({ month: today.slice(0, 7) });
    money.render.call(money);

    const monthGroups = seeded.length;
    assert.strictEqual(money.data.groups.length, 10, '列表视图首批必须只下发 10 个日期分组');
    assert.strictEqual(money.data.hasMore, true, '还有更多分组时必须出现加载更多');
    assert.strictEqual(money.data.groupTotal, monthGroups, 'groupTotal 必须是全月完整分组数');

    // 汇总与分类 chips 仍按全月计算
    const fullOut = seeded.reduce((sum, r) => sum + Number(r.data.amount), 0);
    assert.strictEqual(money.data.sumOut, fullOut, '月支出汇总必须按全月计算，不随分批裁剪');
    assert.ok(money.data.filters.length >= 1, '分类 chips 必须按全月计算');

    // 追加：触底加载，每次 +10 组，直到取完
    money.onReachBottom.call(money);
    assert.strictEqual(money.data.groups.length, Math.min(20, monthGroups), '触底一次必须追加到 20 组');
    assert.strictEqual(money.data.hasMore, monthGroups > 20, 'hasMore 必须如实反映剩余分组');
    money.onReachBottom.call(money);
    assert.strictEqual(money.data.groups.length, monthGroups, '再次触底必须取完全部分组');
    assert.strictEqual(money.data.hasMore, false, '取完后不得再出现加载更多');
    assert.strictEqual(money.data.sumOut, fullOut, '多次分批后月支出汇总必须仍是全月口径');

    // 月份切换重置回首批
    money.shiftMonth(1);
    assert.strictEqual(money.data.groups.length, 0, '空月份下只应看到 0 组');
    money.shiftMonth(-1);
    assert.strictEqual(money.data.groups.length, 10, '切回本月必须重置回首批 10 组');
    assert.strictEqual(money.data.hasMore, true, '切月重置后必须重新出现加载更多');

    // 分类筛选重置回首批（本例只有餐饮一类，筛选后仍是全月分组，但 visibleGroups 必须重置）
    money.onReachBottom.call(money); // 先翻到 20 组
    money.setFilter.call(money, { currentTarget: { dataset: { cat: '餐饮' } } });
    assert.ok(money.data.groups.length <= 10, '分类筛选必须重置回首批');

    // 当天过滤（月历点某天）重置且不误裁
    money.tapCalendarDay.call(money, { currentTarget: { dataset: { date: seeded[0].data.date } } });
    assert.strictEqual(money.data.dayFilter, seeded[0].data.date, '点月历某天必须进入当天过滤');
    assert.strictEqual(money.data.groups.length, 1, '当天过滤只应看到 1 组');
    assert.strictEqual(money.data.hasMore, false, '当天过滤不得出现加载更多');
    money.clearDayFilter.call(money);
    assert.strictEqual(money.data.groups.length, 10, '清除当天过滤必须重置回首批');

    // 视图切换重置：月历不受分批影响
    money.onReachBottom.call(money);
    money.setViewMode.call(money, { currentTarget: { dataset: { mode: 'calendar' } } });
    assert.strictEqual(money.data.viewMode, 'calendar', '必须切到月历视图');
    const calendarDays = (money.data.calendarWeeks || []).reduce((sum, week) => sum + week.days.filter((cell) => cell.hasOut).length, 0);
    assert.strictEqual(calendarDays, seeded.length, '月历必须按全月分组渲染，不受列表分批影响');

    // wxml：加载更多入口 + 触底钩子
    const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/money/money.wxml'), 'utf8');
    assert.match(wxml, /bindtap="loadMore"/, 'money 列表必须提供加载更多按钮');
    const js = fs.readFileSync(path.join(root, 'miniprogram/pages/money/money.js'), 'utf8');
    assert.match(js, /onReachBottom/, 'money 必须支持触底加载');
  } finally {
    global.wx = { getStorageSync: () => '', setStorageSync: () => {}, removeStorageSync: () => {} };
  }

  console.log('MONEY_BATCH_TEST_PASSED');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
