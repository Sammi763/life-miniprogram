const assert = require('assert');
const { validateRecordData } = require('../server/validation');
const {
  calculateAccountBalances,
  buildBillAlerts,
  buildCategoryBudgetProgress,
  summarizeMoney
} = require('../miniprogram/utils/ledger-utils');

const accounts = {
  checking: { id: 'checking', data: { kind: 'asset', name: '招商银行卡', category: '银行卡', openingBalance: 1000, manualAdjustment: 50 } },
  wallet: { id: 'wallet', data: { kind: 'asset', name: '微信余额', category: '支付余额', openingBalance: 50 } },
  credit: { id: 'credit', data: { kind: 'liability', name: '信用卡', category: '信用卡', openingBalance: 300, currentBill: 888, minimumPayment: 100, statementDay: 2, dueDay: 8 } },
  legacy: { id: 'legacy', data: { kind: 'asset', name: '旧账户', category: '银行卡', balance: 20 } }
};
const money = {
  income: { id: 'income', data: { type: 'income', amount: 500, category: '工资', date: '2026-09-01', accountId: 'checking' } },
  lunch: { id: 'lunch', data: { type: 'expense', amount: 120, category: '餐饮', date: '2026-09-02', accountId: 'checking' } },
  cardExpense: { id: 'card-expense', data: { type: 'expense', amount: 80, category: '餐饮', date: '2026-09-02', accountId: 'credit' } },
  topup: { id: 'topup', data: { type: 'transfer', amount: 100, category: '账户转账', date: '2026-09-03', accountId: 'checking', toAccountId: 'wallet' } },
  repay: { id: 'repay', data: { type: 'transfer', amount: 50, category: '账户转账', date: '2026-09-03', accountId: 'wallet', toAccountId: 'credit' } }
};

const balances = calculateAccountBalances(accounts, money);
assert.strictEqual(balances.byId.checking.balance, 1330);
assert.strictEqual(balances.byId.wallet.balance, 100);
assert.strictEqual(balances.byId.credit.balance, 330);
assert.strictEqual(balances.byId.legacy.balance, 20, '旧的手工余额账户必须继续可用');
assert.deepStrictEqual(balances.overview, {
  assetTotal: 1450,
  liabilityTotal: 330,
  netAssets: 1120,
  assetCount: 3,
  liabilityCount: 1,
  accountCount: 4
});

const monthly = summarizeMoney(money, '2026-09');
assert.deepStrictEqual(monthly, { income: 500, expense: 200, balance: 300, transfer: 150 }, '转账和还款不应重复计入收支');

const alerts = buildBillAlerts(accounts, money, new Date('2026-09-04T10:00:00'));
assert.deepStrictEqual(alerts, [{
  id: 'credit', name: '信用卡', dueDate: '2026-09-08', daysLeft: 4, currentBill: 888, minimumPayment: 100
}]);

const categoryBudget = buildCategoryBudgetProgress(money, { 餐饮: 150, 交通: 100 }, '2026-09');
assert.deepStrictEqual(categoryBudget.rows, [
  { category: '餐饮', budget: 150, spent: 200, remaining: 0, used: 133.3, over: 50, suggested: 250 },
  { category: '交通', budget: 100, spent: 0, remaining: 100, used: 0, over: 0, suggested: 100 }
]);
assert.deepStrictEqual(categoryBudget.overspent.map((item) => item.category), ['餐饮']);

assert.strictEqual(validateRecordData('money', { type: 'transfer', amount: 12, category: '账户转账', date: '2026-09-04', accountId: 'checking', toAccountId: 'wallet' }), '', '转账记录应通过校验');
assert.strictEqual(validateRecordData('money', { type: 'transfer', amount: 12, category: '账户转账', date: '2026-09-04', accountId: 'checking', toAccountId: 'checking' }), 'bad_money', '同账户转账应拒绝');
assert.strictEqual(validateRecordData('accounts', { kind: 'liability', name: '信用卡', category: '信用卡', openingBalance: 100, manualAdjustment: 0, currentBill: 100, minimumPayment: 10, statementDay: 2, dueDay: 8 }), '', '账单账户应通过校验');
assert.strictEqual(validateRecordData('accounts', { kind: 'asset', name: '异常', category: '银行卡', openingBalance: Infinity }), 'bad_accounts', '非有限金额必须被拒绝');
assert.strictEqual(validateRecordData('settings', { budget: 3000, categoryBudgets: { 餐饮: 1200, 交通: 500 } }), '', '分类预算应通过校验');
assert.strictEqual(validateRecordData('settings', { categoryBudgets: JSON.parse('{"__proto__":1}') }), 'bad_settings', '分类预算不应接受原型链键名');
assert.strictEqual(validateRecordData('memories', { content: '只写正文也可以', occurredAt: '2026-09-04T09:30' }), '', '心情和标签应保持可选');

console.log('LEDGER_UTILS_TEST_PASSED');
