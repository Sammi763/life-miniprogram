/*
 * 跨模块预算建议 —— 待买预估价 + 本月支出 超过预算时提示；纯只读，绝不改状态。
 * 运行：node tests/budget-advice.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { buildBudgetAdvice } = require(path.join(root, 'miniprogram', 'utils', 'ledger-utils'));

function record(type, amount, date, done) {
  return { data: { type, amount, category: 'x', date, ...(done === undefined ? {} : { done }) }, updatedAt: 1, deletedAt: 0 };
}

(async () => {
  const settings = { data: { budget: 3000 } };
  const money = [
    record('expense', 2000, '2026-09-05'),
    record('expense', 500, '2026-08-20'),   // 上月不计
    record('expense', 500, '2026-09-20'),
    record('income', 9000, '2026-09-06')    // 收入不冲减预算口径
  ];
  const shopping = [
    { data: { name: '咖啡豆', price: 800, done: false }, updatedAt: 1, deletedAt: 0 },
    { data: { name: '已买', price: 999, done: true }, updatedAt: 2, deletedAt: 0 },   // 已买不计
    { data: { name: '无价', done: false }, updatedAt: 3, deletedAt: 0 }               // 无预估价不计
  ];

  const advice = buildBudgetAdvice(settings, money, shopping, '2026-09');
  assert.ok(advice, '2500 支出 + 800 待买 > 3000 预算必须触发');
  assert.strictEqual(advice.monthOut, 2500);
  assert.strictEqual(advice.pendingEstimate, 800);
  assert.strictEqual(advice.budget, 3000);
  assert.strictEqual(advice.over, 300);

  /* 未超、无预算、恰好持平都不触发 */
  assert.strictEqual(buildBudgetAdvice(settings, [record('expense', 100, '2026-09-01')], shopping, '2026-09'), null, '未超预算不触发');
  assert.strictEqual(buildBudgetAdvice({ data: {} }, money, shopping, '2026-09'), null, '未设置预算不触发');
  assert.strictEqual(buildBudgetAdvice({ data: { budget: 3300 } }, money, shopping, '2026-09'), null, '恰好持平不触发');
  assert.strictEqual(buildBudgetAdvice(null, money, shopping, '2026-09'), null, '设置记录缺失不触发');

  /* 页面接线：建议卡只读 + 直达「我的」，wxml 不得出现自动修改预算/待买的行为 */
  const todayWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/today/today.wxml'), 'utf8');
  assert.match(todayWxml, /budgetAdvice/, 'today 页必须渲染预算建议卡');
  assert.match(todayWxml, /bindtap="goMine"/, '建议卡必须可跳转「我的」查看预算');
  const todayJs = fs.readFileSync(path.join(root, 'miniprogram/pages/today/today.js'), 'utf8');
  assert.ok(/buildBudgetAdvice/.test(todayJs), 'today 页必须调用 buildBudgetAdvice');
  const ledgerUtils = fs.readFileSync(path.join(root, 'miniprogram/utils/ledger-utils.js'), 'utf8');
  const adviceBlock = ledgerUtils.slice(ledgerUtils.indexOf('function buildBudgetAdvice'), ledgerUtils.indexOf('module.exports'));
  assert.ok(!/upsert|enqueue|applyLocal/.test(adviceBlock), '建议计算必须是纯函数，不得写任何记录');

  console.log('BUDGET_ADVICE_TEST_PASSED');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
