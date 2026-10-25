const store = require('../../utils/store');
const ui = require('../../utils/ui');
const { searchAll, splitHighlight } = require('../../utils/search-utils');
const { setPendingOpen } = require('../../utils/pending-open');
const theme = require('../../utils/theme');

const FILTERS = [
  { key: '', label: '全部' }, { key: 'memory', label: '随记' }, { key: 'plan', label: '日程' },
  { key: 'shopping', label: '待买' }, { key: 'media', label: '书影音' }, { key: 'money', label: '账本' }
];
const KIND_LABELS = Object.fromEntries(FILTERS.map((item) => [item.key, item.label]));
const HISTORY_KEY = 'wb_life_search_history';
const HISTORY_MAX = 10;
/* 一次性最多下发的结果条数：本地数据大时避免撑爆单次 setData */
const RESULT_LIMIT = 100;

function readHistory() {
  try {
    const raw = wx.getStorageSync(HISTORY_KEY);
    return Array.isArray(raw) ? raw.slice(0, HISTORY_MAX) : [];
  } catch (error) { return []; }
}
function saveHistory(list) {
  try { wx.setStorageSync(HISTORY_KEY, list.slice(0, HISTORY_MAX)); } catch (error) { /* best effort */ }
}

Page({
  data: {
    keyword: '',
    kind: '',
    filters: FILTERS,
    results: [],
    resultTotal: 0,
    resultsTruncated: false,
    searched: false,
    history: []
  },
  unsub: null,
  searchTimer: null,
  onLoad(options) {
    theme.applyToPage(this);
    this.setData({ kind: options && options.kind === 'memory' ? 'memory' : '', history: readHistory() });
    this.unsub = store.subscribe(() => this.render());
  },
  onShow() { theme.applyToPage(this); },
  onUnload() {
    this.unsub && this.unsub();
    clearTimeout(this.searchTimer);
  },
  render() {
    const keyword = String(this.data.keyword || '').trim();
    if (!keyword) {
      this.setData({ results: [], resultTotal: 0, resultsTruncated: false, searched: false });
      return;
    }
    const source = {};
    for (const collection of ['memories', 'plan', 'shopping', 'media', 'money']) {
      source[collection] = Object.values(store.state.records[collection] || {}).filter((record) => !record.deletedAt && record.data);
    }
    const all = searchAll(source, { keyword, kind: this.data.kind })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const results = all.slice(0, RESULT_LIMIT).map((item) => ({
      ...item,
      kindText: KIND_LABELS[item.kind] || item.kind,
      titleSegs: splitHighlight(item.title, keyword),
      subtitleSegs: item.subtitle ? splitHighlight(item.subtitle, keyword) : []
    }));
    this.setData({
      results,
      resultTotal: all.length,
      resultsTruncated: all.length > RESULT_LIMIT,
      searched: true
    });
  },
  /* 输入防抖 300ms：每个按键都全量检索会在记录多时明显卡顿 */
  onKeyword(event) {
    this.setData({ keyword: event.detail.value });
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.render(), 300);
  },
  onConfirm() { clearTimeout(this.searchTimer); this.render(); },
  setKind(event) { this.setData({ kind: event.currentTarget.dataset.kind }); this.render(); },
  clearKeyword() { this.setData({ keyword: '' }); clearTimeout(this.searchTimer); this.render(); },
  rememberHistory(keyword) {
    const keywordText = String(keyword || '').trim();
    if (!keywordText) return;
    const next = [keywordText].concat(readHistory().filter((item) => item !== keywordText)).slice(0, HISTORY_MAX);
    saveHistory(next);
    this.setData({ history: next });
  },
  onHistoryTap(event) {
    const keyword = event.currentTarget.dataset.keyword;
    this.setData({ keyword });
    this.render();
  },
  clearHistory() { saveHistory([]); this.setData({ history: [] }); },
  openResult(event) {
    const kind = event.currentTarget.dataset.kind;
    const id = event.currentTarget.dataset.id;
    /* 节流按条目区分：双击同一条只开一次，快速浏览不同结果不受影响 */
    if (ui.isRepeatedTap(this, 'search-open-' + kind + '-' + id, 400)) return;
    const item = this.data.results.find((result) => result.id === id && result.kind === kind);
    if (!item) return;
    this.rememberHistory(this.data.keyword);
    if (item.kind === 'memory') return wx.navigateTo({ url: '/pages/memory/memory?id=' + encodeURIComponent(item.id) });
    /* money 是 tab 页带不了参数：经 storage 中转，money onShow 打开对应流水编辑 */
    if (item.kind === 'money') {
      setPendingOpen('money', item.id);
      return wx.switchTab({ url: '/pages/money/money' });
    }
    if (item.kind === 'plan') return wx.navigateTo({ url: '/pages/plan/plan?id=' + encodeURIComponent(item.id) });
    if (item.kind === 'shopping') return wx.navigateTo({ url: '/pages/shopping/shopping?id=' + encodeURIComponent(item.id) });
    if (item.kind === 'media') return wx.navigateTo({ url: '/pages/media/media?id=' + encodeURIComponent(item.id) });
  }
});
