/* 财务领域常量与纯计算：记账页面和测试共用，避免分类与资产口径分叉。 */
const { toCents, fromCents } = require('./amount');
const { calculateAccountBalances } = require('./ledger-utils');
const EXPENSE_CATEGORIES = [
  '餐饮', '买菜', '水果零食', '交通', '打车出行', '房租房贷', '水电燃气', '通讯网费',
  '日用百货', '居家用品', '服饰美容', '娱乐休闲', '旅行住宿', '学习培训', '数码家电',
  '医疗健康', '运动健身', '宠物', '人情送礼', '保险', '还款', '住房物业', '家庭育儿',
  '订阅会员', '银行手续费', '税费', '公益捐赠', '其他'
];

const INCOME_CATEGORIES = [
  '工资', '奖金', '副业', '兼职', '理财收益', '利息', '退款', '红包礼金', '二手闲置', '报销', '其他'
];

const ACCOUNT_PRESETS = [
  { name: '现金', kind: 'asset', category: '现金' },
  { name: '招商银行卡', kind: 'asset', category: '银行卡' },
  { name: '中国银行卡', kind: 'asset', category: '银行卡' },
  { name: '支付宝余额', kind: 'asset', category: '支付余额' },
  { name: '微信余额', kind: 'asset', category: '支付余额' },
  { name: '投资账户', kind: 'asset', category: '投资账户' },
  { name: '花呗', kind: 'liability', category: '消费信贷' },
  { name: '美团月付', kind: 'liability', category: '消费信贷' },
  { name: '抖音月付', kind: 'liability', category: '消费信贷' },
  { name: '京东白条', kind: 'liability', category: '消费信贷' },
  { name: '信用卡', kind: 'liability', category: '信用卡' }
];

function roundMoney(value) {
  return fromCents(toCents(value) || 0);
}

function accountData(record) {
  if (!record || record.deletedAt) return null;
  return record.data && typeof record.data === 'object' ? record.data : record;
}

function buildFinanceOverview(records, moneyRecords) {
  return calculateAccountBalances(records, moneyRecords).overview;
}

function accountInitials(name) {
  const value = Array.from(String(name || '').trim());
  return value.slice(0, 2).join('') || '账';
}

/*
 * 金额显示的唯一实现（记账 / 待买 / 月报共用）。
 * 约定：整数不带小数，有小数最多两位且去掉末尾 0 —— 89 / 143.5 / 0.05。
 * 之所以要统一：此前同一屏会同时出现 ¥89、¥54.5 与 ¥143.50、¥8356.50 两种写法
 * （记账页直接绑定原始数字，待买页用 toFixed(2)，月报用「整数原样、否则两位」）。
 * String(roundMoney(v)) 天然就是「去末尾 0」的写法，不需要再正则处理。
 */
function formatMoney(value) {
  return String(roundMoney(value));
}

module.exports = {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  ACCOUNT_PRESETS,
  buildFinanceOverview,
  accountInitials,
  roundMoney,
  formatMoney
};
