const store = require('../../utils/store');
const sync = require('../../utils/sync');
const theme = require('../../utils/theme');

Page({
  data: {
    offline: false,
    total: 0,
    completedCount: 0,
    completedAmount: 0,
    items: [],
    sheetShow: false,
    form: { id: '', name: '', note: '', price: '', link: '', done: false, pinned: false }
  },
  unsub: null,

  onLoad() {
    theme.applyToPage(this);
    this.unsub = store.subscribe(() => this.render());
    this.render();
  },
  onShow() { theme.applyToPage(this); this.render(); },
  onUnload() { this.unsub && this.unsub(); },
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
        priceText: Number(record.data.price) > 0 ? '¥' + Number(record.data.price).toFixed(2) : '',
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
      total: items.filter((item) => !item.done).length,
      completedCount: completed.length,
      completedAmount: completed.reduce((sum, item) => sum + item.price, 0),
      items
    });
  },

  openAdd() {
    this.setData({ sheetShow: true, form: { id: '', name: '', note: '', price: '', link: '', done: false, pinned: false } });
  },
  openEdit(event) {
    const id = event.currentTarget.dataset.id;
    const record = store.state.records.shopping[id];
    if (!record || record.deletedAt || !record.data) return;
    this.setData({ sheetShow: true, form: {
      id,
      name: record.data.name || '',
      note: record.data.note || '',
      price: record.data.price ? String(record.data.price) : '',
      link: record.data.link || '',
      done: !!record.data.done,
      pinned: Boolean(record.data.pinned)
    } });
  },
  closeSheet() { this.setData({ sheetShow: false }); },
  noop() { },
  onName(event) { this.setData({ 'form.name': event.detail.value }); },
  onNote(event) { this.setData({ 'form.note': event.detail.value }); },
  onPrice(event) { this.setData({ 'form.price': event.detail.value }); },
  onLink(event) { this.setData({ 'form.link': event.detail.value }); },
  onDone(event) { this.setData({ 'form.done': !!event.detail.value }); },
  onPinned(event) { this.setData({ 'form.pinned': !!event.detail.value }); },
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
    sync.upsert('shopping', data, form.id || undefined);
    this.setData({ sheetShow: false });
  },
  toggle(event) {
    const id = event.currentTarget.dataset.id;
    const record = store.state.records.shopping[id];
    if (record && !record.deletedAt) sync.upsert('shopping', { ...record.data, done: !record.data.done }, id);
  },
  remove(event) {
    const id = event.currentTarget.dataset.id;
    const record = store.state.records.shopping[id];
    if (!record || record.deletedAt) return;
    wx.showModal({
      title: '删除这件物品？', content: record.data.name, confirmColor: '#C0392B',
      success: (result) => { if (result.confirm) sync.remove('shopping', id); }
    });
  },
  clearDone() {
    if (!this.data.completedCount) return wx.showToast({ title: '没有已买项目', icon: 'none' });
    wx.showModal({
      title: '清空已买项目？', content: '这些项目会从清单中移除', confirmColor: '#C0392B',
      success: (result) => {
        if (!result.confirm) return;
        Object.values(store.state.records.shopping).forEach((record) => {
          if (!record.deletedAt && record.data && record.data.done) sync.remove('shopping', record.id);
        });
      }
    });
  },
  copyLink(event) {
    const link = event.currentTarget.dataset.link;
    if (!link) return;
    wx.setClipboardData({ data: link, success: () => wx.showToast({ title: '链接已复制', icon: 'none' }) });
  }
});
