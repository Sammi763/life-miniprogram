const assert = require('assert');
const fs = require('fs');
const path = require('path');
const store = require('../miniprogram/utils/store');
const sync = require('../miniprogram/utils/sync');

const root = path.resolve(__dirname, '..');

function loadPage() {
  const target = path.join(root, 'miniprogram/pages/money/money.js');
  let definition;
  const originalPage = global.Page;
  global.Page = (page) => { definition = page; };
  delete require.cache[require.resolve(target)];
  require(target);
  global.Page = originalPage;
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

const moneyTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/money/money.wxml'), 'utf8');
assert.match(moneyTemplate, /资金版图|净资产/, '记账页应展示账户总览');
assert.match(moneyTemplate, /招商银行卡/, '记账页应提供常用账户快捷模板');
assert.match(moneyTemplate, /添加账户/, '记账页应有添加账户入口');
assert.match(moneyTemplate, /accountSheetShow/, '账户编辑应使用独立交互面板');

const originalAccounts = store.state.records.accounts;
const originalMoney = store.state.records.money;
const originalUpsert = sync.upsert;
const originalRemove = sync.remove;
const originalWx = global.wx;
try {
  store.state.records.accounts = {
    bank: { id: 'bank', data: { kind: 'asset', name: '招商银行卡', balance: 12000, category: '银行卡', note: '' }, updatedAt: 1, deletedAt: 0 },
    alipay: { id: 'alipay', data: { kind: 'asset', name: '支付宝余额', balance: 380.5, category: '支付余额', note: '' }, updatedAt: 2, deletedAt: 0 },
    huabei: { id: 'huabei', data: { kind: 'liability', name: '花呗', balance: 1200.25, category: '消费信贷', note: '' }, updatedAt: 3, deletedAt: 0 }
  };
  store.state.records.money = {};
  const writes = [];
  sync.upsert = (...args) => writes.push(args);
  sync.remove = (...args) => writes.push(['remove', ...args]);
  global.wx = {
    showToast() {},
    showActionSheet(options) { options.success({ tapIndex: 1 }); },
    showModal(options) { options.success({ confirm: true }); }
  };

  const page = makePage(loadPage());
  page.data.month = '2026-09';
  page.render.call(page);
  assert.strictEqual(page.data.accountOverview.assetTotal, 12380.5, '页面应显示资产总额');
  assert.strictEqual(page.data.accountOverview.liabilityTotal, 1200.25, '页面应显示欠款总额');
  assert.strictEqual(page.data.accountOverview.netAssets, 11180.25, '页面应显示净资产');
  assert.deepStrictEqual(page.data.accounts.map((item) => item.name), ['招商银行卡', '支付宝余额', '花呗'], '账户应按资产在前、负债在后展示');

  page.openAccountAdd.call(page);
  page.selectAccountPreset.call(page, { currentTarget: { dataset: { name: '花呗', kind: 'liability', category: '消费信贷' } } });
  page.onOpeningBalance.call(page, { detail: { value: '888.80' } });
  page.saveAccount.call(page);
  assert.deepStrictEqual(writes.pop(), ['accounts', {
    kind: 'liability', name: '花呗', openingBalance: 888.8, manualAdjustment: 0, category: '消费信贷', note: '', currentBill: 0, minimumPayment: 0
  }, undefined], '保存账户应按期初余额、流水和校准的账本模型写入统一同步集合');

  page.openAdd.call(page);
  page.setType.call(page, { currentTarget: { dataset: { type: 'transfer' } } });
  assert.strictEqual(page.data.form.accountIndex, 0, '转账账户选择器不应包含“不关联账户”占位项');
  assert.strictEqual(page.data.form.toAccountIndex, 1, '转入账户应保持对应账户的索引');
  page.onAmount.call(page, { detail: { value: '66.60' } });
  page.save.call(page);
  const transferWrite = writes.pop();
  assert.strictEqual(transferWrite[0], 'money');
  assert.deepStrictEqual(transferWrite[1], {
    type: 'transfer', amount: 66.6, category: '账户转账', date: sync.fmtDate(new Date()), note: '', accountId: 'bank', toAccountId: 'alipay'
  }, '账户间转账应同时记录转出和转入账户，而不伪装成支出');

  page.openAccountEdit.call(page, { currentTarget: { dataset: { id: 'huabei' } } });
  assert.deepStrictEqual(writes.pop(), ['remove', 'accounts', 'huabei'], '账户删除应走同步墓碑协议');
} finally {
  store.state.records.accounts = originalAccounts;
  store.state.records.money = originalMoney;
  sync.upsert = originalUpsert;
  sync.remove = originalRemove;
  global.wx = originalWx;
}

console.log('FINANCE_PAGE_TEST_PASSED');
