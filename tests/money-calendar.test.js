/*
 * 记账月历 —— 月历网格边界（周一首、月末、闰月）、日汇总与月汇总口径一致、点天过滤。
 * 运行：node tests/money-calendar.test.js
 */
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');

const mem = {};
global.wx = {
  getStorageSync: (k) => (k in mem ? mem[k] : ''),
  setStorageSync: (k, v) => { mem[k] = v; },
  removeStorageSync: (k) => { delete mem[k]; },
  onNetworkStatusChange() {},
  connectSocket: () => ({ onOpen() {}, onMessage() {}, onClose() {}, onError() {}, close() {}, send() {} }),
  showToast: () => {},
  vibrateShort: () => {},
  setNavigationBarColor: () => {},
  setBackgroundColor: () => {}
};

const store = require(path.join(root, 'miniprogram', 'utils', 'store'));
const sync = require(path.join(root, 'miniprogram', 'utils', 'sync'));
const api = require(path.join(root, 'miniprogram', 'utils', 'api'));
api.apiPut = () => Promise.resolve({ applied: true });

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
  store.loadLocal();
  for (const coll of store.COLLECTIONS) store.state.records[coll] = {};
  store.applyLocalUpsert('money', { id: 'a', data: { type: 'expense', amount: 100, category: '餐饮', date: '2026-02-01' }, updatedAt: 1, deletedAt: 0 });
  store.applyLocalUpsert('money', { id: 'b', data: { type: 'expense', amount: 23.5, category: '交通', date: '2026-02-01' }, updatedAt: 2, deletedAt: 0 });
  store.applyLocalUpsert('money', { id: 'c', data: { type: 'expense', amount: 50, category: '餐饮', date: '2026-02-28' }, updatedAt: 3, deletedAt: 0 });
  store.applyLocalUpsert('money', { id: 'd', data: { type: 'expense', amount: 10, category: '餐饮', date: '2026-03-01' }, updatedAt: 4, deletedAt: 0 });

  const money = makePage(loadPage('miniprogram/pages/money/money.js'));
  money.setData({ month: '2026-02', viewMode: 'calendar' });
  money.render.call(money);

  /* 1. 2026-02-01 是周日 → 月历第一行前面补 6 个空位（周一起始） */
  const weeks = money.data.calendarWeeks;
  assert.ok(weeks.length >= 4, '2 月至少 4 周');
  const firstWeek = weeks[0].days;
  assert.strictEqual(firstWeek[0].empty, true, '2026-02-01 为周日，周一至周六必须补空位');
  assert.strictEqual(firstWeek[6].date, '2026-02-01');
  /* 2. 闰年 2 月有 29 天，最后一天必须在网格里 */
  const flat = weeks.flatMap((week) => week.days).filter((cell) => !cell.empty);
  assert.strictEqual(flat[flat.length - 1].date, '2026-02-28', '2026 不是闰年，2 月最后一天是 28 日');
  /* 3. 日汇总与列表日小计同口径 */
  const day1 = flat.find((cell) => cell.date === '2026-02-01');
  assert.strictEqual(day1.out, 123.5, '1 日支出合计 100 + 23.5');
  assert.strictEqual(day1.outText, '123.5', '金额口径必须走 formatMoney');
  /* 4. 今天标记 */
  const today = sync.fmtDate(new Date());
  if (today.startsWith('2026-02')) {
    assert.ok(flat.find((cell) => cell.date === today).isToday, '今天必须标记 isToday');
  }

  /* 5. 点某天：切回列表并过滤到当天；再点取消 */
  money.setData({ viewMode: 'calendar', dayFilter: '' });
  money.tapCalendarDay.call(money, { currentTarget: { dataset: { date: '2026-02-01' } } });
  assert.strictEqual(money.data.viewMode, 'list');
  assert.strictEqual(money.data.dayFilter, '2026-02-01');
  assert.deepStrictEqual(money.data.groups.map((group) => group.date), ['2026-02-01'], '列表必须只显示当天');
  money.tapCalendarDay.call(money, { currentTarget: { dataset: { date: '2026-02-01' } } });
  assert.strictEqual(money.data.dayFilter, '', '再点同一天取消过滤');
  money.clearDayFilter.call(money);
  assert.strictEqual(money.data.dayFilter, '');

  /* 6. 切月必须清除日过滤（否则新月份会显示空列表） */
  money.setData({ dayFilter: '2026-02-01' });
  money.shiftMonth.call(money, 1);
  assert.strictEqual(money.data.month, '2026-03');
  assert.strictEqual(money.data.dayFilter, '', '切月必须清除日过滤');

  console.log('MONEY_CALENDAR_TEST_PASSED');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
