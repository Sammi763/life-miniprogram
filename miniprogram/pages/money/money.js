const { toCents, fromCents, parseMoneyInput, amountError, moneyInputText } = require('../../utils/amount');
const store = require('../../utils/store');
const sync = require('../../utils/sync');
const ui = require('../../utils/ui');
const {
  EXPENSE_CATEGORIES: CAT_OUT,
  INCOME_CATEGORIES: CAT_IN,
  ACCOUNT_PRESETS,
  accountInitials,
  formatMoney
} = require('../../utils/finance');
const { buildBillAlerts, calculateAccountBalances } = require('../../utils/ledger-utils');
const categoryUtils = require('../../utils/category-utils');
const { pickSettings } = require('../../utils/settings-utils');
const { consumePendingAction, ACTIONS } = require('../../utils/pending-open');
const { returnToSearch } = require('../../utils/search-return');
const reminderClient = require('../../utils/reminder-client');
const { syncTabBar, attachOverlayWatcher, TAB } = require('../../utils/tabbar');
const theme = require('../../utils/theme');
const share = require('../../utils/share');

const TRANSFER_CATEGORY = '账户转账';
const UNLINKED = ':unlinked';
const TYPE_FILTERS = [
  { id: '', name: '全部类型' }, { id: 'expense', name: '支出' },
  { id: 'income', name: '收入' }, { id: 'transfer', name: '转账' }
];

function matchesAccount(item, filter) {
  if (!filter) return true;
  if (filter === UNLINKED) return !item.accountId;
  return item.accountId === filter || item.toAccountId === filter;
}
/*
 * 列表分批渲染：流水多的月份一次性把全部日期分组 setData 会撑大单次数据量。
 * 这里按「日期分组数」分批下发，月汇总、分类 chips、月历与角标始终按全月计算，
 * 只裁剪列表视图的 groups 载荷（与随记时间线 v2.6 同一模式）。
 * 同时限制记录条数预算：单日记录特别多时首批也不会被撑大（性能方案 §5）。
 */
const MONEY_LIST_PAGE_GROUPS = 10;
const MONEY_LIST_PAGE_ITEMS = 120;

const RECENT_KEY = 'wb_life_money_recent';
const FORM_DRAFT_KEY = 'wb_life_money_form_draft';

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
function readJsonKey(key) {
  try {
    const raw = wx.getStorageSync(key);
    return raw && typeof raw === 'object' ? raw : null;
  } catch (error) { return null; }
}
function writeJsonKey(key, value) {
  try { wx.setStorageSync(key, value); return true; } catch (error) { return false; }
}
function removeKey(key) {
  try { wx.removeStorageSync(key); } catch (error) { /* ignore */ }
}

Page({
  data: {
    offline: false,
    month: '', monthText: '',
    sumIn: 0, sumOut: 0, sumTransfer: 0,
    filter: '', filters: [], groups: [],
    accountFilter: '', typeFilter: '',
    filterAccounts: [], filterCategories: [], filterTypes: TYPE_FILTERS,
    hasFilters: false, returnSearch: false,
    hasMore: false, groupTotal: 0,
    accounts: [],
    accountOverview: { assetTotal: 0, liabilityTotal: 0, netAssets: 0, assetCount: 0, liabilityCount: 0, accountCount: 0 },
    billAlerts: [],
    accountOptions: [{ id: '', name: '不关联账户' }],
    transferAccounts: [],
    accountPresets: ACCOUNT_PRESETS,
    accountSheetShow: false,
    accountForm: accountForm(),
    sheetShow: false,
    saving: false,
    undoShow: false,
    undoText: '',
    cats: CAT_OUT,
    form: transactionForm(''),
    /* 分类管理弹层：收藏 / 隐藏 / 自定义（配置存 settings.app，见 utils/category-utils.js） */
    catSheetShow: false,
    catTab: 'expense',
    catRows: [],
    catNewName: '',
    /* 记账月历：列表 / 月历两种视图；月历点某天进入当天流水 */
    viewMode: 'list',
    calendarWeeks: [],
    dayFilter: '',
    /* 还款提醒（v2.11 提醒矩阵）：开关写 settings；额度耗尽显示续订横幅 */
    billReminder: { enabled: false, capEnabled: false, credits: 0, time: '', state: 'off', statusText: '未开启', banner: '' },
    /* U04：资产/账户管理默认折叠，主界面突出月收支与流水 */
    accountsExpanded: false,
    /* U01：新增时聚焦金额输入框 */
    focusAmount: false,
    /* U05 预算编辑器（自「我的」页迁回）：R04 草稿隔离 —— 编辑中不被后台刷新覆盖 */
    budgetSheetShow: false,
    budgetEditing: false,
    budgetRemoteChanged: false,
    budgetForm: { main: '', rows: [] }
  },
  unsub: null,
  /* 最近一次能力查询结果，onShow 刷新 */
  reminderCaps: null,
  /* 已下发的日期分组数上限；只在筛选/切月/切视图时回到首批，同步拉取不重置它 */
  visibleGroups: MONEY_LIST_PAGE_GROUPS,
  /* 已下发的记录条数预算：单日记录特别多时首批也不会被撑大 */
  visibleItems: MONEY_LIST_PAGE_ITEMS,
  openBills(event) {
    const id = event && event.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/bills/bills' + (id ? '?repay=' + encodeURIComponent(id) : '') });
  },
  openCategoryDetails(event) {
    const category = event && event.currentTarget.dataset.category;
    wx.navigateTo({ url: '/pages/categories/categories?month=' + this.data.month + (category ? '&category=' + encodeURIComponent(category) : '') });
  },
  onLoad() {
    // 弹层打开时隐藏悬浮导航：自定义 tabBar 压在页面之上，「保存」按钮会被它盖住（详见 utils/tabbar.js）
    attachOverlayWatcher(this);
    this.unsub = ui.bindStore(this, ['money', 'accounts', 'settings', '__sync__'],
      () => this.render(),
      () => this.renderSyncState());
  },
  onShow() { this.__pageHidden = false; theme.applyToPage(this); share.enableShareMenu(); syncTabBar(this, TAB.MONEY); this.render();
    this.consumePendingOpen();
    this.refreshReminderCaps();
  },
  onShareAppMessage: share.onShareAppMessage('money'),
  onShareTimeline: share.onShareTimeline('money'),
  onHide() { this.__pageHidden = true; },
  onUnload() {
    this.__pageHidden = true;
    this.unsub && this.unsub();
    clearTimeout(this.__undoTimer);
  },
  /* 同步状态变化只更新状态横幅，不做整页重算（性能方案 §5） */
  renderSyncState() {
    ui.diffSetData(this, { offline: store.state.syncState === 'offline' });
  },
  retrySync() { return ui.retryWithFeedback(() => sync.pull()); },
  onPullDownRefresh() { sync.pull().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh()); },
  async refreshReminderCaps() {
    const caps = await reminderClient.fetchCaps();
    if (!caps) return;
    this.reminderCaps = caps;
    if (this.__pageHidden) return;
    ui.diffSetData(this, { billReminder: reminderClient.buildReminderView(store.state.records, 'bill', caps) });
  },

  computeLedgerModel(month) {
    const { money, accounts } = store.state.records;
    const key = [month, store.version('money'), store.version('accounts')].join('|');
    const cached = this.__ledgerModel;
    if (cached && cached.key === key && cached.money === money && cached.accounts === accounts) return cached.model;
    const ledger = calculateAccountBalances(accounts, money);
    const accountNames = Object.fromEntries(ledger.list.map((account) => [account.id, account.name]));
    let sumIn = 0;
    let sumOut = 0;
    let sumTransfer = 0;
    const byCat = new Set();
    const referencedAccounts = new Set();
    const byDate = {};
    activeRecords(money).forEach((record) => {
      const data = record.data;
      const cents = toCents(data.amount);
      if (String(data.date || '').slice(0, 7) !== month || !(cents > 0)) return;
      if (data.type === 'income') sumIn += cents;
      if (data.type === 'expense') sumOut += cents;
      if (data.type === 'transfer') sumTransfer += cents;
      const type = ['income', 'expense', 'transfer'].includes(data.type) ? data.type : 'expense';
      const category = type === 'transfer' ? TRANSFER_CATEGORY : (data.category || '其他');
      byCat.add(category);
      const accountId = data.accountId || '';
      const toAccountId = type === 'transfer' ? data.toAccountId || '' : '';
      if (accountId) referencedAccounts.add(accountId);
      if (toAccountId) referencedAccounts.add(toAccountId);
      const accountName = (id) => accountNames[id] || (id ? '已移除账户' : '未关联账户');
      const accountText = type === 'transfer' ? accountName(accountId) + ' → ' + accountName(toAccountId) : accountName(accountId);
      (byDate[data.date] || (byDate[data.date] = [])).push({
        id: record.id, type, cents, amount: fromCents(cents), amountText: formatMoney(data.amount),
        category, accountId, toAccountId,
        note: data.note || '', accountText, amountPrefix: type === 'income' ? '+' : type === 'expense' ? '-' : '↔'
      });
    });
    const groups = Object.keys(byDate).sort((a, b) => b.localeCompare(a)).map((date) => {
      const items = byDate[date].sort((a, b) => b.id.localeCompare(a.id));
      const dayOut = items.filter((item) => item.type === 'expense').reduce((sum, item) => sum + item.cents, 0);
      return { date, dayOut: fromCents(dayOut), items };
    });
    const filters = Array.from(byCat).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    const model = {
      ledger, sumIn: fromCents(sumIn), sumOut: fromCents(sumOut), sumTransfer: fromCents(sumTransfer),
      groups, filters, referencedAccounts
    };
    this.__ledgerModel = { key, money, accounts, model };
    return model;
  },

  render() {
    const state = store.state;
    const month = this.data.month || sync.fmtDate(new Date()).slice(0, 7);
    const { ledger, sumIn, sumOut, sumTransfer, groups, filters, referencedAccounts } = this.computeLedgerModel(month);
    const { filter, accountFilter, typeFilter, dayFilter } = this.data;
    const hasFilters = Boolean(filter || accountFilter || typeFilter || dayFilter);
    const hasItemFilters = Boolean(filter || accountFilter || typeFilter);
    const totals = { expense: 0, income: 0, transfer: 0 };
    const shown = [];
    let shownItems = 0;
    for (const group of groups) {
      if (dayFilter && group.date !== dayFilter) continue;
      const items = hasItemFilters ? group.items.filter((item) =>
        (!filter || item.category === filter) && (!typeFilter || item.type === typeFilter) &&
        matchesAccount(item, accountFilter)) : group.items;
      if (!items.length) continue;
      let dayExpenseCents = 0;
      if (hasFilters) {
        for (const item of items) {
          const cents = item.cents;
          totals[item.type] += cents;
          if (item.type === 'expense') dayExpenseCents += cents;
        }
      }
      shown.push(hasItemFilters ? { ...group, items, dayOut: dayExpenseCents / 100 } : group);
      shownItems += items.length;
    }
    const visibleGroups = Math.max(MONEY_LIST_PAGE_GROUPS, Number(this.visibleGroups) || 0);
    const itemBudget = Math.max(MONEY_LIST_PAGE_ITEMS, Number(this.visibleItems) || 0);
    const listGroups = [];
    let usedItems = 0;
    for (const group of shown) {
      if (listGroups.length >= visibleGroups || usedItems >= itemBudget) break;
      const items = group.items.slice(0, itemBudget - usedItems);
      usedItems += items.length;
      listGroups.push(items.length === group.items.length ? group : { ...group, items });
    }
    const calendarWeeks = this.data.viewMode === 'calendar' ? this.buildCalendarGroups(month, groups) : this.data.calendarWeeks;
    /* 分类管理弹层打开时，行数据（含引用数）随每次渲染刷新 */
    const catRows = this.data.catSheetShow
      ? (categoryUtils.buildCategoryManageList(state.records.settings['app'], state.records.money)[this.data.catTab] || [])
      : this.data.catRows;
    const accounts = ledger.list.map((account) => ({
      ...account,
      balanceText: formatMoney(account.balance),
      flowText: (account.flow > 0 ? '+' : '') + formatMoney(account.flow),
      shortName: accountInitials(account.name),
      kindText: account.kind === 'liability' ? '待还' : '余额',
      billText: account.kind === 'liability' && account.currentBill > 0 ? '本期应还 ¥' + formatMoney(account.currentBill) : ''
    }));
    const accountOptions = [{ id: '', name: '不关联账户' }].concat(ledger.list.map((account) => ({ id: account.id, name: account.name, kind: account.kind })));
    const filterAccounts = [{ id: '', name: '全部账户' }, { id: UNLINKED, name: '未关联账户' }, ...accountOptions.slice(1)];
    const accountIds = new Set(filterAccounts.map((account) => account.id));
    for (const id of new Set([...referencedAccounts, accountFilter])) {
      if (accountIds.has(id)) continue;
      const previous = state.records.accounts[id];
      const name = previous && previous.data && previous.data.name;
      filterAccounts.push({ id, name: name ? name + '（已移除）' : '已移除账户 · ' + id.slice(-6) });
    }
    const categories = filter && !filters.includes(filter) ? filters.concat(filter) : filters;
    const filterCategories = ['全部分类', ...categories];
    const [year, number] = month.split('-');
    ui.diffSetData(this, {
      month, monthText: year + ' 年 ' + Number(number) + ' 月',
      sumIn, sumOut, sumTransfer,
      sumInText: formatMoney(sumIn), sumOutText: formatMoney(sumOut), sumTransferText: formatMoney(sumTransfer),
      /* hasMore 同时看组数与条数预算：单日记录超过条数预算时组数虽尽、条目仍有截断（审查修复） */
      filters, groups: listGroups, groupTotal: shown.length, hasMore: shown.length > listGroups.length || usedItems < shownItems,
      filterAccounts, filterCategories, hasFilters, shownItems, usedItems,
      filterAccountIndex: Math.max(0, filterAccounts.findIndex((item) => item.id === accountFilter)),
      filterTypeIndex: Math.max(0, TYPE_FILTERS.findIndex((item) => item.id === typeFilter)),
      filterCategoryIndex: filter ? categories.indexOf(filter) + 1 : 0,
      filteredInText: formatMoney(totals.income / 100),
      filteredOutText: formatMoney(totals.expense / 100),
      filteredTransferText: formatMoney(totals.transfer / 100),
      accounts, accountOverview: ledger.overview,
      billAlerts: buildBillAlerts(state.records.accounts || {}, state.records.money || {}, new Date()),
      accountOptions, transferAccounts: ledger.list.map((account) => ({ id: account.id, name: account.name, kind: account.kind })),
      offline: state.syncState === 'offline',
      /* R04：预算编辑器打开时，后台刷新只更新只读区域，不得覆盖未保存输入 */
      ...(this.data.budgetEditing && this.__budgetEditBase
        ? (() => {
            const remoteUpdatedAt = (state.records.settings['app'] && state.records.settings['app'].updatedAt) || 0;
            return remoteUpdatedAt > this.__budgetEditBase.updatedAt && !this.data.budgetRemoteChanged
              ? { budgetRemoteChanged: true }
              : {};
          })()
        : {}),
      billReminder: reminderClient.buildReminderView(state.records, 'bill', this.reminderCaps),
      budgetText: (() => {
        const record = state.records.settings['app'];
        const data = record && !record.deletedAt && record.data || {};
        return data.budget ? formatMoney(data.budget) : '';
      })(),
      catRows,
      calendarWeeks
    });
  },

  /* ---- 还款提醒（v2.11）：开启/续订时弹订阅并上报额度；额度由服务端发送成功后扣减 ---- */
  async onBillReminderToggle(event) {
    const enable = Boolean(event.detail && event.detail.value);
    if (!enable) {
      reminderClient.saveReminderSettings(store.state.records, { billReminderEnabled: false });
      return;
    }
    if (!this.reminderCaps) this.reminderCaps = await reminderClient.fetchCaps();
    const result = await reminderClient.subscribeAndCredit('bill', this.reminderCaps || {});
    if (result.ok) {
      wx.showToast({ title: '提醒已开启', icon: 'success' });
    } else if (result.reason === 'unavailable') {
      wx.showToast({ title: '服务端未开启还款提醒', icon: 'none' });
    } else if (result.reason === 'rejected') {
      wx.showToast({ title: '未同意订阅，提醒不会送达', icon: 'none' });
    } else {
      wx.showToast({ title: '额度上报失败，可稍后续订', icon: 'none' });
    }
    reminderClient.saveReminderSettings(store.state.records, { billReminderEnabled: true });
    this.refreshReminderCaps();
  },
  async onReminderRenew() {
    if (ui.isRepeatedTap(this, 'bill-reminder-renew', 800)) return;
    if (!this.reminderCaps) this.reminderCaps = await reminderClient.fetchCaps();
    const result = await reminderClient.subscribeAndCredit('bill', this.reminderCaps || {});
    if (result.ok) wx.showToast({ title: '已续订', icon: 'success' });
    else if (result.reason === 'rejected') wx.showToast({ title: '未同意订阅', icon: 'none' });
    else wx.showToast({ title: '续订失败，请稍后重试', icon: 'none' });
    this.refreshReminderCaps();
  },

  /* 月历网格：周一起始；单元格只展示有流水的日子（空位补齐）。outText 复用 formatMoney 口径。 */
  buildCalendarGroups(month, groups) {
    const [year, monthNumber] = month.split('-').map(Number);
    const firstDay = new Date(year, monthNumber - 1, 1);
    const startOffset = (firstDay.getDay() + 6) % 7; // 周一=0
    const dayCount = new Date(year, monthNumber, 0).getDate();
    const today = sync.fmtDate(new Date());
    const dayOutMap = {};
    groups.forEach((group) => { dayOutMap[group.date] = group.dayOut; });
    const cells = [];
    for (let i = 0; i < startOffset; i++) cells.push({ empty: true, key: 'e' + i });
    for (let day = 1; day <= dayCount; day++) {
      const date = month + '-' + String(day).padStart(2, '0');
      const out = dayOutMap[date] || 0;
      cells.push({ empty: false, key: date, date, day, out, outText: formatMoney(out), hasOut: out > 0, isToday: date === today, isSelected: date === this.data.dayFilter });
    }
    while (cells.length % 7 !== 0) cells.push({ empty: true, key: 't' + cells.length });
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push({ key: 'w' + i, days: cells.slice(i, i + 7) });
    return weeks;
  },
  setViewMode(event) {
    const mode = event.currentTarget.dataset.mode === 'calendar' ? 'calendar' : 'list';
    if (mode === this.data.viewMode) return;
    this.setData({ viewMode: mode });
    this.resetListPage();
    this.render();
  },
  /* 月历点某天：切回列表并过滤到当天；再点同一天取消过滤 */
  tapCalendarDay(event) {
    const date = event.currentTarget.dataset.date;
    if (!date) return;
    const next = this.data.dayFilter === date ? '' : date;
    this.setData({ dayFilter: next, viewMode: 'list' });
    this.resetListPage();
    this.render();
  },
  clearDayFilter() {
    this.setData({ dayFilter: '' });
    this.resetListPage();
    this.render();
  },

  prevMonth() { this.shiftMonth(-1); },
  nextMonth() { this.shiftMonth(1); },
  onReachBottom() { if (this.data.viewMode === 'list' && this.data.hasMore) this.loadMore(); },
  loadMore() {
    this.visibleGroups = (Number(this.visibleGroups) || MONEY_LIST_PAGE_GROUPS) + MONEY_LIST_PAGE_GROUPS;
    this.visibleItems = (Number(this.visibleItems) || MONEY_LIST_PAGE_ITEMS) + MONEY_LIST_PAGE_ITEMS;
    this.render();
  },
  /* 筛选/切月/切视图时回到首批，避免「换了条件却还停在很深的页码」 */
  resetListPage() { this.visibleGroups = MONEY_LIST_PAGE_GROUPS; this.visibleItems = MONEY_LIST_PAGE_ITEMS; },
  shiftMonth(offset) {
    const [year, month] = this.data.month.split('-').map(Number);
    const target = new Date(year, month - 1 + offset, 1);
    this.setData({ month: target.getFullYear() + '-' + String(target.getMonth() + 1).padStart(2, '0'), filter: '', dayFilter: '' });
    this.resetListPage();
    this.render();
  },
  selectAccountFilter(event) {
    const option = this.data.filterAccounts[Number(event.detail.value)];
    if (option) this.updateFilters({ accountFilter: option.id });
  },
  selectTypeFilter(event) {
    const option = TYPE_FILTERS[Number(event.detail.value)];
    if (option) this.updateFilters({ typeFilter: option.id });
  },
  setFilter(event) {
    const index = event.detail && event.detail.value;
    const category = index === undefined
      ? event.currentTarget.dataset.cat
      : Number(index) && this.data.filterCategories[Number(index)];
    this.updateFilters({ filter: category || '' });
  },
  clearFilters() {
    this.updateFilters({ filter: '', typeFilter: '', accountFilter: '', dayFilter: '' });
  },
  updateFilters(patch) {
    this.setData(patch);
    this.resetListPage();
    this.render();
  },
  goReport() { wx.navigateTo({ url: '/pages/report/report' }); },
  /* U04：资产/账户卡片默认折叠，一行概览 + 展开按钮 */
  toggleAccounts() { this.setData({ accountsExpanded: !this.data.accountsExpanded }); },

  // ---- 预算编辑器（U05，自「我的」迁回记账）：分类来自支出分类配置（含任意自定义分类） ----
  /*
   * 打开编辑器时对 settings 打快照（R04 草稿隔离）：
   * 编辑期间 render() 不回写 budgetForm（后台同步/其他记录变化不得覆盖未保存输入）；
   * 若其他设备更新了 settings，横幅提示「其他设备已更新」，保存仍以用户输入为准。
   */
  buildBudgetRows(settings) {
    const budgets = settings.categoryBudgets && typeof settings.categoryBudgets === 'object' ? settings.categoryBudgets : {};
    const hidden = Array.isArray(settings.hiddenCategories) ? settings.hiddenCategories : [];
    const isHidden = (name) => hidden.some((item) => (item && item.name === name && item.type === 'expense') || item === name);
    const rows = categoryUtils.buildCategoryList(store.state.records.settings['app'], store.state.records.money, { type: 'expense' })
      .map((key) => ({ key, value: budgets[key] === undefined ? '' : String(budgets[key]), hiddenSuffix: isHidden(key) ? '（已隐藏）' : '' }));
    // 配置过预算但已不在分类列表里的（如删除的自定义分类）也要出现，避免预算静默丢失
    for (const key of Object.keys(budgets)) {
      if (!rows.some((row) => row.key === key)) rows.push({ key, value: String(budgets[key]), hiddenSuffix: '（分类已不在列表）' });
    }
    return rows;
  },
  openBudgetSheet() {
    const settings = pickSettings(store.state.records.settings.app && store.state.records.settings.app.data);
    const record = store.state.records.settings['app'];
    this.__budgetEditBase = { updatedAt: (record && record.updatedAt) || 0 };
    this.setData({
      budgetSheetShow: true,
      budgetEditing: true,
      budgetRemoteChanged: false,
      budgetForm: {
        main: settings.budget ? String(settings.budget) : '',
        rows: this.buildBudgetRows(settings)
      }
    });
  },
  closeBudgetSheet() {
    this.__budgetEditBase = null;
    this.setData({ budgetSheetShow: false, budgetEditing: false, budgetRemoteChanged: false });
  },
  onMoneyBlur(event) {
    const { path, negative, positive, index } = event.currentTarget.dataset;
    const field = path || 'budgetForm.rows[' + index + '].value';
    const value = event.detail.value;
    this.setData({ [field]: moneyInputText(value, negative, positive) });
  },
  onBudgetMainInput(event) { this.setData({ 'budgetForm.main': event.detail.value }); },
  onBudgetRowInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const value = event.detail.value;
    if (!Number.isInteger(index) || !this.data.budgetForm.rows[index]) return;
    this.setData({ ['budgetForm.rows[' + index + '].value']: value });
  },
  saveBudget() {
    const budget = parseMoneyInput(this.data.budgetForm.main);
    if (!Number.isFinite(budget) || budget < 0 || budget > 1000000) {
      wx.showToast({ title: '预算应为 0～100 万之间的金额', icon: 'none' });
      return;
    }
    const categoryBudgets = {};
    for (const row of this.data.budgetForm.rows) {
      const input = String(row.value || '').trim();
      if (!input) continue;
      const value = parseMoneyInput(input);
      if (!Number.isFinite(value) || value < 0 || value > 1000000) {
        wx.showToast({ title: row.key + ' 预算应为 0～100 万', icon: 'none' });
        return;
      }
      categoryBudgets[row.key] = value;
    }
    if (ui.isRepeatedTap(this, 'money-budget-save', 600)) return;
    const settings = pickSettings(store.state.records.settings.app && store.state.records.settings.app.data);
    const next = { ...settings, budget };
    if (Object.keys(categoryBudgets).length) next.categoryBudgets = categoryBudgets;
    else delete next.categoryBudgets;
    sync.upsert('settings', next, 'app');
    this.__budgetEditBase = null;
    this.setData({ budgetSheetShow: false, budgetEditing: false, budgetRemoteChanged: false });
    ui.completeFeedback({ toast: budget ? '预算已保存' : '已清除月预算' });
  },

  categoryChoices(type, current) {
    if (type === 'transfer') return [TRANSFER_CATEGORY];
    return categoryUtils.buildCategoryList(store.state.records.settings['app'], store.state.records.money, { type, current });
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
  /*
   * 新增一笔：打开即聚焦金额（U01/U04），沿用上次账户与上次支出分类（仍在可选列表时），
   * 并恢复未保存完的表单草稿 —— 关闭弹层时按实际修改情况暂存，无内容则不留草稿。
   */
  openAdd() {
    const form = transactionForm(sync.fmtDate(new Date()));
    const recent = readJsonKey(RECENT_KEY) || {};
    if (recent.accountId && this.data.accountOptions.some((item) => item.id === recent.accountId)) {
      form.accountId = recent.accountId;
    }
    const draft = readJsonKey(FORM_DRAFT_KEY);
    let restored = false;
    if (draft && !draft.id) {
      form.type = ['income', 'expense', 'transfer'].includes(draft.type) ? draft.type : 'expense';
      if (String(draft.amount || '') !== '') form.amount = String(draft.amount);
      if (draft.category && this.categoryChoices(form.type).includes(draft.category)) form.category = draft.category;
      if (draft.date && /^\d{4}-\d{2}-\d{2}$/.test(draft.date)) form.date = draft.date;
      if (draft.note) form.note = String(draft.note);
      if (draft.accountId && this.data.accountOptions.some((item) => item.id === draft.accountId)) form.accountId = draft.accountId;
      restored = Boolean(String(draft.amount || '') !== '' || draft.note);
    }
    this.setData({ sheetShow: true, focusAmount: true, cats: this.categoryChoices(form.type, form.category), form: this.namedForm(form) });
    if (restored) wx.showToast({ title: '已恢复上次未保存的内容', icon: 'none' });
  },
  /* 表单是否被实际修改过：决定关闭时是否值得暂存草稿（避免无意义的确认弹窗） */
  formTouched() {
    const form = this.data.form;
    return String(form.amount || '') !== '' || String(form.note || '') !== '' || form.type !== 'expense' || form.accountId !== '';
  },
  stashFormDraft() {
    // 编辑既有流水的弹层与「记一笔」草稿无关：不动 FORM_DRAFT_KEY，避免看一眼旧流水就毁掉未保存的新增草稿
    if (this.data.form.id) return;
    if (!this.formTouched()) { removeKey(FORM_DRAFT_KEY); return; }
    const form = this.data.form;
    writeJsonKey(FORM_DRAFT_KEY, { type: form.type, amount: form.amount, category: form.category, date: form.date, note: form.note, accountId: form.accountId, savedAt: Date.now() });
  },
  /* 点流水行直接打开编辑弹层；删除移到弹层内（见 removeTransaction），少一步 ActionSheet */
  openEdit(event) { this.openEditById(event.currentTarget.dataset.id); },
  openEditById(id) {
    const record = store.state.records.money[id];
    if (!record || record.deletedAt || !record.data) return;
    const type = ['income', 'expense', 'transfer'].includes(record.data.type) ? record.data.type : 'expense';
    const form = this.namedForm({
      id, type, amount: String(record.data.amount), category: type === 'transfer' ? TRANSFER_CATEGORY : (record.data.category || '其他'),
      date: record.data.date || sync.fmtDate(new Date()), note: record.data.note || '', accountId: record.data.accountId || '', toAccountId: record.data.toAccountId || ''
    });
    // 编辑时带上原分类：即使已被隐藏也要出现在选择器里，保证原值可见可选
    this.setData({ sheetShow: true, focusAmount: false, cats: this.categoryChoices(type, form.category), form });
  },
  /*
   * 搜索页/今日页深链中转：消费一次性导航意图（U01）。
   * create → 直接打开新增表单（聚焦金额）；budget → 打开预算编辑器；id → 打开对应流水编辑。
   * 意图消费后即清除，无论用户最终保存还是放弃都只生效一次。
   */
  consumePendingOpen() {
    const intent = consumePendingAction('money');
    this.setData({ returnSearch: intent.action === ACTIONS.SEARCH });
    if (intent.action === ACTIONS.CREATE) return this.openAdd();
    if (intent.action === ACTIONS.BUDGET) return this.openBudgetSheet();
    if (intent.action === ACTIONS.ACCOUNTS) {
      this.setData({ accountsExpanded: true }, () => wx.pageScrollTo({ selector: '#account-list', duration: 200 }));
      return;
    }
    if (intent.action === ACTIONS.ACCOUNT) return this.openAccountById(intent.id);
    if (intent.id) this.openEditById(intent.id);
  },
  returnToSearch,
  /* 编辑弹层内的删除按钮：立即执行 + 5 秒撤销条 */
  removeTransaction() {
    const id = this.data.form.id;
    if (!id) return;
    const record = store.state.records.money[id];
    if (!record || record.deletedAt || !record.data) return;
    const undoData = record.data;
    this.setData({ sheetShow: false, undoText: '流水已删除' });
    sync.remove('money', id);
    ui.armUndo(this, {
      onUndo: () => {
        sync.upsert('money', undoData, id);
        wx.showToast({ title: '已恢复', icon: 'success' });
      }
    });
  },
  onUndoTap() { ui.performUndo(this); },
  /* 关闭弹层：有实际修改就暂存草稿（下次打开恢复），空表单直接关、不弹确认（长表单草稿保护） */
  closeSheet() {
    if (this.data.saving) return;
    this.stashFormDraft();
    this.setData({ sheetShow: false, focusAmount: false });
  },
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

  // ---- 分类管理：收藏 / 隐藏 / 自定义（配置写入 settings.app，历史流水不受影响） ----
  openCatManage() { this.setData({ catSheetShow: true, catNewName: '' }); this.refreshCatRows(); },
  closeCatSheet() { this.setData({ catSheetShow: false }); },
  setCatTab(event) { this.setData({ catTab: event.currentTarget.dataset.tab === 'income' ? 'income' : 'expense', catNewName: '' }); this.refreshCatRows(); },
  refreshCatRows() {
    const list = categoryUtils.buildCategoryManageList(store.state.records.settings['app'], store.state.records.money);
    this.setData({ catRows: list[this.data.catTab] || [] });
  },
  saveCategoryConfig(nextConfig) {
    const record = store.state.records.settings['app'];
    const data = {
      ...(record && !record.deletedAt && record.data ? record.data : {}),
      customCategories: nextConfig.custom,
      favoriteCategories: nextConfig.favorites,
      hiddenCategories: nextConfig.hidden
    };
    sync.upsert('settings', data, 'app');
  },
  toggleCatFavorite(event) {
    const { name, type } = event.currentTarget.dataset;
    const result = categoryUtils.toggleFavorite(categoryUtils.readConfig(store.state.records.settings['app']), name, type);
    if (result.error) return wx.showToast({ title: result.error, icon: 'none' });
    this.saveCategoryConfig(result.config);
  },
  toggleCatHidden(event) {
    const { name, type } = event.currentTarget.dataset;
    const result = categoryUtils.toggleHidden(categoryUtils.readConfig(store.state.records.settings['app']), name, type);
    if (result.error) return wx.showToast({ title: result.error, icon: 'none' });
    this.saveCategoryConfig(result.config);
  },
  onCatNewName(event) { this.setData({ catNewName: event.detail.value }); },
  addCat() {
    if (ui.isRepeatedTap(this, 'cat-add', 400)) return;
    const result = categoryUtils.addCustomCategory(categoryUtils.readConfig(store.state.records.settings['app']), this.data.catNewName, this.data.catTab);
    if (result.error) return wx.showToast({ title: result.error, icon: 'none' });
    this.saveCategoryConfig(result.config);
    this.setData({ catNewName: '' });
    ui.completeFeedback({ toast: '已添加' });
  },
  /* 改名只影响该方向的这条自定义分类，历史流水保留旧名 */
  renameCat(event) {
    const { name, type } = event.currentTarget.dataset;
    wx.showModal({
      title: '重命名分类',
      content: '改名只影响今后选择，历史流水保留「' + name + '」。',
      editable: true,
      placeholderText: name,
      success: (res) => {
        if (!res.confirm) return;
        const result = categoryUtils.renameCustomCategory(categoryUtils.readConfig(store.state.records.settings['app']), name, String(res.content || ''), type);
        if (result.error) return wx.showToast({ title: result.error, icon: 'none' });
        this.saveCategoryConfig(result.config);
      }
    });
  },
  removeCat(event) {
    const { name, type } = event.currentTarget.dataset;
    const row = this.data.catRows.find((item) => item.name === name && item.type === type);
    const result = categoryUtils.removeCustomCategory(categoryUtils.readConfig(store.state.records.settings['app']), name, type, row ? row.usage : 0);
    if (result.error) return wx.showToast({ title: result.error, icon: 'none' });
    this.saveCategoryConfig(result.config);
    wx.showToast({ title: '已删除', icon: 'success' });
  },
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
    if (!(amount > 0) || amount > 100000000) return wx.showToast({ title: amountError(form.amount, amount), icon: 'none' });
    if (!form.date) return wx.showToast({ title: '请选择日期', icon: 'none' });
    const type = ['income', 'expense', 'transfer'].includes(form.type) ? form.type : 'expense';
    if (type === 'transfer' && (!form.accountId || !form.toAccountId || form.accountId === form.toAccountId)) return wx.showToast({ title: '请选择不同的转出和转入账户', icon: 'none' });
    const data = { type, amount, category: type === 'transfer' ? TRANSFER_CATEGORY : form.category, date: form.date, note: String(form.note || '').trim() };
    if (form.accountId) data.accountId = form.accountId;
    if (type === 'transfer') data.toAccountId = form.toAccountId;
    const source = store.state.records.money[form.id];
    if (source && source.data && source.data.shoppingId) data.shoppingId = source.data.shoppingId;
    if (ui.isRepeatedTap(this, 'money-save', 600)) return;
    this.setData({ saving: true });
    sync.upsert('money', data, form.id || undefined);
    // 记住本次的支出分类与账户，下次「记一笔」自动沿用（U04）
    if (type === 'expense') writeJsonKey(RECENT_KEY, { category: data.category, accountId: data.accountId || '' });
    else if (form.accountId) writeJsonKey(RECENT_KEY, { accountId: form.accountId });
    if (!form.id) removeKey(FORM_DRAFT_KEY);
    this.setData({ sheetShow: false, saving: false, focusAmount: false });
    ui.completeFeedback({ toast: type === 'transfer' ? '转账已记下' : '已记下' });
  },

  openAccountAdd() { this.setData({ accountSheetShow: true, accountForm: accountForm() }); },
  selectAccountPreset(event) {
    const item = event.currentTarget.dataset;
    this.setData({ 'accountForm.name': item.name, 'accountForm.kind': item.kind, 'accountForm.category': item.category });
  },
  /* 点账户行直接打开编辑弹层；删除移到弹层内（见 removeAccount） */
  openAccountEdit(event) { this.openAccountById(event.currentTarget.dataset.id); },
  openAccountById(id) {
    const record = store.state.records.accounts && store.state.records.accounts[id];
    if (!record || record.deletedAt || !record.data) return;
    const data = record.data;
    this.setData({ accountSheetShow: true, accountForm: {
      id, kind: data.kind === 'liability' ? 'liability' : 'asset', name: data.name || '',
      openingBalance: String(data.openingBalance === undefined ? (data.balance || 0) : data.openingBalance),
      manualAdjustment: String(data.manualAdjustment || 0), category: data.category || (data.kind === 'liability' ? '消费信贷' : '银行卡'), note: data.note || '',
      currentBill: data.currentBill === undefined ? '' : String(data.currentBill), minimumPayment: data.minimumPayment === undefined ? '' : String(data.minimumPayment),
      statementDay: data.statementDay === undefined ? '' : String(data.statementDay), dueDay: data.dueDay === undefined ? '' : String(data.dueDay)
    } });
  },
  /* 编辑账户弹层内的删除按钮：立即执行 + 5 秒撤销条 */
  removeAccount() {
    const id = this.data.accountForm.id;
    if (!id) return;
    const record = store.state.records.accounts && store.state.records.accounts[id];
    if (!record || record.deletedAt || !record.data) return;
    const undoData = record.data;
    this.setData({ accountSheetShow: false, undoText: '账户已删除' });
    sync.remove('accounts', id);
    ui.armUndo(this, {
      onUndo: () => {
        sync.upsert('accounts', undoData, id);
        wx.showToast({ title: '已恢复', icon: 'success' });
      }
    });
  },
  closeAccountSheet() { if (!this.data.saving) this.setData({ accountSheetShow: false }); },
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
    const manualAdjustment = parseMoneyInput(form.manualAdjustment, true);
    if (!name) return wx.showToast({ title: '请填写账户名称', icon: 'none' });
    if (!Number.isFinite(openingBalance) || openingBalance < 0 || openingBalance > 1000000000 || !Number.isFinite(manualAdjustment) || Math.abs(manualAdjustment) > 1000000000) return wx.showToast({ title: '请输入正确的期初余额和校准金额', icon: 'none' });
    const data = {
      kind: form.kind === 'liability' ? 'liability' : 'asset', name, openingBalance, manualAdjustment,
      category: form.category || (form.kind === 'liability' ? '消费信贷' : '银行卡'), note: String(form.note || '').trim()
    };
    if (data.kind === 'liability') {
      const currentBill = parseMoneyInput(form.currentBill);
      const minimumPayment = parseMoneyInput(form.minimumPayment);
      const statementDay = form.statementDay === '' ? undefined : Number(form.statementDay);
      const dueDay = form.dueDay === '' ? undefined : Number(form.dueDay);
      if (currentBill < 0 || currentBill > 1000000000 || minimumPayment < 0 || minimumPayment > 1000000000 || !Number.isFinite(currentBill) || !Number.isFinite(minimumPayment) || (statementDay && (!Number.isInteger(statementDay) || statementDay < 1 || statementDay > 31)) || (dueDay && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31))) return wx.showToast({ title: '账单日期或金额不正确', icon: 'none' });
      data.currentBill = currentBill;
      data.minimumPayment = minimumPayment;
      if (statementDay) data.statementDay = statementDay;
      if (dueDay) data.dueDay = dueDay;
    }
    if (ui.isRepeatedTap(this, 'account-save', 600)) return;
    this.setData({ saving: true });
    sync.upsert('accounts', data, form.id || undefined);
    this.setData({ accountSheetShow: false, saving: false });
    ui.completeFeedback({ toast: '账户已更新' });
  }
});
