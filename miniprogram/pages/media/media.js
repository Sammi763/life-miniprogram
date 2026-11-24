const store = require('../../utils/store');
const sync = require('../../utils/sync');
const ui = require('../../utils/ui');
const { buildTextAvatar } = require('../../utils/text-avatar');
const theme = require('../../utils/theme');
const share = require('../../utils/share');

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
/* 工具栏的状态筛选：把「全部状态」与 STATUSES 合并成一组 chips */
const STATUS_FILTERS = [{ key: '', label: '全部状态' }].concat(STATUSES);
const STARS = [1, 2, 3, 4, 5];
/*
 * 分批渲染：卡片墙与列表共用同一份 items，按「累计条数」分批下发，
 * 与随记时间线 v2.6 同一模式；年度统计始终按筛选前全量计算。
 */
const MEDIA_PAGE_SIZE = 40;

function typeLabel(kind) {
  return ({ book: '书', movie: '影', music: '音' })[kind] || '藏';
}

Page({
  data: {
    offline: false,
    types: TYPES,
    statuses: STATUS_FILTERS,
    stars: STARS,
    filter: '',
    statusFilter: '',
    viewMode: 'grid',
    items: [],
    hasMore: false,
    shownTotal: 0,
    stats: { book: 0, movie: 0, music: 0, average: '—' },
    today: '',
    sheetShow: false,
    saving: false,
    undoShow: false,
    form: { id: '', kind: 'book', title: '', status: 'wishlist', rating: 0, comment: '', date: '' }
  },
  unsub: null,
  /* 已下发的条数上限；只在筛选 chips 变化时回到首批，同步拉取不重置它 */
  visibleCount: MEDIA_PAGE_SIZE,

  onLoad(options) {
    theme.applyToPage(this);
    this.unsub = ui.bindStore(this, ['media', '__sync__'],
      () => this.render(),
      () => this.renderSyncState());
    this.render();
    this.setData({ today: sync.fmtDate(new Date()) });
    /* 搜索页深链：直接打开对应收藏的编辑弹层 */
    if (options && options.id) this.openEditById(options.id);
  },
  onShow() { this.__pageHidden = false; theme.applyToPage(this); share.enableShareMenu(); this.render(); },
  onShareAppMessage: share.onShareAppMessage('media'),
  onShareTimeline: share.onShareTimeline('media'),
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
    const shown = records
      .filter((item) => !this.data.filter || item.kind === this.data.filter)
      .filter((item) => !this.data.statusFilter || item.status === this.data.statusFilter);
    const finishedThisYear = records.filter((item) => item.status === 'done' && item.date.slice(0, 4) === year);
    const rated = finishedThisYear.filter((item) => item.rating > 0);
    /* 分批下发：只裁剪 items 载荷；年度统计仍按全量计算 */
    const visibleCount = Math.max(MEDIA_PAGE_SIZE, Number(this.visibleCount) || 0);
    const listItems = shown.slice(0, visibleCount);
    this.setData({
      offline: store.state.syncState === 'offline',
      items: listItems,
      hasMore: shown.length > listItems.length,
      shownTotal: shown.length,
      stats: {
        book: finishedThisYear.filter((item) => item.kind === 'book').length,
        movie: finishedThisYear.filter((item) => item.kind === 'movie').length,
        music: finishedThisYear.filter((item) => item.kind === 'music').length,
        average: rated.length ? (rated.reduce((sum, item) => sum + item.rating, 0) / rated.length).toFixed(1) : '—'
      }
    });
  },

  /* 滚到底自动加载更多；底部按钮保留作为兜底 */
  onReachBottom() { if (this.data.hasMore) this.loadMore(); },
  loadMore() {
    this.visibleCount = (Number(this.visibleCount) || MEDIA_PAGE_SIZE) + MEDIA_PAGE_SIZE;
    this.render();
  },
  /* 筛选条件变化时回到首批 */
  resetListPage() { this.visibleCount = MEDIA_PAGE_SIZE; this.render(); },

  setFilter(event) { this.setData({ filter: event.currentTarget.dataset.kind }); this.resetListPage(); },
  setStatusFilter(event) {
    const status = event.currentTarget.dataset.status;
    this.setData({ statusFilter: status === this.data.statusFilter ? '' : status });
    this.resetListPage();
  },
  setView(event) { this.setData({ viewMode: event.currentTarget.dataset.mode }); },
  openAdd() {
    this.setData({
      sheetShow: true,
      form: { id: '', kind: 'book', title: '', status: 'wishlist', rating: 0, comment: '', date: this.data.today || sync.fmtDate(new Date()) }
    });
  },
  openEdit(event) { this.openEditById(event.currentTarget.dataset.id); },
  openEditById(id) {
    const record = store.state.records.media[id];
    if (!record || record.deletedAt || !record.data) return;
    this.setData({ sheetShow: true, form: {
      id,
      kind: record.data.kind || 'book',
      title: record.data.title || '',
      status: record.data.status || 'wishlist',
      rating: Number(record.data.rating) || 0,
      comment: record.data.comment || '',
      date: record.data.date || this.data.today || sync.fmtDate(new Date())
    } });
  },
  closeSheet() { if (!this.data.saving) this.setData({ sheetShow: false }); },
  noop() { },
  setKind(event) { this.setData({ 'form.kind': event.currentTarget.dataset.kind }); },
  setStatus(event) { this.setData({ 'form.status': event.currentTarget.dataset.status }); },
  /* 点当前星级取消评分（回到 0 星），选错可以修正 */
  setRating(event) {
    const value = Number(event.currentTarget.dataset.rating);
    this.setData({ 'form.rating': value === this.data.form.rating ? 0 : value });
  },
  onTitle(event) { this.setData({ 'form.title': event.detail.value }); },
  onComment(event) { this.setData({ 'form.comment': event.detail.value }); },
  onDate(event) { this.setData({ 'form.date': event.detail.value }); },
  save() {
    const form = this.data.form;
    const title = String(form.title || '').trim();
    if (!title) return wx.showToast({ title: '请填写标题', icon: 'none' });
    if (title.length > 60) return wx.showToast({ title: '标题最多 60 个字', icon: 'none' });
    if (String(form.comment || '').length > 100) return wx.showToast({ title: '短评最多 100 个字', icon: 'none' });
    if (ui.isRepeatedTap(this, 'media-save', 800)) return;
    this.setData({ saving: true });
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
    ui.completeFeedback({ toast: '已收藏' });
  },
  /* 删除立即执行 + 5 秒撤销条，不再弹确认窗 */
  remove(event) {
    const id = event.currentTarget.dataset.id;
    const record = store.state.records.media[id];
    if (!record || record.deletedAt || !record.data) return;
    const undoData = record.data;
    sync.remove('media', id);
    ui.armUndo(this, {
      onUndo: () => {
        sync.upsert('media', undoData, id);
        wx.showToast({ title: '已恢复', icon: 'success' });
      }
    });
  },
  onUndoTap() { ui.performUndo(this); }
});
