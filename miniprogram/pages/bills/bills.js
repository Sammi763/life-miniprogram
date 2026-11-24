const store = require('../../utils/store');
const sync = require('../../utils/sync');
const ui = require('../../utils/ui');
const theme = require('../../utils/theme');
const { validateRecordData } = require('../../utils/record-validation');
const { buildBillAlerts } = require('../../utils/ledger-utils');
const { toCents, parseMoneyInput, amountError, moneyInputText } = require('../../utils/amount');
const { formatMoney } = require('../../utils/finance');
const { buildCategoryList } = require('../../utils/category-utils');
const { addDays } = require('../../utils/plan-utils');
const { dueCycles, nextCycle, nextRepaymentId } = require('../../utils/money-rules');

const today = () => sync.fmtDate(new Date());
const DIRECTIONS = ['支出', '收入'];
const FREQUENCIES = ['每月', '每周'];

Page({
  data: { directions: DIRECTIONS, frequencies: FREQUENCIES, form: null, payment: null, rows: [], templates: [], repayments: [], showCount: 30 },

  onLoad(options) {
    theme.applyToPage(this);
    this.unsubscribe = ui.bindStore(this, ['moneyRules', 'money', 'accounts', 'settings'], () => this.render());
    this.render();
    if (options && options.repay) this.openRepayment(options.repay);
  },
  onShow() { this.__pageHidden = false; this.render(); },
  onHide() { this.__pageHidden = true; },
  onUnload() { if (this.unsubscribe) this.unsubscribe(); },
  onReachBottom() { this.setData({ showCount: this.data.showCount + 30 }); this.render(); },

  render() {
    const { moneyRules, money, accounts } = store.state.records;
    const rules = moneyRules || {};
    this.cycles = dueCycles(rules, money, today());
    const rows = this.cycles.slice(0, this.data.showCount).map((item) => ({ ...item, amountText: formatMoney(item.amount) }));
    const templates = Object.entries(rules).filter(([, record]) => !record.deletedAt && record.data).map(([id, record]) => {
      const versions = record.data.versions;
      const rule = versions[versions.length - 1];
      return { id, ...rule, nextDate: nextCycle(rule, today()), amountText: formatMoney(rule.amount) };
    }).filter((rule) => rule.active);
    const repayments = buildBillAlerts(accounts, money, new Date()).map((item) => ({ ...item, amountText: formatMoney(item.remainingBill) }));
    this.setData({ rows, templates, repayments, hasMore: rows.length < this.cycles.length });
  },

  choices(type, category, accountId, assetOnly) {
    const { accounts, settings, money } = store.state.records;
    const categories = type === 'transfer' ? ['账户转账'] : buildCategoryList(settings.app, money, { type, current: category });
    const list = Object.entries(accounts || {}).filter(([, r]) => !r.deletedAt && r.data && (!assetOnly || r.data.kind === 'asset'))
      .map(([id, r]) => ({ id, name: r.data.name }));
    list.unshift({ id: '', name: assetOnly ? '请选择付款账户' : '不关联账户' });
    return {
      categories, accountOptions: list, categoryIndex: Math.max(0, categories.indexOf(category)),
      accountIndex: Math.max(0, list.findIndex((item) => item.id === accountId))
    };
  },
  newRule() {
    const choices = this.choices('expense', '', '', false);
    this.setData({ form: {
      id: '', title: '', type: 'expense', amount: '', startDate: today(), effective: today(),
      frequency: 'monthly', category: choices.categories[0], accountId: ''
    }, payment: null, ...choices });
  },
  editRule(event) {
    const rule = this.data.templates.find((item) => item.id === event.currentTarget.dataset.id);
    if (!rule) return;
    this.setData({ form: { ...rule, effective: addDays(today(), 1), amount: String(rule.amount) }, payment: null,
      ...this.choices(rule.type, rule.category, rule.accountId, false) });
  },
  closeForm() { this.setData({ form: null, payment: null }); },
  ruleTitle(event) { this.setData({ 'form.title': event.detail.value }); },
  onMoneyBlur(event) {
    const { path, negative, positive } = event.currentTarget.dataset;
    const value = event.detail.value;
    this.setData({ [path]: moneyInputText(value, negative, positive) });
  },
  ruleAmount(event) { this.setData({ 'form.amount': event.detail.value }); },
  ruleDate(event) { this.setData({ 'form.startDate': event.detail.value }); },
  ruleFrequency(event) { this.setData({ 'form.frequency': Number(event.detail.value) ? 'weekly' : 'monthly' }); },
  ruleType(event) {
    const type = Number(event.detail.value) ? 'income' : 'expense';
    const options = this.choices(type, '', this.data.form.accountId, false);
    this.setData({ 'form.type': type, 'form.category': options.categories[0], ...options });
  },
  selectCategory(event) {
    const index = Number(event.detail.value);
    const field = this.data.form ? 'form' : 'payment';
    this.setData({ [field + '.category']: this.data.categories[index], categoryIndex: index });
  },
  selectAccount(event) {
    const index = Number(event.detail.value);
    const field = this.data.form ? 'form' : 'payment';
    this.setData({ [field + '.accountId']: this.data.accountOptions[index].id, accountIndex: index });
  },
  saveRule() { this.writeRule(true); },
  stopRule() {
    wx.showModal({ title: '停止此模板？', content: '已到期账单仍可处理。', success: ({ confirm }) => { if (confirm) this.writeRule(false); } });
  },
  writeRule(active) {
    const form = this.data.form;
    if (!form) return;
    const { id, type, category, accountId, frequency, startDate, effective } = form;
    const existing = (store.state.records.moneyRules || {})[id];
    const former = existing && !existing.deletedAt ? existing.data.versions : [];
    const amount = parseMoneyInput(form.amount);
    if (active && !(amount > 0)) return wx.showToast({ title: amountError(form.amount, amount), icon: 'none' });
    const rule = !active && former.length ? { ...former[former.length - 1], active, effective } : {
      title: form.title.trim(), amount, type, category, accountId, frequency, startDate, effective, active
    };
    const data = { versions: former.filter((item) => item.effective < effective).concat(rule) };
    if (validateRecordData('moneyRules', data)) return wx.showToast({ title: '请检查模板标题、金额和日期', icon: 'none' });
    const next = nextCycle(rule, today());
    sync.upsert('moneyRules', data, id || undefined);
    this.closeForm();
    wx.showToast({ title: next ? '下次 ' + next : '模板已停止', icon: 'none' });
  },

  openCycle(event) {
    const item = this.cycles.find((entry) => entry.id === event.currentTarget.dataset.id);
    if (!item) return;
    this.setData({ form: null, payment: { ...item, amount: String(item.amount), note: item.title, dueDate: item.date },
      ...this.choices(item.type, item.category, item.accountId, false) });
  },
  editRepayment(event) { this.openRepayment(event.currentTarget.dataset.id); },
  openRepayment(id) {
    const item = this.data.repayments.find((entry) => entry.id === id);
    if (!item) return;
    const choices = this.choices('transfer', '账户转账', '', true);
    this.setData({ form: null, payment: {
      id: nextRepaymentId(store.state.records.money, id, item.dueDate),
      type: 'transfer', title: item.name, amount: String(item.remainingBill), billDate: item.dueDate,
      category: '账户转账', date: today(), accountId: '', toAccountId: id, note: item.name + '还款'
    }, ...choices });
  },
  paymentDate(event) { this.setData({ 'payment.date': event.detail.value }); },
  paymentAmount(event) { this.setData({ 'payment.amount': event.detail.value }); },
  confirmPayment() {
    const { payment } = this.data;
    if (!payment) return;
    const existing = store.state.records.money[payment.id];
    const replacesDeletedAt = payment.type === 'transfer' && existing && existing.deletedAt;
    if (existing && !replacesDeletedAt) {
      this.closeForm();
      return wx.showToast({ title: '账单记录已更新，请重新打开', icon: 'none' });
    }
    const { type, date, category, note, accountId, toAccountId } = payment;
    const amount = parseMoneyInput(payment.amount);
    if (!(amount > 0)) return wx.showToast({ title: amountError(payment.amount, amount), icon: 'none' });
    const data = { type, date, category, note, amount };
    const accounts = store.state.records.accounts;
    if (accountId && accounts[accountId] && !accounts[accountId].deletedAt) data.accountId = accountId;
    if (type === 'transfer') {
      if (!accounts[toAccountId] || accounts[toAccountId].deletedAt || accounts[toAccountId].data.kind !== 'liability') {
        return wx.showToast({ title: '还款账户已变更', icon: 'none' });
      }
      if (!data.accountId || accounts[data.accountId].data.kind !== 'asset') {
        return wx.showToast({ title: '请选择付款账户', icon: 'none' });
      }
      const bill = buildBillAlerts(accounts, store.state.records.money, new Date())
        .find((item) => item.id === toAccountId && item.dueDate === payment.billDate);
      if (!bill || nextRepaymentId(store.state.records.money, toAccountId, payment.billDate) !== payment.id) {
        this.closeForm();
        return wx.showToast({ title: '本期账单已更新，请重新打开', icon: 'none' });
      }
      if (toCents(data.amount) > toCents(bill.remainingBill)) {
        return wx.showToast({ title: '还款金额不能超过剩余应还', icon: 'none' });
      }
      data.toAccountId = toAccountId;
    }
    if (validateRecordData('money', data)) return wx.showToast({ title: '请检查金额和账户', icon: 'none' });
    const options = { createOnly: true };
    if (replacesDeletedAt) {
      options.replacesDeletedAt = replacesDeletedAt;
      options.updatedAt = Math.max(Date.now(), replacesDeletedAt + 1);
    }
    sync.upsert('money', data, payment.id, options);
    this.closeForm();
    wx.showToast({ title: '已记账' });
  },
  skipPayment() {
    const { payment } = this.data;
    if (!payment || !payment.dueDate || store.state.records.money[payment.id]) return;
    sync.upsert('money', { skipped: true }, payment.id, { createOnly: true });
    this.closeForm();
    wx.showToast({ title: '已跳过本期' });
  }
});
