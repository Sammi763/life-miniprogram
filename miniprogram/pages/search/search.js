const store = require('../../utils/store');
const { searchAll } = require('../../utils/search-utils');
const theme = require('../../utils/theme');

const FILTERS = [
  { key: '', label: '全部' }, { key: 'memory', label: '随记' }, { key: 'plan', label: '日程' },
  { key: 'shopping', label: '待买' }, { key: 'media', label: '书影音' }, { key: 'money', label: '账本' }
];
const KIND_LABELS = Object.fromEntries(FILTERS.map((item) => [item.key, item.label]));

Page({
  data: { keyword: '', kind: '', filters: FILTERS, results: [], searched: false },
  unsub: null,
  onLoad(options) {
    theme.applyToPage(this);
    this.setData({ kind: options && options.kind === 'memory' ? 'memory' : '' });
    this.unsub = store.subscribe(() => this.render());
    this.render();
  },
  onShow() { theme.applyToPage(this); },
  onUnload() { this.unsub && this.unsub(); },
  render() {
    const source = {};
    for (const collection of ['memories', 'plan', 'shopping', 'media', 'money']) source[collection] = Object.values(store.state.records[collection] || {}).filter((record) => !record.deletedAt && record.data);
    const results = this.data.keyword.trim() ? searchAll(source, { keyword: this.data.keyword, kind: this.data.kind }).map((item) => ({ ...item, kindText: KIND_LABELS[item.kind] || item.kind })) : [];
    this.setData({ results, searched: Boolean(this.data.keyword.trim()) });
  },
  onKeyword(event) { this.setData({ keyword: event.detail.value }); this.render(); },
  setKind(event) { this.setData({ kind: event.currentTarget.dataset.kind }); this.render(); },
  openResult(event) {
    const item = this.data.results.find((result) => result.id === event.currentTarget.dataset.id && result.kind === event.currentTarget.dataset.kind);
    if (!item) return;
    if (item.kind === 'memory') return wx.navigateTo({ url: '/pages/memory/memory?id=' + encodeURIComponent(item.id) });
    if (item.kind === 'money') return wx.switchTab({ url: '/pages/money/money' });
    if (item.kind === 'plan') return wx.navigateTo({ url: '/pages/plan/plan' });
    if (item.kind === 'shopping') return wx.navigateTo({ url: '/pages/shopping/shopping' });
    if (item.kind === 'media') return wx.navigateTo({ url: '/pages/media/media' });
  }
});
