const store = require('../../utils/store');
const sync = require('../../utils/sync');
const {
  EXPENSE_CATEGORIES: CAT_OUT,
  INCOME_CATEGORIES: CAT_IN,
  ACCOUNT_PRESETS,
  accountInitials
} = require('../../utils/finance');
const { buildBillAlerts, calculateAccountBalances } = require('../../utils/ledger-utils');
const { syncTabBar } = require('../../utils/tabbar');
const theme = require('../../utils/theme');

const TRANSFER_CATEGORY = '账户转账';

function roundMoney(value) { return Math.round((Number(value) || 0) * 100) / 100; }
function parseMoneyInput(value) {
  const source = String(value === undefined || value === null ? '' : value).trim();
  if (source === '') return 0;
  const amount = Number(source);
  return Number.isFinite(amount) ? roundMoney(amount) : NaN;
}
function formatBalance(value) {
  const amount = roundMoney(value);
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
function activeRecords(records) { return Object.values(records || {}).filter((record) => record && !record.deletedAt && record.data); }
function accountForm() {
  return {
    id: '', kind: 'asset', name: '', openingBalance: '', manualAdjustment: '0', category: '银行卡', note: '',
    currentBill: '', minimumPayment: '', statementDay: '', dueDay: ''
  };
}
function transactionForm(date) {
  return { id: '', type: 'expense', amount: '', category: CAT_OUT[0], date, note: '', accountId: '', toAccountId: '', accountIndex: 0, toAccountIndex: 0, accountName: '不关联账户', toAccountName: '请选择转入账户' };
}
function mergeCategories(recent, fallback) {
  const output = [];
  recent.concat(fallback).forEach((value) => { if (value && !output.includes(value)) output.push(value); });
  return output;
}

Page({
  data: {
    offline: false,
    month: '', monthText: '',
    sumIn: 0, sumOut: 0, sumTransfer: 0,
    filter: '', filters: [], groups: [],
    accounts: [],
    accountOverview: { assetTotal: 0, liabilityTotal: 0, netAssets: 0, assetCount: 0, liabilityCount: 0, accountCount: 0 },
    billAlerts: [],
    accountOptions: [{ id: '', name: '不关联账户' }],
    transferAccounts: [],
    accountPresets: ACCOUNT_PRESETS,
    accountSheetShow: false,
    accountForm: accountForm(),
    sheetShow: false,
    cats: CAT_OUT,
    form: transactionForm(''),
  recentCategories: []
  },
  unsub: null,
  onLoad() {
    theme.applyToPage(this);
    this.unsub = store.subscribe(() => this.render());
    this.setData({ month: sync.fmtDate(new Date()).slice(0, 7) });
    this.render();
  },
  onShow() { theme.applyToPage(this); syncTabBar(this, 1); this.render(); },
  onUnload() { this.unsub && this.unsub(); },
  onPullDownRefresh() { sync.pull().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh()); },

  render() {
    const state = store.state;
    const month = this.data.month || sync.fmtDate(new Date()).slice(0, 7);
    const ledger = calculateAccountBalances(state.records.accounts || {}, state.records.money || {});
    const accountNames = Object.fromEntries(ledger.list.map((account) => [account.id, account.name]));
    let sumIn = 0;
    let sumOut = 0;
    let sumTransfer = 0;
    const byCat = {};
    const byDate = {};
    const categoryHistory = [];
    activeRecords(state.records.money).forEach((record) => {
      const data = record.data;
      const amount = Number(data.amount) || 0;
      if (data.type === 'expense' && data.category) categoryHistory.push({ category: data.category, updatedAt: record.updatedAt || 0 });
      if (String(data.date || '').slice(0, 7) !== month || !(amount > 0)) return;
      if (data.type === 'income') sumIn += amount;
      if (data.type === 'expense') {
        sumOut += amount;
        byCat[data.category || '其他'] = (byCat[data.category || '其他'] || 0) + amount;
      }
      if (data.type === 'transfer') sumTransfer += amount;
      const type = ['income', 'expense', 'transfer'].includes(data.type) ? data.type : 'expense';
      const accountText = type === 'transfer'
        ? (accountNames[data.accountId] || '未关联账户') + ' → ' + (accountNames[data.toAccountId] || '未关联账户')
        : (accountNames[data.accountId] || '未关联账户');
      (byDate[data.date] || (byDate[data.date] = [])).push({
        id: record.id, type, amount, category: type === 'transfer' ? TRANSFER_CATEGORY : (data.category || '其他'),
        note: data.note || '', accountText, amountPrefix: type === 'income' ? '+' : type === 'expense' ? '-' : '↔'
      });
    });
    const groups = Object.keys(byDate).sort((a, b) => b.localeCompare(a)).map((date) => {
      const items = byDate[date].sort((a, b) => b.id.localeCompare(a.id));
      const dayOut = items.filter((item) => item.type === 'expense').reduce((sum, item) => sum + item.amount, 0);
      return { date, dayOut: roundMoney(dayOut), items };
    });
    const filters = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]).slice(0, 8);
    const shown = this.data.filter ? groups.map((group) => ({ ...group, items: group.items.filter((item) => item.type === 'expense' && item.category === this.data.filter) })).filter((group) => group.items.length) : groups;
    const accounts = ledger.list.map((account) => ({
      ...account,
      balanceText: formatBalance(account.balance),
      flowText: (account.flow > 0 ? '+' : '') + formatBalance(account.flow),
      shortName: accountInitials(account.name),
      kindText: account.kind === 'liability' ? '待还' : '余额',
      billText: account.kind === 'liability' && account.currentBill > 0 ? '本期应还 ¥' + formatBalance(account.currentBill) : ''
    }));
    const accountOptions = [{ id: '', name: '不关联账户' }].concat(ledger.list.map((account) => ({ id: account.id, name: account.name, kind: account.kind })));
    const recentCategories = [];
    categoryHistory.sort((a, b) => b.updatedAt - a.updatedAt).forEach((item) => { if (!recentCategories.includes(item.category)) recentCategories.push(item.category); });
    const [year, number] = month.split('-');
    this.setData({
      month, monthText: year + ' 年 ' + Number(number) + ' 月',
      sumIn: roundMoney(sumIn), sumOut: roundMoney(sumOut), sumTransfer: roundMoney(sumTransfer),
      filters, groups: shown, accounts, accountOverview: ledger.overview,
      billAlerts: buildBillAlerts(state.records.accounts || {}, state.records.money || {}, new Date()),
      accountOptions, transferAccounts: ledger.list.map((account) => ({ id: account.id, name: account.name, kind: account.kind })),
      recentCategories, offline: state.syncState === 'offline'
    });
  },

  prevMonth() { this.shiftMonth(-1); },
  nextMonth() { this.shiftMonth(1); },
  shiftMonth(offset) {
    const [year, month] = this.data.month.split('-').map(Number);
    const target = new Date(year, month - 1 + offset, 1);
    this.setData({ month: target.getFullYear() + '-' + String(target.getMonth() + 1).padStart(2, '0'), filter: '' });
    this.render();
  },
  setFilter(event) {
    this.setData({ filter: event.currentTarget.dataset.cat === this.data.filter ? '' : event.currentTarget.dataset.cat });
    this.render();
  },
  goReport() { wx.navigateTo({ url: '/pages/report/report' }); },

  categoryChoices(type) {
    if (type === 'transfer') return [TRANSFER_CATEGORY];
    const fallback = type === 'income' ? CAT_IN : CAT_OUT;
    const history = activeRecords(store.state.records.money).filter((record) => record.data.type === type && record.data.category)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map((record) => record.data.category);
    return mergeCategories(history, fallback);
  },
  namedForm(form) {
    const selectableAccounts = form.type === 'transfer' ? this.data.transferAccounts : this.data.accountOptions;
    const account = selectableAccounts.find((item) => item.id === form.accountId) || selectableAccounts[0];
    const transfer = this.data.transferAccounts.find((item) => item.id === form.toAccountId);
    return {
      ...form,
      accountIndex: Math.max(0, selectableAccounts.findIndex((item) => item.id === form.accountId)),
      toAccountIndex: Math.max(0, this.data.transferAccounts.findIndex((item) => item.id === form.toAccountId)),
      accountName: account ? account.name : (form.type === 'transfer' ? '请选择转出账户' : '不关联账户'),
      toAccountName: transfer ? transfer.name : '请选择转入账户'
    };
  },
  openAdd() {
    const form = transactionForm(sync.fmtDate(new Date()));
    this.setData({ sheetShow: true, cats: this.categoryChoices('expense'), form: this.namedForm(form) });
  },
  openEdit(event) {
    const id = event.currentTarget.dataset.id;
    const record = store.state.records.money[id];
    if (!record || record.deletedAt || !record.data) return;
    wx.showActionSheet({
      itemList: ['编辑', '删除'],
      success: (result) => {
        if (result.tapIndex === 1) return wx.showModal({
          title: '删除这笔记录？', content: (record.data.category || TRANSFER_CATEGORY) + ' ¥' + record.data.amount,
          confirmColor: '#C0392B', success: (modal) => { if (modal.confirm) sync.remove('money', id); }
        });
        const type = ['income', 'expense', 'transfer'].includes(record.data.type) ? record.data.type : 'expense';
        const form = this.namedForm({
          id, type, amount: String(record.data.amount), category: type === 'transfer' ? TRANSFER_CATEGORY : (record.data.category || '其他'),
          date: record.data.date || sync.fmtDate(new Date()), note: record.data.note || '', accountId: record.data.accountId || '', toAccountId: record.data.toAccountId || ''
        });
        this.setData({ sheetShow: true, cats: this.categoryChoices(type), form });
      }
    });
  },
  closeSheet() { this.setData({ sheetShow: false }); },
  noop() {},
  setType(event) {
    const type = event.currentTarget.dataset.type;
    const cats = this.categoryChoices(type);
    const form = { ...this.data.form, type, category: type === 'transfer' ? TRANSFER_CATEGORY : cats[0] || '其他' };
    if (type === 'transfer') {
      const first = this.data.transferAccounts[0];
      const second = this.data.transferAccounts[1] || first;
      form.accountId = first ? first.id : '';
      form.toAccountId = second && second.id !== form.accountId ? second.id : '';
    }
    this.setData({ cats, form: this.namedForm(form) });
  },
  setCat(event) { this.setData({ 'form.category': event.currentTarget.dataset.cat }); },
  onAmount(event) { this.setData({ 'form.amount': event.detail.value }); },
  onNote(event) { this.setData({ 'form.note': event.detail.value }); },
  onDate(event) { this.setData({ 'form.date': event.detail.value }); },
  onAccountChange(event) {
    const list = this.data.form.type === 'transfer' ? this.data.transferAccounts : this.data.accountOptions;
    const account = list[Number(event.detail.value)] || list[0];
    if (!account) return;
    this.setData({ 'form.accountId': account.id, 'form.accountIndex': Number(event.detail.value), 'form.accountName': account.name });
  },
  onToAccountChange(event) {
    const account = this.data.transferAccounts[Number(event.detail.value)];
    if (!account) return;
    this.setData({ 'form.toAccountId': account.id, 'form.toAccountIndex': Number(event.detail.value), 'form.toAccountName': account.name });
  },
  save() {
    const form = this.data.form;
    const amount = parseMoneyInput(form.amount);
    if (!(amount > 0)) return wx.showToast({ title: '请输入正确金额', icon: 'none' });
    if (!form.date) return wx.showToast({ title: '请选择日期', icon: 'none' });
    const type = ['income', 'expense', 'transfer'].includes(form.type) ? form.type : 'expense';
    if (type === 'transfer' && (!form.accountId || !form.toAccountId || form.accountId === form.toAccountId)) return wx.showToast({ title: '请选择不同的转出和转入账户', icon: 'none' });
    const data = { type, amount, category: type === 'transfer' ? TRANSFER_CATEGORY : form.category, date: form.date, note: String(form.note || '').trim() };
    if (form.accountId) data.accountId = form.accountId;
    if (type === 'transfer') data.toAccountId = form.toAccountId;
    sync.upsert('money', data, form.id || undefined);
    this.setData({ sheetShow: false });
    wx.showToast({ title: type === 'transfer' ? '转账已记下' : '已记下', icon: 'success' });
  },

  openAccountAdd() { this.setData({ accountSheetShow: true, accountForm: accountForm() }); },
  selectAccountPreset(event) {
    const item = event.currentTarget.dataset;
    this.setData({ 'accountForm.name': item.name, 'accountForm.kind': item.kind, 'accountForm.category': item.category });
  },
  openAccountEdit(event) {
    const id = event.currentTarget.dataset.id;
    const record = store.state.records.accounts && store.state.records.accounts[id];
    if (!record || record.deletedAt || !record.data) return;
    wx.showActionSheet({
      itemList: ['编辑', '删除'],
      success: (result) => {
        if (result.tapIndex === 1) return wx.showModal({
          title: '删除这个账户？', content: '流水会保留为历史记录，但不再参与这个账户的余额推导。', confirmColor: '#C0392B',
          success: (modal) => { if (modal.confirm) sync.remove('accounts', id); }
        });
        const data = record.data;
        this.setData({ accountSheetShow: true, accountForm: {
          id, kind: data.kind === 'liability' ? 'liability' : 'asset', name: data.name || '',
          openingBalance: String(data.openingBalance === undefined ? (data.balance || 0) : data.openingBalance),
          manualAdjustment: String(data.manualAdjustment || 0), category: data.category || (data.kind === 'liability' ? '消费信贷' : '银行卡'), note: data.note || '',
          currentBill: data.currentBill === undefined ? '' : String(data.currentBill), minimumPayment: data.minimumPayment === undefined ? '' : String(data.minimumPayment),
          statementDay: data.statementDay === undefined ? '' : String(data.statementDay), dueDay: data.dueDay === undefined ? '' : String(data.dueDay)
        } });
      }
    });
  },
  closeAccountSheet() { this.setData({ accountSheetShow: false }); },
  setAccountKind(event) {
    const kind = event.currentTarget.dataset.kind;
    this.setData({ 'accountForm.kind': kind, 'accountForm.category': kind === 'liability' ? '消费信贷' : '银行卡' });
  },
  onAccountName(event) { this.setData({ 'accountForm.name': event.detail.value }); },
  onOpeningBalance(event) { this.setData({ 'accountForm.openingBalance': event.detail.value }); },
  onManualAdjustment(event) { this.setData({ 'accountForm.manualAdjustment': event.detail.value }); },
  onAccountNote(event) { this.setData({ 'accountForm.note': event.detail.value }); },
  onCurrentBill(event) { this.setData({ 'accountForm.currentBill': event.detail.value }); },
  onMinimumPayment(event) { this.setData({ 'accountForm.minimumPayment': event.detail.value }); },
  onStatementDay(event) { this.setData({ 'accountForm.statementDay': event.detail.value }); },
  onDueDay(event) { this.setData({ 'accountForm.dueDay': event.detail.value }); },
  saveAccount() {
    const form = this.data.accountForm;
    const name = String(form.name || '').trim();
    const openingBalance = parseMoneyInput(form.openingBalance);
    const manualAdjustment = parseMoneyInput(form.manualAdjustment);
    if (!name) return wx.showToast({ title: '请填写账户名称', icon: 'none' });
    if (!Number.isFinite(openingBalance) || openingBalance < 0 || !Number.isFinite(manualAdjustment)) return wx.showToast({ title: '请输入正确的期初余额和校准金额', icon: 'none' });
    const data = {
      kind: form.kind === 'liability' ? 'liability' : 'asset', name, openingBalance, manualAdjustment,
      category: form.category || (form.kind === 'liability' ? '消费信贷' : '银行卡'), note: String(form.note || '').trim()
    };
    if (data.kind === 'liability') {
      const currentBill = parseMoneyInput(form.currentBill);
      const minimumPayment = parseMoneyInput(form.minimumPayment);
      const statementDay = form.statementDay === '' ? undefined : Number(form.statementDay);
      const dueDay = form.dueDay === '' ? undefined : Number(form.dueDay);
      if (currentBill < 0 || minimumPayment < 0 || !Number.isFinite(currentBill) || !Number.isFinite(minimumPayment) || (statementDay && (!Number.isInteger(statementDay) || statementDay < 1 || statementDay > 31)) || (dueDay && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31))) return wx.showToast({ title: '账单日期或金额不正确', icon: 'none' });
      data.currentBill = currentBill;
      data.minimumPayment = minimumPayment;
      if (statementDay) data.statementDay = statementDay;
      if (dueDay) data.dueDay = dueDay;
    }
    sync.upsert('accounts', data, form.id || undefined);
    this.setData({ accountSheetShow: false });
    wx.showToast({ title: '账户已更新', icon: 'success' });
  }
});
