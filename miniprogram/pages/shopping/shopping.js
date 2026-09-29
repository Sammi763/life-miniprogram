const store = require('../../utils/store');
const sync = require('../../utils/sync');
const ui = require('../../utils/ui');
const theme = require('../../utils/theme');
const share = require('../../utils/share');
// 金额显示统一走 finance.formatMoney：此前这里写死 toFixed(2)，同屏会出现 ¥143.50 与 ¥54.5 两种写法
const { formatMoney } = require('../../utils/finance');

function emptyForm() {
  return { id: '', name: '', note: '', price: '', link: '', done: false, pinned: false };
}

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
    form: emptyForm()
  },
  unsub: null,

  onLoad(options) {
    theme.applyToPage(this);
    this.unsub = store.subscribe(() => this.render());
    this.render();
    /* 搜索深链：直接打开对应物品编辑 */
    if (options && options.id) this.openEditById(options.id);
  },
  onShow() { theme.applyToPage(this); share.enableShareMenu(); this.render(); },
  onShareAppMessage: share.onShareAppMessage('shopping'),
  onShareTimeline: share.onShareTimeline('shopping'),
  onUnload() {
    this.unsub && this.unsub();
    clearTimeout(this.__undoTimer);
  },
  retrySync() { return ui.retryWithFeedback(() => sync.pull()); },
  onPullDownRefresh() {
    sync.pull().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },

  render() {
    const items = Object.values(store.state.records.shopping)
      .filter((record) => !record.deletedAt && record.data && record.data.name)
      .map((record) => ({
        id: record.id,
        name: String(record.data.name),
        note: record.data.note || '',
        price: Number(record.data.price) > 0 ? Number(record.data.price) : 0,
        priceText: Number(record.data.price) > 0 ? '¥' + formatMoney(Number(record.data.price)) : '',
        link: record.data.link || '',
        done: !!record.data.done,
        updatedAt: record.updatedAt || 0
      }))
      .sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return a.done ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt;
      });
    const completed = items.filter((item) => item.done);
    this.setData({
      offline: store.state.syncState === 'offline',
      total: items.length - completed.length,
      completedCount: completed.length,
      completedAmountText: formatMoney(completed.reduce((sum, item) => sum + item.price, 0)),
      pendingItems: items.filter((item) => !item.done),
      doneItems: completed
    });
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
    const price = form.price === '' ? 0 : Math.round(Number(form.price) * 100) / 100;
    if (!name) return wx.showToast({ title: '请填写物品名称', icon: 'none' });
    if (name.length > 30) return wx.showToast({ title: '名称最多 30 个字', icon: 'none' });
    if (price < 0 || !Number.isFinite(price)) return wx.showToast({ title: '预估价格式不正确', icon: 'none' });
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
    sync.upsert('shopping', { ...record.data, done: !record.data.done }, id);
    if (!record.data.done) ui.completeFeedback({});
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
