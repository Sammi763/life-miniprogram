const assert = require('assert');
const { buildTodayQueue, chooseFocusTask } = require('../miniprogram/utils/daily-utils');

const source = {
  plan: [
    { id: 'plan-pinned', data: { title: '准备周会', date: '2026-09-04', done: false, pinned: true } },
    { id: 'plan-late', data: { title: '补缴水费', date: '2026-09-03', done: false } }
  ],
  habit: [
    { id: 'habit-read', data: { kind: 'def', name: '阅读 30 分钟', mode: 'check', target: 1, pinned: true } },
    { id: 'habit-entry', data: { kind: 'entry', habitId: 'habit-read', date: '2026-09-04', value: 0 } }
  ],
  shopping: [
    { id: 'shop', data: { name: '咖啡豆', done: false, pinned: false } }
  ]
};

const queue = buildTodayQueue(source, '2026-09-04');
assert.deepStrictEqual(queue.map((item) => [item.kind, item.id, item.pinned, item.overdue]), [
  ['plan', 'plan-pinned', true, false],
  ['habit', 'habit-read', true, false],
  ['plan', 'plan-late', false, true],
  ['shopping', 'shop', false, false]
]);
assert.strictEqual(chooseFocusTask(queue).id, 'plan-pinned');
assert.strictEqual(buildTodayQueue(source, '2026-09-04').filter((item) => item.done).length, 0);

console.log('DAILY_UTILS_TEST_PASSED');
