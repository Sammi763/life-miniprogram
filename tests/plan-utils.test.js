const assert = require('assert');
const {
  derivePlanOccurrences,
  getWeekDates,
  makeOccurrenceId,
  summarizeOccurrences
} = require('../miniprogram/utils/plan-utils');

const records = [
  { id: 'legacy', data: { title: '旧版一次性事项', date: '2026-09-08', time: '09:00', done: false } },
  { id: 'daily', data: { kind: 'series', title: '每日阅读', startDate: '2026-09-07', time: '07:00', repeat: 'daily' } },
  { id: 'weekly', data: { kind: 'series', title: '每周复盘', startDate: '2026-09-08', time: '20:00', repeat: 'weekly' } },
  { id: 'ended', data: { kind: 'series', title: '已停止的习惯', startDate: '2026-09-07', repeat: 'daily', endDate: '2026-09-08' } },
  { id: makeOccurrenceId('daily', '2026-09-09'), data: { kind: 'occurrence', seriesId: 'daily', date: '2026-09-09', done: true } },
  { id: makeOccurrenceId('daily', '2026-09-10'), data: { kind: 'occurrence', seriesId: 'daily', date: '2026-09-10', skipped: true } },
  { id: makeOccurrenceId('ended', '2026-09-08'), data: { kind: 'occurrence', seriesId: 'ended', date: '2026-09-08', done: true } }
];

const week = getWeekDates('2026-09-09');
assert.deepStrictEqual(week, [
  '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'
], '周视图从周一开始并覆盖完整七天');

const occurrences = derivePlanOccurrences(records, week[0], week[6]);
const titleDates = occurrences.map((item) => item.title + '@' + item.date);
assert.ok(titleDates.includes('旧版一次性事项@2026-09-08'), '旧日程必须继续按一次性事项展示');
assert.strictEqual(occurrences.filter((item) => item.seriesId === 'daily').length, 7, '每日重复应跨周展开为七个虚拟事项');
assert.strictEqual(occurrences.filter((item) => item.seriesId === 'weekly').length, 1, '每周重复应锚定创建时的星期');
assert.strictEqual(occurrences.filter((item) => item.seriesId === 'ended').length, 2, '停止重复后只保留结束日前的历史事项');

const completed = occurrences.find((item) => item.seriesId === 'daily' && item.date === '2026-09-09');
const skipped = occurrences.find((item) => item.seriesId === 'daily' && item.date === '2026-09-10');
assert.strictEqual(completed.done, true, '单日完成状态应覆盖虚拟事项');
assert.strictEqual(skipped.skipped, true, '单日跳过状态应覆盖虚拟事项');
assert.strictEqual(occurrences.find((item) => item.seriesId === 'ended' && item.date === '2026-09-08').done, true, '停止后的历史完成状态不能丢失');

const summary = summarizeOccurrences(occurrences);
assert.strictEqual(summary.skipped, 1, '跳过事项需要单独计数');
assert.strictEqual(summary.done, 2, '完成率只计算非跳过事项的完成数');
assert.strictEqual(summary.total, occurrences.length - 1, '跳过事项不应拉低完成率分母');

console.log('PLAN_UTILS_TEST_PASSED');
