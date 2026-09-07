const assert = require('assert');
const { searchAll } = require('../miniprogram/utils/search-utils');
const { buildWeeklyReview } = require('../miniprogram/utils/review-utils');

const source = {
  memories: [
    { id: 'memory-1', data: { content: '今天喝了手冲咖啡', occurredAt: '2026-09-03T08:00', mood: 'happy', tags: ['咖啡'] } },
    { id: 'memory-2', data: { content: '完成周复盘', occurredAt: '2026-09-04T20:00', mood: 'calm', tags: ['复盘'] } }
  ],
  media: [{ id: 'media-1', data: { kind: 'book', title: '咖啡学', status: 'doing', rating: 0, date: '2026-09-02' } }],
  shopping: [{ id: 'shop-1', data: { name: '咖啡滤纸', note: '', done: false } }],
  plan: [{ id: 'plan-1', data: { title: '周三运动', date: '2026-09-03', done: true } }, { id: 'plan-next', data: { title: '下周预约牙医', date: '2026-09-09', done: false } }],
  habit: [
    { id: 'habit-1', data: { kind: 'def', name: '阅读', mode: 'check', target: 1 } },
    { id: 'habit-entry-1', data: { kind: 'entry', habitId: 'habit-1', date: '2026-09-03', value: 1 } }
  ],
  money: [{ id: 'money-1', data: { type: 'expense', amount: 32, category: '餐饮', date: '2026-09-03', note: '咖啡' } }],
  fitness: [{ id: 'weight-1', data: { kind: 'weight', date: '2026-09-02', weight: 70 } }, { id: 'weight-2', data: { kind: 'weight', date: '2026-09-04', weight: 69.8 } }]
};

const results = searchAll(source, { keyword: '咖啡' });
assert.deepStrictEqual(results.map((item) => item.kind), ['memory', 'media', 'shopping', 'money']);
assert.deepStrictEqual(searchAll(source, { keyword: '咖啡', kind: 'memory' }).map((item) => item.id), ['memory-1']);

const review = buildWeeklyReview(source, '2026-09-01');
assert.deepStrictEqual(review.period, { start: '2026-09-01', end: '2026-09-07' });
assert.deepStrictEqual(review.finance, { income: 0, expense: 32, balance: -32 });
assert.deepStrictEqual(review.memories, { count: 2, days: 2, topTags: [{ tag: '咖啡', count: 1 }, { tag: '复盘', count: 1 }], moods: [{ mood: 'happy', count: 1 }, { mood: 'calm', count: 1 }] });
assert.strictEqual(review.plan.done, 1);
assert.strictEqual(review.habit.rate, 14.3);
assert.strictEqual(review.weight.change, -0.2);
assert.deepStrictEqual(review.nextPlans.map((item) => item.title), ['下周预约牙医']);

console.log('SEARCH_REVIEW_UTILS_TEST_PASSED');
