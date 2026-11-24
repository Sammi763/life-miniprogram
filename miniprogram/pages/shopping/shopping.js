const store = require('../../utils/store');
const sync = require('../../utils/sync');
const ui = require('../../utils/ui');
const theme = require('../../utils/theme');
const share = require('../../utils/share');
// 金额显示统一走 finance.formatMoney：此前这里写死 toFixed(2)，同屏会出现 ¥143.50 与 ¥54.5 两种写法
const { toCents, fromCents, parseMoneyInput, amountError, moneyInputText } = require('../../utils/amount');
const { formatMoney } = require('../../utils/finance');
const { buildCategoryList } = require('../../utils/category-utils');
const { setPendingOpen } = require('../../utils/pending-open');

function emptyForm() {
  return { id: '', name: '', note: '', price: '', link: '', done: false, pinned: false };
}

/* 已买列表分批下发（性能方案 §5）：待买全量下发，已买按批追加，避免积压老物落后单次载荷过大 */
const DONE_PAGE_SIZE = 50;

Page({
  data: {
    offline: false,
    total: 0,
    completedCount: 0,
    completedAmountText: '0',
    pendingItems: [],
    doneItems: [],
    showDone: true,
    sheetShow: false,
    saving: false,
    undoShow: false,
    undoText: '物品已删除',
    advanced: false,
    form: emptyForm(),
    /* U13：完成待买时可选记账 —— 确认实际金额，经 shoppingId 来源关联防止重复 */
    ledgerSheetShow: false,
    ledgerForm: { id: '', name: '', amount: '', category: '居家用品' },
    ledgerCategories: []
  },
  unsub: null,

  onLoad(options) {
    theme.applyToPage(this);
    this.unsub = ui.bindStore(this, ['shopping', 'money', '__sync__'],
      () => this.render(),
      () => this.renderSyncState());
    this.render();
    /* 搜索深链：直接打开对应物品编辑 */
    if (options && options.id) {
      this.openEditById(options.id);
      return;
    }
    /* U01 一次性新增意图：今日页「待买物品」直达新增表单 */
    if (options && options.create === '1') this.openAdd();
  },
  onShow() { this.__pageHidden = false; theme.applyToPage(this); share.enableShareMenu(); this.render(); },
  onShareAppMessage: share.onShareAppMessage('shopping'),
  onShareTimeline: share.onShareTimeline('shopping'),
  onHide() { this.__pageHidden = true; },
  onUnload() {
    this.unsub && this.unsub();
    clearTimeout(this.__undoTimer);
  },
  /* 同步状态变化只更新状态横幅，不做整页重算（性能方案 §5） */
  renderSyncState() {
    ui.diffSetData(this, { offline: store.state.syncState === 'offline' });
  },
  retrySync() { return ui.retryWithFeedback(() => sync.pull()); },
  onPullDownRefresh() {
    sync.pull().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },

  render() {
    const linked = new Set(Object.values(store.state.records.money)
      .filter((record) => !record.deletedAt && record.data && record.data.shoppingId)
      .map((record) => record.data.shoppingId));
    const items = Object.values(store.state.records.shopping)
      .filter((record) => !record.deletedAt && record.data && record.data.name)
      .map((record) => ({
        id: record.id,
        name: String(record.data.name),
        note: record.data.note || '',
        priceCents: Math.max(0, toCents(record.data.price) || 0),
        priceText: toCents(record.data.price) > 0 ? '¥' + formatMoney(record.data.price) : '',
        link: record.data.link || '',
        done: !!record.data.done,
        hasLedger: linked.has(record.id),
        updatedAt: record.updatedAt || 0
      }))
      .sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return a.done ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt;
      });
    const completed = items.filter((item) => item.done);
    const visibleDone = Math.max(DONE_PAGE_SIZE, Number(this.visibleDone) || 0);
    ui.diffSetData(this, {
      offline: store.state.syncState === 'offline',
      total: items.length - completed.length,
      completedCount: completed.length,
      completedAmountText: formatMoney(fromCents(completed.reduce((sum, item) => sum + item.priceCents, 0))),
      pendingItems: items.filter((item) => !item.done),
      doneItems: completed.slice(0, visibleDone),
      hasMoreDone: completed.length > visibleDone
    });
  },
  loadMoreDone() {
    this.visibleDone = (Number(this.visibleDone) || DONE_PAGE_SIZE) + DONE_PAGE_SIZE;
    this.render();
  },
  toggleDoneGroup() { this.setData({ showDone: !this.data.showDone }); },

  openAdd() {
    this.setData({ sheetShow: true, advanced: false, form: emptyForm() });
  },
  openEdit(event) { this.openEditById(event.currentTarget.dataset.id); },
  openEditById(id) {
    const record = store.state.records.shopping[id];
    if (!record || record.deletedAt || !record.data) return;
    const form = {
      id,
      name: record.data.name || '',
      note: record.data.note || '',
      price: record.data.price ? String(record.data.price) : '',
      link: record.data.link || '',
      done: !!record.data.done,
      pinned: Boolean(record.data.pinned)
    };
    /* 编辑时若高级字段有值，直接展开，避免用户以为内容丢了 */
    this.setData({ sheetShow: true, advanced: Boolean(form.link || form.done || form.pinned), form });
  },
  closeSheet() { if (!this.data.saving) this.setData({ sheetShow: false }); },
  toggleAdvanced() { this.setData({ advanced: !this.data.advanced }); },
  noop() { },
  onName(event) { this.setData({ 'form.name': event.detail.value }); },
  onNote(event) { this.setData({ 'form.note': event.detail.value }); },
  onMoneyBlur(event) {
    const { path, negative, positive } = event.currentTarget.dataset;
    const value = event.detail.value;
    this.setData({ [path]: moneyInputText(value, negative, positive) });
  },
  onPrice(event) { this.setData({ 'form.price': event.detail.value }); },
  onLink(event) { this.setData({ 'form.link': event.detail.value }); },
  onDone(event) { this.setData({ 'form.done': !!event.detail.value }); },
  onPinned(event) { this.setData({ 'form.pinned': !!event.detail.value }); },
  /* 商品链接：读剪贴板一键填充 */
  pasteLink() {
    wx.getClipboardData({
      success: (result) => {
        const link = String(result.data || '').trim();
        if (!link) return wx.showToast({ title: '剪贴板是空的', icon: 'none' });
        this.setData({ 'form.link': link });
        wx.showToast({ title: '已粘贴', icon: 'success' });
      },
      fail: () => wx.showToast({ title: '无法读取剪贴板', icon: 'none' })
    });
  },
  save() {
    const form = this.data.form;
    const name = String(form.name || '').trim();
    const price = parseMoneyInput(form.price);
    if (!name) return wx.showToast({ title: '请填写物品名称', icon: 'none' });
    if (name.length > 30) return wx.showToast({ title: '名称最多 30 个字', icon: 'none' });
    if (price < 0 || price > 100000000 || !Number.isFinite(price)) return wx.showToast({ title: '预估价格式不正确', icon: 'none' });
    const data = {
      name,
      note: String(form.note || '').trim(),
      price,
      link: String(form.link || '').trim(),
      done: !!form.done
    };
    if (form.pinned) data.pinned = true;
    if (ui.isRepeatedTap(this, 'shopping-save', 600)) return;
    this.setData({ saving: true });
    sync.upsert('shopping', data, form.id || undefined);
    this.setData({ sheetShow: false, saving: false });
    ui.completeFeedback({ toast: '已保存' });
  },
  toggle(event) {
    const id = event.currentTarget.dataset.id;
    const record = store.state.records.shopping[id];
    if (!record || record.deletedAt) return;
    if (ui.isRepeatedTap(this, 'shopping-toggle-' + id, 400)) return;
    if (record.data.done) {
      sync.upsert('shopping', { ...record.data, done: false }, id);
      return;
    }
    sync.upsert('shopping', { ...record.data, done: true }, id);
    ui.completeFeedback({});
    if (!this.findLedger(id)) this.openLedgerSheet(id, record.data);
  },
  findLedger(id) {
    return Object.values(store.state.records.money).find((record) =>
      !record.deletedAt && record.data && record.data.shoppingId === id);
  },
  onLedgerAction(event) {
    const { id } = event.currentTarget.dataset;
    const shopping = store.state.records.shopping[id];
    if (!shopping || shopping.deletedAt || !shopping.data.done) return;
    const ledger = this.findLedger(id);
    if (!ledger) return this.openLedgerSheet(id, shopping.data);
    setPendingOpen('money', ledger.id);
    wx.switchTab({ url: '/pages/money/money' });
  },
  buyAgain(event) {
    const { id } = event.currentTarget.dataset;
    const shopping = store.state.records.shopping[id];
    if (!shopping || shopping.deletedAt || !shopping.data.done) return;
    if (ui.isRepeatedTap(this, 'shopping-buy-again-' + id, 600)) return;
    const { name, note = '', price = 0, link = '' } = shopping.data;
    sync.upsert('shopping', { name, note, price, link, done: false });
    ui.completeFeedback({ toast: '已加入待买' });
  },
  openLedgerSheet(id, data) {
    const categories = buildCategoryList(store.state.records.settings.app, store.state.records.money, { type: 'expense' });
    if (!categories.length) categories.push('其他');
    this.setData({
      ledgerSheetShow: true,
      ledgerCategories: categories,
      ledgerForm: {
        id, name: String(data.name || ''), amount: Number(data.price) > 0 ? String(data.price) : '',
        category: categories.includes('居家用品') ? '居家用品' : categories[0]
      }
    });
  },
  closeLedgerSheet() { this.setData({ ledgerSheetShow: false }); },
  onLedgerAmount(event) { this.setData({ 'ledgerForm.amount': event.detail.value }); },
  onLedgerCategory(event) { this.setData({ 'ledgerForm.category': event.currentTarget.dataset.cat }); },
  /* 确认记账：来源关联（shoppingId）去重 —— 同一待买只生成一笔账目 */
  confirmLedger() {
    const form = this.data.ledgerForm;
    const amount = parseMoneyInput(form.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) {
      return wx.showToast({ title: amountError(form.amount, amount), icon: 'none' });
    }
    if (ui.isRepeatedTap(this, 'shopping-ledger', 600)) return;
    this.setData({ ledgerSheetShow: false });
    const shopping = store.state.records.shopping[form.id];
    if (!shopping || shopping.deletedAt || !shopping.data.done) {
      return wx.showToast({ title: '标记买到后即可记账', icon: 'none' });
    }
    if (this.findLedger(form.id)) return wx.showToast({ title: '这笔已有关联账目，未重复记账', icon: 'none' });
    // 使用同一个物品 ID，在不同设备首次补记时也只创建一条流水。
    const reserved = store.state.records.money[form.id];
    if (reserved && reserved.data.shoppingId !== form.id) {
      return wx.showToast({ title: '这条物品无法关联账目，请到记账页手动记录', icon: 'none' });
    }
    sync.upsert('money', {
      type: 'expense', amount, category: form.category,
      date: sync.fmtDate(new Date()), note: '待买 · ' + form.name, shoppingId: form.id
    }, form.id, { createOnly: !reserved });
    ui.completeFeedback({ toast: '已记入账本' });
  },
  /* 删除立即执行 + 5 秒撤销条 */
  remove(event) {
    const id = event.currentTarget.dataset.id;
    const record = store.state.records.shopping[id];
    if (!record || record.deletedAt || !record.data) return;
    const undoData = record.data;
    sync.remove('shopping', id);
    ui.armUndo(this, {
      text: '物品已删除',
      onUndo: () => {
        sync.upsert('shopping', undoData, id);
        wx.showToast({ title: '已恢复', icon: 'success' });
      }
    });
  },
  /* 清空已买同样走撤销：整批恢复，比确认弹窗更从容 */
  clearDone() {
    if (!this.data.completedCount) return wx.showToast({ title: '没有已买项目', icon: 'none' });
    const removed = [];
    Object.values(store.state.records.shopping).forEach((record) => {
      if (!record.deletedAt && record.data && record.data.done) removed.push({ id: record.id, data: record.data });
    });
    if (!removed.length) return;
    removed.forEach((item) => sync.remove('shopping', item.id));
    ui.armUndo(this, {
      text: '已清空 ' + removed.length + ' 件已买',
      onUndo: () => {
        removed.forEach((item) => sync.upsert('shopping', item.data, item.id));
        wx.showToast({ title: '已恢复', icon: 'success' });
      }
    });
  },
  onUndoTap() { ui.performUndo(this); },
  copyLink(event) {
    const link = event.currentTarget.dataset.link;
    if (!link) return;
    wx.setClipboardData({ data: link, success: () => wx.showToast({ title: '链接已复制', icon: 'none' }) });
  }
});
