const store = require('../../utils/store');
const sync = require('../../utils/sync');
const ui = require('../../utils/ui');
const {
  EXPENSE_CATEGORIES: CAT_OUT,
  INCOME_CATEGORIES: CAT_IN,
  ACCOUNT_PRESETS,
  accountInitials,
  roundMoney,
  formatMoney
} = require('../../utils/finance');
const { buildBillAlerts, calculateAccountBalances } = require('../../utils/ledger-utils');
const categoryUtils = require('../../utils/category-utils');
const { consumePendingOpen: consumePendingOpenStorage } = require('../../utils/pending-open');
const reminderClient = require('../../utils/reminder-client');
const { syncTabBar, attachOverlayWatcher, TAB } = require('../../utils/tabbar');
const theme = require('../../utils/theme');
const share = require('../../utils/share');

const TRANSFER_CATEGORY = '账户转账';
/*
 * 列表分批渲染：流水多的月份一次性把全部日期分组 setData 会撑大单次数据量。
 * 这里按「日期分组数」分批下发，月汇总、分类 chips、月历与角标始终按全月计算，
 * 只裁剪列表视图的 groups 载荷（与随记时间线 v2.6 同一模式）。
 */
const MONEY_LIST_PAGE_GROUPS = 10;

function parseMoneyInput(value) {
  const source = String(value === undefined || value === null ? '' : value).trim();
  if (source === '') return 0;
  const amount = Number(source);
  return Number.isFinite(amount) ? roundMoney(amount) : NaN;
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

Page({
  data: {
    offline: false,
    month: '', monthText: '',
    sumIn: 0, sumOut: 0, sumTransfer: 0,
    filter: '', filters: [], groups: [],
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
    billReminder: { enabled: false, capEnabled: false, credits: 0, time: '', banner: '' }
  },
  unsub: null,
  /* 最近一次能力查询结果，onShow 刷新 */
  reminderCaps: null,
  /* 已下发的日期分组数上限；只在筛选/切月/切视图时回到首批，同步拉取不重置它 */
  visibleGroups: MONEY_LIST_PAGE_GROUPS,
  onLoad() {
    theme.applyToPage(this);
    // 弹层打开时隐藏悬浮导航：自定义 tabBar 压在页面之上，「保存」按钮会被它盖住（详见 utils/tabbar.js）
    attachOverlayWatcher(this);
    this.unsub = store.subscribe(() => this.render());
    this.setData({ month: sync.fmtDate(new Date()).slice(0, 7) });
    this.render();
  },
  onShow() {
    theme.applyToPage(this); share.enableShareMenu(); syncTabBar(this, TAB.MONEY); this.render();
    this.consumePendingOpen();
    this.refreshReminderCaps();
  },
  onShareAppMessage: share.onShareAppMessage('money'),
  onShareTimeline: share.onShareTimeline('money'),
  onUnload() {
    this.unsub && this.unsub();
    clearTimeout(this.__undoTimer);
  },
  retrySync() { return ui.retryWithFeedback(() => sync.pull()); },
  onPullDownRefresh() { sync.pull().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh()); },
  async refreshReminderCaps() {
    const caps = await reminderClient.fetchCaps();
    if (!caps) return;
    this.reminderCaps = caps;
    this.render();
  },

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
    activeRecords(state.records.money).forEach((record) => {
      const data = record.data;
      const amount = Number(data.amount) || 0;
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
        id: record.id, type, amount, amountText: formatMoney(amount),
        category: type === 'transfer' ? TRANSFER_CATEGORY : (data.category || '其他'),
        note: data.note || '', accountText, amountPrefix: type === 'income' ? '+' : type === 'expense' ? '-' : '↔'
      });
    });
    const groups = Object.keys(byDate).sort((a, b) => b.localeCompare(a)).map((date) => {
      const items = byDate[date].sort((a, b) => b.id.localeCompare(a.id));
      const dayOut = items.filter((item) => item.type === 'expense').reduce((sum, item) => sum + item.amount, 0);
      return { date, dayOut: roundMoney(dayOut), items };
    });
    const filters = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]).slice(0, 8);
    let shown = this.data.filter ? groups.map((group) => ({ ...group, items: group.items.filter((item) => item.type === 'expense' && item.category === this.data.filter) })).filter((group) => group.items.length) : groups;
    /* 月历视图：按日支出合计；从月历点某天会切回列表并过滤到当天（dayFilter） */
    if (this.data.dayFilter) shown = shown.filter((group) => group.date === this.data.dayFilter);
    /* 分批：只裁剪列表载荷；月历视图（calendarWeeks）仍用全月分组构建，不受影响 */
    const visibleGroups = Math.max(MONEY_LIST_PAGE_GROUPS, Number(this.visibleGroups) || 0);
    const listGroups = shown.slice(0, visibleGroups);
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
    const [year, number] = month.split('-');
    this.setData({
      month, monthText: year + ' 年 ' + Number(number) + ' 月',
      sumIn: roundMoney(sumIn), sumOut: roundMoney(sumOut), sumTransfer: roundMoney(sumTransfer),
      sumInText: formatMoney(sumIn), sumOutText: formatMoney(sumOut), sumTransferText: formatMoney(sumTransfer),
      filters, groups: listGroups, groupTotal: shown.length, hasMore: shown.length > listGroups.length,
      accounts, accountOverview: ledger.overview,
      billAlerts: buildBillAlerts(state.records.accounts || {}, state.records.money || {}, new Date()),
      accountOptions, transferAccounts: ledger.list.map((account) => ({ id: account.id, name: account.name, kind: account.kind })),
      offline: state.syncState === 'offline',
      billReminder: reminderClient.buildReminderView(state.records, 'bill', this.reminderCaps),
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
    this.render();
  },
  /* 筛选/切月/切视图时回到首批，避免「换了条件却还停在很深的页码」 */
  resetListPage() { this.visibleGroups = MONEY_LIST_PAGE_GROUPS; },
  shiftMonth(offset) {
    const [year, month] = this.data.month.split('-').map(Number);
    const target = new Date(year, month - 1 + offset, 1);
    this.setData({ month: target.getFullYear() + '-' + String(target.getMonth() + 1).padStart(2, '0'), filter: '', dayFilter: '' });
    this.resetListPage();
    this.render();
  },
  setFilter(event) {
    this.setData({ filter: event.currentTarget.dataset.cat === this.data.filter ? '' : event.currentTarget.dataset.cat });
    this.resetListPage();
    this.render();
  },
  goReport() { wx.navigateTo({ url: '/pages/report/report' }); },

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
  openAdd() {
    const form = transactionForm(sync.fmtDate(new Date()));
    this.setData({ sheetShow: true, cats: this.categoryChoices('expense'), form: this.namedForm(form) });
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
    this.setData({ sheetShow: true, cats: this.categoryChoices(type, form.category), form });
  },
  /* 搜索页/今日页深链中转：写入方经 utils/pending-open，这里消费后打开对应流水 */
  consumePendingOpen() {
    const id = consumePendingOpenStorage('money');
    if (!id) return;
    this.openEditById(id);
  },
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
  closeSheet() { if (!this.data.saving) this.setData({ sheetShow: false }); },
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
    if (!(amount > 0)) return wx.showToast({ title: '请输入正确金额', icon: 'none' });
    if (!form.date) return wx.showToast({ title: '请选择日期', icon: 'none' });
    const type = ['income', 'expense', 'transfer'].includes(form.type) ? form.type : 'expense';
    if (type === 'transfer' && (!form.accountId || !form.toAccountId || form.accountId === form.toAccountId)) return wx.showToast({ title: '请选择不同的转出和转入账户', icon: 'none' });
    const data = { type, amount, category: type === 'transfer' ? TRANSFER_CATEGORY : form.category, date: form.date, note: String(form.note || '').trim() };
    if (form.accountId) data.accountId = form.accountId;
    if (type === 'transfer') data.toAccountId = form.toAccountId;
    if (ui.isRepeatedTap(this, 'money-save', 600)) return;
    this.setData({ saving: true });
    sync.upsert('money', data, form.id || undefined);
    this.setData({ sheetShow: false, saving: false });
    ui.completeFeedback({ toast: type === 'transfer' ? '转账已记下' : '已记下' });
  },

  openAccountAdd() { this.setData({ accountSheetShow: true, accountForm: accountForm() }); },
  selectAccountPreset(event) {
    const item = event.currentTarget.dataset;
    this.setData({ 'accountForm.name': item.name, 'accountForm.kind': item.kind, 'accountForm.category': item.category });
  },
  /* 点账户行直接打开编辑弹层；删除移到弹层内（见 removeAccount） */
  openAccountEdit(event) {
    const id = event.currentTarget.dataset.id;
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
    if (ui.isRepeatedTap(this, 'account-save', 600)) return;
    this.setData({ saving: true });
    sync.upsert('accounts', data, form.id || undefined);
    this.setData({ accountSheetShow: false, saving: false });
    ui.completeFeedback({ toast: '账户已更新' });
  }
});
