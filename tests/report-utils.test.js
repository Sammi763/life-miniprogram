const assert = require('assert');
const { buildMonthlyReport } = require('../miniprogram/utils/report-utils');

const source = {
  money: [
    { date: '2026-08-03', type: 'income', amount: 200 },
    { date: '2026-08-05', type: 'expense', category: '餐饮', amount: 80 },
    { date: '2026-09-01', type: 'income', amount: 1000, category: '工资' },
    { date: '2026-09-02', type: 'expense', category: '餐饮', amount: 100 },
    { date: '2026-09-02', type: 'expense', category: '交通', amount: 60 },
    { date: '2026-09-03', type: 'expense', category: '餐饮', amount: 40 },
    { date: '2026-09-03', type: 'transfer', category: '账户转账', amount: 300 }
  ],
  habit: [
    { id: 'water', kind: 'def', name: '喝水', mode: 'count', target: 8 },
    { id: 'read', kind: 'def', name: '阅读', mode: 'check', target: 1 },
    { kind: 'entry', habitId: 'water', date: '2026-09-01', value: 8 },
    { kind: 'entry', habitId: 'read', date: '2026-09-01', value: 1 },
    { kind: 'entry', habitId: 'water', date: '2026-09-02', value: 7 }
  ],
  plan: [
    { id: 'one', title: '一次性日程', date: '2026-09-01', done: true },
    { id: 'series', kind: 'series', title: '每日计划', startDate: '2026-09-01', repeat: 'daily', endDate: '2026-09-03' },
    { kind: 'occurrence', seriesId: 'series', date: '2026-09-01', done: true },
    { kind: 'occurrence', seriesId: 'series', date: '2026-09-02', skipped: true }
  ],
  fitness: [
    { kind: 'weight', date: '2026-09-01', weight: 72.4 },
    { kind: 'weight', date: '2026-09-30', weight: 71.8 }
  ],
  media: [
    { kind: 'book', title: '一本书', status: 'done', rating: 5, date: '2026-09-10' },
    { kind: 'movie', title: '一部电影', status: 'done', rating: 3, date: '2026-09-18' },
    { kind: 'music', title: '未完成', status: 'doing', rating: 4, date: '2026-09-20' }
  ],
  settings: [{ id: 'app', budget: 300, categoryBudgets: { 餐饮: 120, 交通: 80 } }],
  memories: [
    { id: 'memory-1', content: '晨间散步', occurredAt: '2026-09-02T08:00', mood: 'happy', tags: ['日常', '散步'] },
    { id: 'memory-2', content: '整理账本', occurredAt: '2026-09-03T20:00', mood: 'calm', tags: ['财务', '日常'] }
  ]
};

const report = buildMonthlyReport(source, '2026-09');
assert.deepStrictEqual(report.finance, {
  income: 1000,
  expense: 200,
  balance: 800,
  budget: 300,
  budgetUsed: 66.7,
  incomeChange: 800,
  expenseChange: 120,
  categoryBudgets: [
    { category: '餐饮', budget: 120, spent: 140, remaining: 0, used: 116.7, over: 20, suggested: 200 },
    { category: '交通', budget: 80, spent: 60, remaining: 20, used: 75, over: 0, suggested: 100 }
  ],
  overspent: [{ category: '餐饮', budget: 120, spent: 140, remaining: 0, used: 116.7, over: 20, suggested: 200 }],
  topCategories: [{ category: '餐饮', amount: 140 }, { category: '交通', amount: 60 }],
  dailyTrend: [{ date: '2026-09-02', amount: 160 }, { date: '2026-09-03', amount: 40 }]
}, '财务统计、预算、环比与趋势必须完全在本地确定性计算');
assert.strictEqual(report.life.plan.total, 3, '跳过的重复日程不进入完成率分母');
assert.strictEqual(report.life.plan.done, 2, '一次性和单日覆盖完成均应计入');
assert.strictEqual(report.life.plan.rate, 66.7);
assert.strictEqual(report.life.weight.change, -0.6, '体重变化应以月内首末记录计算');
assert.deepStrictEqual(report.life.media, { completed: 2, averageRating: 4 }, '仅完成书影音参与月报');
assert.deepStrictEqual(report.life.memory, {
  count: 2,
  days: 2,
  topTags: [{ tag: '日常', count: 2 }, { tag: '散步', count: 1 }, { tag: '财务', count: 1 }],
  moods: [{ mood: 'happy', count: 1 }, { mood: 'calm', count: 1 }]
}, '随记月报必须仅在客户端基于同步文字计算');
assert.strictEqual(report.summary, buildMonthlyReport(source, '2026-09').summary, '月度文字总结必须确定性、不可调用 AI');
assert.ok(report.summary.includes('¥800'), '总结应包含财务结余');

console.log('REPORT_UTILS_TEST_PASSED');
