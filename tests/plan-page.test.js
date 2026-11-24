const assert = require('assert');
const path = require('path');
const store = require('../miniprogram/utils/store');
const sync = require('../miniprogram/utils/sync');
const { getWeekDates } = require('../miniprogram/utils/plan-utils');

function loadPage() {
  const target = path.resolve(__dirname, '../miniprogram/pages/plan/plan.js');
  let definition;
  const original = global.Page;
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

const originalPlans = store.state.records.plan;
const originalUpsert = sync.upsert;
const originalWx = global.wx;
try {
  const today = sync.fmtDate(new Date());
  const week = getWeekDates(today);
  store.state.records.plan = {
    legacy: { id: 'legacy', data: { title: '旧事项', date: today, time: '', done: false }, updatedAt: 1, deletedAt: 0 },
    series: { id: 'series', data: { kind: 'series', title: '每日事项', startDate: week[0], time: '08:00', repeat: 'daily' }, updatedAt: 2, deletedAt: 0 }
  };
  const writes = [];
  sync.upsert = (...args) => writes.push(args);
  global.wx = {
    showToast() {},
    showModal(options) { options.success({ confirm: true }); }
  };

  const page = makePage(loadPage());
  page.data.weekStart = week[0];
  page.data.selectedDate = today;
  page.render.call(page);
  assert.strictEqual(page.data.weekDays.length, 7, '周日历必须完整显示七天');
  assert.ok(page.data.items.some((item) => item.id === 'legacy'), '旧一次性事项必须继续显示');
  const virtual = page.data.items.find((item) => item.sourceId === 'series');
  assert.ok(virtual && virtual.isVirtual, '重复源必须在当天展示虚拟事项');

  page.toggle.call(page, { currentTarget: { dataset: { id: virtual.id } } });
  assert.deepStrictEqual(writes.pop(), ['plan', {
    kind: 'occurrence', seriesId: 'series', date: today, done: true, skipped: false
  }, 'o_series_' + today.replace(/-/g, '')], '完成重复事项只能写单日覆盖记录');

  page.stopSeries.call(page, 'series');
  assert.deepStrictEqual(writes.pop(), ['plan', {
    kind: 'series', title: '每日事项', startDate: week[0], time: '08:00', repeat: 'daily', endDate: today
  }, 'series'], '停止重复必须保留原记录并设置截止日期');

  /* 每月重复的日期选择：picker 的 detail.value 是 0 起下标，必须 +1 落库（此前选 15 号存成 14、31 号存成 30） */
  page.data.form = { ...page.data.form, repeat: 'monthly', repeatDay: '1' };
  page.onRepeatDay.call(page, { detail: { value: '0' } });
  assert.strictEqual(page.data.form.repeatDay, '1', '选择 1 号（下标 0）必须保存 1');
  page.onRepeatDay.call(page, { detail: { value: '14' } });
  assert.strictEqual(page.data.form.repeatDay, '15', '选择 15 号（下标 14）必须保存 15');
  page.onRepeatDay.call(page, { detail: { value: '30' } });
  assert.strictEqual(page.data.form.repeatDay, '31', '选择 31 号（下标 30）必须保存 31');

  /* v2.11 最近记录深链守卫：openEditById 收到 occurrence id 时必须解析到重复源系列；
     系列已不存在的孤儿 occurrence 只定位日期。绝不能把单日覆盖记录当一次性日程打开编辑——
     保存会把 occurrence 覆写为 one-off 形状，破坏系列的完成/跳过语义 */
  const occurrenceId = 'o_series_' + today.replace(/-/g, '');
  store.state.records.plan[occurrenceId] = { id: occurrenceId, data: { kind: 'occurrence', seriesId: 'series', date: today, done: true, skipped: false }, updatedAt: 3, deletedAt: 0 };
  page.data.sheetShow = false;
  page.openEditById.call(page, occurrenceId);
  assert.strictEqual(page.data.form.id, occurrenceId, '单日深链打开该次日程');
  assert.strictEqual(page.data.form.sourceKind, 'occurrence', '单日表单保留重复日程覆盖形态');
  assert.strictEqual(page.data.sheetShow, true, '系列仍存在时必须打开编辑弹层');

  const orphanId = 'o_gone_' + today.replace(/-/g, '');
  store.state.records.plan[orphanId] = { id: orphanId, data: { kind: 'occurrence', seriesId: 'gone', date: today, done: false, skipped: true }, updatedAt: 4, deletedAt: 0 };
  page.data.sheetShow = false;
  page.data.form = { ...page.data.form, id: '' };
  page.openEditById.call(page, orphanId);
  assert.strictEqual(page.data.sheetShow, false, '孤儿 occurrence 不得打开编辑弹层');
  assert.strictEqual(page.data.selectedDate, today, '孤儿 occurrence 仍应定位到对应日期');

  console.log('PLAN_PAGE_TEST_PASSED');
} finally {
  store.state.records.plan = originalPlans;
  sync.upsert = originalUpsert;
  global.wx = originalWx;
}
