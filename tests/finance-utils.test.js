const assert = require('assert');
const {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  ACCOUNT_PRESETS,
  buildFinanceOverview,
  accountInitials
} = require('../miniprogram/utils/finance');
const { validateRecordData } = require('../server/validation');

assert.ok(EXPENSE_CATEGORIES.length >= 20, '支出分类应覆盖更多真实生活场景');
assert.ok(INCOME_CATEGORIES.length >= 9, '收入分类应覆盖工资、奖金、报销等生活场景');
assert.strictEqual(new Set(EXPENSE_CATEGORIES).size, EXPENSE_CATEGORIES.length, '支出分类不能重复');
assert.strictEqual(new Set(INCOME_CATEGORIES).size, INCOME_CATEGORIES.length, '收入分类不能重复');
['餐饮', '买菜', '房租房贷', '水电燃气', '通讯网费', '日用百货', '服饰美容', '旅行住宿', '医疗健康', '人情送礼', '保险', '还款'].forEach((name) => {
  assert.ok(EXPENSE_CATEGORIES.includes(name), `缺少支出分类：${name}`);
});
['工资', '奖金', '副业', '兼职', '理财收益', '退款', '红包礼金', '二手闲置', '报销'].forEach((name) => {
  assert.ok(INCOME_CATEGORIES.includes(name), `缺少收入分类：${name}`);
});

const presetNames = ACCOUNT_PRESETS.map((item) => item.name);
['招商银行卡', '中国银行卡', '支付宝余额', '微信余额', '花呗', '美团月付', '抖音月付', '京东白条', '信用卡'].forEach((name) => {
  assert.ok(presetNames.includes(name), `缺少常用账户模板：${name}`);
});
assert.ok(ACCOUNT_PRESETS.filter((item) => item.kind === 'asset').length >= 4, '常用资产账户模板不完整');
assert.ok(ACCOUNT_PRESETS.filter((item) => item.kind === 'liability').length >= 5, '常用负债账户模板不完整');

const overview = buildFinanceOverview({
  bank: { id: 'bank', data: { kind: 'asset', name: '招商银行卡', balance: 12000 } },
  alipay: { id: 'alipay', data: { kind: 'asset', name: '支付宝余额', balance: 380.5 } },
  huabei: { id: 'huabei', data: { kind: 'liability', name: '花呗', balance: 1200.25 } },
  deleted: { id: 'deleted', data: { kind: 'asset', name: '已删除', balance: 999 }, deletedAt: 10 },
  empty: { id: 'empty', data: null, deletedAt: 0 }
});
assert.deepStrictEqual(overview, {
  assetTotal: 12380.5,
  liabilityTotal: 1200.25,
  netAssets: 11180.25,
  assetCount: 2,
  liabilityCount: 1,
  accountCount: 3
}, '资产、负债和净资产必须只统计当前用户的有效账户');
assert.strictEqual(accountInitials('招商银行卡'), '招商', '账户卡片应取稳定的两字简称');
assert.strictEqual(accountInitials(''), '账', '空账户名称应有可读的默认简称');

assert.strictEqual(validateRecordData('accounts', {
  kind: 'asset', name: '招商银行卡', balance: 12000, category: '银行卡', note: ''
}), '', '服务端应允许资产账户');
assert.strictEqual(validateRecordData('accounts', {
  kind: 'liability', name: '花呗', balance: 1200.25, category: '消费信贷', note: '本月待还'
}), '', '服务端应允许负债账户');
assert.strictEqual(validateRecordData('accounts', {
  kind: 'asset', name: '招商银行卡', balance: -1, category: '银行卡', note: ''
}), 'bad_accounts', '账户余额不能为负数');
assert.strictEqual(validateRecordData('accounts', {
  kind: 'asset', name: '招商银行卡', balance: 10, category: '银行卡', note: '', secret: 'no'
}), 'bad_accounts', '账户记录不能写入白名单外字段');

console.log('FINANCE_UTILS_TEST_PASSED');
