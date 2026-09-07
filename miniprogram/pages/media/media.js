const store = require('../../utils/store');
const sync = require('../../utils/sync');
const { buildTextAvatar } = require('../../utils/text-avatar');
const theme = require('../../utils/theme');

const TYPES = [
  { key: '', label: '全部' },
  { key: 'book', label: '书' },
  { key: 'movie', label: '影' },
  { key: 'music', label: '音' }
];
const STATUSES = [
  { key: 'wishlist', label: '想看' },
  { key: 'doing', label: '在看' },
  { key: 'done', label: '看完' }
];
const STARS = [1, 2, 3, 4, 5];

function typeLabel(kind) {
  return ({ book: '书', movie: '影', music: '音' })[kind] || '藏';
}

Page({
  data: {
    offline: false,
    types: TYPES,
    statuses: STATUSES,
    stars: STARS,
    filter: '',
    viewMode: 'grid',
    items: [],
    stats: { book: 0, movie: 0, music: 0, average: '—' },
    sheetShow: false,
    saving: false,
    form: { id: '', kind: 'book', title: '', status: 'wishlist', rating: 0, comment: '', date: '' }
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
    const year = sync.fmtDate(new Date()).slice(0, 4);
    const records = Object.values(store.state.records.media)
      .filter((record) => !record.deletedAt && record.data && record.data.title)
      .map((record) => {
        const avatar = buildTextAvatar(record.data.title);
        return {
          id: record.id,
          kind: record.data.kind || 'book',
          kindText: typeLabel(record.data.kind),
          title: String(record.data.title),
          status: record.data.status || 'wishlist',
          statusText: (STATUSES.find((item) => item.key === record.data.status) || STATUSES[0]).label,
          rating: Number(record.data.rating) || 0,
          ratingText: '★★★★★'.slice(0, Number(record.data.rating) || 0) + '☆☆☆☆☆'.slice(0, 5 - (Number(record.data.rating) || 0)),
          comment: record.data.comment || '',
          date: record.data.date || '',
          avatarText: avatar.label,
          avatarTone: avatar.tone,
          updatedAt: record.updatedAt || 0
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const shown = this.data.filter ? records.filter((item) => item.kind === this.data.filter) : records;
    const finishedThisYear = records.filter((item) => item.status === 'done' && item.date.slice(0, 4) === year);
    const rated = finishedThisYear.filter((item) => item.rating > 0);
    this.setData({
      offline: store.state.syncState === 'offline',
      items: shown,
      stats: {
        book: finishedThisYear.filter((item) => item.kind === 'book').length,
        movie: finishedThisYear.filter((item) => item.kind === 'movie').length,
        music: finishedThisYear.filter((item) => item.kind === 'music').length,
        average: rated.length ? (rated.reduce((sum, item) => sum + item.rating, 0) / rated.length).toFixed(1) : '—'
      }
    });
  },

  setFilter(event) { this.setData({ filter: event.currentTarget.dataset.kind }); this.render(); },
  setView(event) { this.setData({ viewMode: event.currentTarget.dataset.mode }); },
  openAdd() {
    this.setData({
      sheetShow: true,
      form: { id: '', kind: 'book', title: '', status: 'wishlist', rating: 0, comment: '', date: sync.fmtDate(new Date()) }
    });
  },
  openEdit(event) {
    const id = event.currentTarget.dataset.id;
    const record = store.state.records.media[id];
    if (!record || record.deletedAt || !record.data) return;
    this.setData({ sheetShow: true, form: {
      id,
      kind: record.data.kind || 'book',
      title: record.data.title || '',
      status: record.data.status || 'wishlist',
      rating: Number(record.data.rating) || 0,
      comment: record.data.comment || '',
      date: record.data.date || sync.fmtDate(new Date())
    } });
  },
  closeSheet() { if (!this.data.saving) this.setData({ sheetShow: false }); },
  noop() { },
  setKind(event) { this.setData({ 'form.kind': event.currentTarget.dataset.kind }); },
  setStatus(event) { this.setData({ 'form.status': event.currentTarget.dataset.status }); },
  setRating(event) { this.setData({ 'form.rating': Number(event.currentTarget.dataset.rating) }); },
  onTitle(event) { this.setData({ 'form.title': event.detail.value }); },
  onComment(event) { this.setData({ 'form.comment': event.detail.value }); },
  onDate(event) { this.setData({ 'form.date': event.detail.value }); },
  save() {
    const form = this.data.form;
    const title = String(form.title || '').trim();
    if (!title) return wx.showToast({ title: '请填写标题', icon: 'none' });
    if (title.length > 60) return wx.showToast({ title: '标题最多 60 个字', icon: 'none' });
    if (String(form.comment || '').length > 100) return wx.showToast({ title: '短评最多 100 个字', icon: 'none' });
    this.saveRecord();
  },
  saveRecord() {
    const form = this.data.form;
    sync.upsert('media', {
      kind: form.kind,
      title: String(form.title || '').trim(),
      status: form.status,
      rating: Number(form.rating) || 0,
      comment: String(form.comment || '').trim(),
      date: form.date || sync.fmtDate(new Date())
    }, form.id || undefined);
    this.setData({ sheetShow: false, saving: false });
  },
  remove(event) {
    const id = event.currentTarget.dataset.id;
    const record = store.state.records.media[id];
    if (!record || record.deletedAt) return;
    wx.showModal({
      title: '删除这条收藏？', content: record.data.title, confirmColor: '#C0392B',
      success: (result) => { if (result.confirm) sync.remove('media', id); }
    });
  }
});
