const store = require('../../utils/store');
const ui = require('../../utils/ui');
const { searchAll, splitHighlight } = require('../../utils/search-utils');
const { setPendingOpen, ACTIONS } = require('../../utils/pending-open');
const { addDays, formatDate, parseDate } = require('../../utils/plan-utils');
const { rememberSearch, consumeSearch } = require('../../utils/search-return');
const theme = require('../../utils/theme');

/* U07 范围补全：习惯打卡与体重/热量记录纳入检索 */
const FILTERS = [
  { key: '', label: '全部' }, { key: 'memory', label: '随记' }, { key: 'plan', label: '日程' },
  { key: 'shopping', label: '待买' }, { key: 'media', label: '书影音' }, { key: 'money', label: '账本' },
  { key: 'habit', label: '习惯' }, { key: 'fitness', label: '体重' }
];
const KIND_LABELS = Object.fromEntries(FILTERS.map((item) => [item.key, item.label]));
const SEARCH_COLLECTIONS = ['memories', 'plan', 'shopping', 'media', 'money', 'habit', 'fitness'];
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
    dateMode: '',
    selectedDate: '',
    today: '',
    results: [],
    resultTotal: 0,
    resultsTruncated: false,
    searched: false,
    history: []
  },
  unsub: null,
  searchTimer: null,
  /* 结果分批下发（U07）：第 101 条及更早结果通过「加载更多」可及 */
  visibleResults: RESULT_LIMIT,
  onLoad(options) {
    theme.applyToPage(this);
    const saved = options && options.resume === '1' ? consumeSearch() : null;
    if (saved) this.visibleResults = saved.visibleResults;
    this.setData({
      kind: options && options.kind === 'memory' ? 'memory' : '',
      ...(saved ? saved.data : {}),
      history: readHistory()
    });
    this.unsub = ui.bindStore(this, SEARCH_COLLECTIONS, () => this.render());
  },
  onShow() {
    this.__pageHidden = false;
    theme.applyToPage(this);
    this.setData({ today: formatDate(new Date()) });
    this.render();
  },
  onHide() { this.__pageHidden = true; },
  onUnload() {
    this.unsub && this.unsub();
    clearTimeout(this.searchTimer);
  },
  render() {
    const keyword = String(this.data.keyword || '').trim();
    const { dateMode, selectedDate, today } = this.data;
    const end = dateMode === 'custom' ? selectedDate : dateMode ? today : '';
    const start = dateMode === 'week' ? addDays(end, -6) : end;
    if (!keyword && !end) {
      this.setData({ results: [], resultTotal: 0, resultsTruncated: false, searched: false });
      return;
    }
    const source = {};
    for (const collection of SEARCH_COLLECTIONS) {
      source[collection] = Object.values(store.state.records[collection] || {}).filter((record) => !record.deletedAt && record.data);
    }
    const all = searchAll(source, { keyword, kind: this.data.kind, start, end })
      .sort((a, b) => (end ? b.date.localeCompare(a.date) : 0) || b.updatedAt - a.updatedAt);
    const limit = Math.max(RESULT_LIMIT, Number(this.visibleResults) || 0);
    const results = all.slice(0, limit).map((item) => ({
      ...item,
      kindText: KIND_LABELS[item.kind] || item.kind,
      titleSegs: splitHighlight(item.title, keyword),
      subtitleSegs: item.subtitle ? splitHighlight(item.subtitle, keyword) : []
    }));
    this.setData({
      results,
      resultTotal: all.length,
      resultsTruncated: all.length > limit,
      searched: true
    });
  },
  loadMoreResults() {
    this.visibleResults = (Number(this.visibleResults) || RESULT_LIMIT) + RESULT_LIMIT;
    this.render();
  },
  /* 输入防抖 300ms：每个按键都全量检索会在记录多时明显卡顿 */
  onKeyword(event) {
    this.setData({ keyword: event.detail.value });
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.render(), 300);
  },
  onConfirm() { clearTimeout(this.searchTimer); this.render(); },
  setKind(event) {
    this.setData({ kind: event.currentTarget.dataset.kind });
    this.visibleResults = RESULT_LIMIT; // 换范围回到第一批
    this.render();
  },
  setDateMode(event) {
    const mode = event.currentTarget.dataset.mode;
    this.setData({ dateMode: mode === this.data.dateMode ? '' : mode });
    this.visibleResults = RESULT_LIMIT;
    this.render();
  },
  selectDate(event) {
    if (!parseDate(event.detail.value)) return;
    this.setData({ dateMode: 'custom', selectedDate: event.detail.value });
    this.visibleResults = RESULT_LIMIT;
    this.render();
  },
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
    const { key, kind, id } = event.currentTarget.dataset;
    const item = this.data.results.find((result) => key ? result.key === key : result.id === id && result.kind === kind);
    if (!item || ui.isRepeatedTap(this, 'search-open-' + (item.key || item.kind + '-' + item.id), 400)) return;
    this.rememberHistory(this.data.keyword);
    if (item.kind === 'memory') return wx.navigateTo({ url: '/pages/memory/memory?id=' + encodeURIComponent(item.id) });
    if (item.kind === 'money' || item.kind === 'habit') {
      const { keyword, kind, dateMode, selectedDate } = this.data;
      rememberSearch({ keyword, kind, dateMode, selectedDate }, this.visibleResults);
      setPendingOpen(item.kind, item.id, ACTIONS.SEARCH);
      return wx.switchTab({ url: '/pages/' + item.kind + '/' + item.kind });
    }
    if (item.kind === 'plan') {
      const date = item.occurrenceDate ? '&date=' + encodeURIComponent(item.occurrenceDate) : '';
      return wx.navigateTo({ url: '/pages/plan/plan?id=' + encodeURIComponent(item.id) + date });
    }
    if (item.kind === 'shopping') return wx.navigateTo({ url: '/pages/shopping/shopping?id=' + encodeURIComponent(item.id) });
    if (item.kind === 'media') return wx.navigateTo({ url: '/pages/media/media?id=' + encodeURIComponent(item.id) });
    if (item.kind === 'fitness') return wx.navigateTo({ url: '/pages/fitness/fitness?id=' + encodeURIComponent(item.id) });
  }
});
