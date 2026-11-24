const store = require('../../utils/store');
const sync = require('../../utils/sync');
const ui = require('../../utils/ui');
const {
  MOODS,
  groupMemoriesByDate,
  makeDraftKey,
  normalizeMemory,
  normalizeTags,
  recordItems
} = require('../../utils/memory-utils');
const theme = require('../../utils/theme');
const share = require('../../utils/share');

const MOOD_OPTIONS = [
  { key: '', label: '不标记' },
  { key: 'happy', label: '开心' },
  { key: 'calm', label: '平静' },
  { key: 'energized', label: '有劲' },
  { key: 'tired', label: '疲惫' },
  { key: 'low', label: '低落' }
];
const MOOD_LABELS = Object.fromEntries(MOOD_OPTIONS.map((item) => [item.key, item.label]));

/*
 * 时间线分批渲染：随记会随使用累积到上千条，一次性把全部内容 setData 给渲染层会撑大
 * 单次数据量（体积过大时小程序会告警并明显掉帧）。这里按「累计条数」分批下发，
 * 顶部统计仍然是筛选后的完整条数与天数，筛选语义不变。
 */
const TIMELINE_PAGE_SIZE = 60;

function pad(value) { return String(value).padStart(2, '0'); }
function nowParts() {
  const date = new Date();
  return { date: sync.fmtDate(date), time: pad(date.getHours()) + ':' + pad(date.getMinutes()) };
}
function emptyForm() {
  const now = nowParts();
  return { id: '', content: '', date: now.date, time: now.time, mood: '', tagsInput: '' };
}
function safeReadDraft(id) {
  try {
    const raw = wx.getStorageSync(makeDraftKey(id));
    return raw && typeof raw === 'object' ? raw : null;
  } catch (error) { return null; }
}
/* 写失败返回 false，调用方决定是否提示 —— 静默失败会让用户以为草稿已保住 */
function safeWriteDraft(id, value) {
  try {
    wx.setStorageSync(makeDraftKey(id), value);
    return true;
  } catch (error) { return false; }
}
function clearDraft(id) {
  try {
    wx.removeStorageSync(makeDraftKey(id));
    return true;
  } catch (error) { return false; }
}
function dateLabel(value) {
  const today = sync.fmtDate(new Date());
  const yesterday = (() => { const date = new Date(); date.setDate(date.getDate() - 1); return sync.fmtDate(date); })();
  if (value === today) return '今天';
  if (value === yesterday) return '昨天';
  return value.slice(5).replace('-', ' 月 ') + ' 日';
}

Page({
  data: {
    offline: false,
    groups: [],
    total: 0,
    dayCount: 0,
    moods: MOOD_OPTIONS,
    tags: [],
    keyword: '',
    selectedMood: '',
    selectedTag: '',
    selectedDate: '',
    composerShow: false,
    form: emptyForm(),
    restoredDraft: false,
    undoShow: false,
    hasMore: false,
    shownCount: 0
  },
  unsub: null,
  draftTimer: null,
  /* 已下发的随记条数上限；只在筛选变化时回到第一批，同步拉取不会重置它 */
  visibleCount: TIMELINE_PAGE_SIZE,

  onLoad(options) {
    this.unsub = ui.bindStore(this, ['memories', '__sync__'],
      () => this.render(),
      () => this.renderSyncState());
    if (options && options.id) this.openEditById(options.id);
    else if (options && options.compose === '1') this.openComposer();
  },
  openDeleted() { wx.navigateTo({ url: '/pages/activity/activity?mode=deleted' }); },

  onShow() { this.__pageHidden = false; theme.applyToPage(this); share.enableShareMenu(); this.render(); },
  onShareAppMessage: share.onShareAppMessage('memory'),
  onShareTimeline: share.onShareTimeline('memory'),
  /* 切后台也提交最后一份草稿：进程被杀时 350ms 定时器不会再跑（R05） */
  onHide() { this.__pageHidden = true; this.commitDraftNow(); },
  onUnload() {
    this.unsub && this.unsub();
    if (this.data.composerShow) this.commitDraftNow();
    clearTimeout(this.draftTimer);
    clearTimeout(this.searchTimer);
    clearTimeout(this.__undoTimer);
  },
  /* 同步状态变化只更新状态横幅，不做整页重算（性能方案 §5） */
  renderSyncState() {
    ui.diffSetData(this, { offline: store.state.syncState === 'offline' });
  },
  retrySync() { return ui.retryWithFeedback(() => sync.pull()); },
  onPullDownRefresh() { sync.pull().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh()); },
  /* 滚到底自动加载更早的随记；底部按钮保留作为兜底 */
  onReachBottom() { if (this.data.hasMore) this.loadMore(); },

  computeTimelineModel() {
    const records = store.state.records.memories;
    const options = {
      keyword: this.data.keyword,
      mood: this.data.selectedMood,
      tag: this.data.selectedTag,
      date: this.data.selectedDate
    };
    const key = JSON.stringify([store.version('memories'), options]);
    const cached = this.__timelineModel;
    if (cached && cached.key === key && cached.records === records) return cached.model;
    const allGroups = groupMemoriesByDate(records, options);
    const total = allGroups.reduce((sum, group) => sum + group.items.length, 0);
    const tagCounts = {};
    recordItems(records).forEach((item) => item.tags.forEach((tag) => { tagCounts[tag] = (tagCounts[tag] || 0) + 1; }));
    const tags = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a] || a.localeCompare(b, 'zh-Hans-CN')).slice(0, 12);
    const model = { allGroups, total, tags };
    this.__timelineModel = { records, key, model };
    return model;
  },

  render() {
    const { allGroups, total, tags } = this.computeTimelineModel();
    /*
     * 按天顺序累计下发，直到用完预算；同一天也可能超过预算，用 slice 截断，
     * 避免「一天写了 200 条」把整天内容一次性推给渲染层。
     */
    let budget = Math.max(TIMELINE_PAGE_SIZE, Number(this.visibleCount) || 0);
    let shown = 0;
    const groups = [];
    for (const group of allGroups) {
      if (budget <= 0) break;
      const items = group.items.slice(0, budget);
      budget -= items.length;
      shown += items.length;
      groups.push({
        ...group,
        label: dateLabel(group.date),
        items: items.map((item) => ({
          ...item,
          time: item.occurredAt.slice(11),
          moodText: MOOD_LABELS[item.mood] || '',
          tagsText: item.tags.join(' · ')
        }))
      });
    }
    ui.diffSetData(this, {
      offline: store.state.syncState === 'offline',
      groups,
      hasMore: shown < total,
      shownCount: shown,
      /* 统计口径保持不变：始终是筛选后的完整条数与天数 */
      total,
      dayCount: allGroups.length,
      tags
    });
  },

  loadMore() {
    this.visibleCount = (Number(this.visibleCount) || TIMELINE_PAGE_SIZE) + TIMELINE_PAGE_SIZE;
    this.render();
  },
  /* 筛选条件变化时回到第一批，避免「换了筛选却还停在很深的页码」 */
  resetTimeline() { this.visibleCount = TIMELINE_PAGE_SIZE; this.render(); },

  openComposer() {
    clearTimeout(this.draftTimer);
    this.draftDirty = false;
    this.draftBaseUpdatedAt = undefined;
    const form = emptyForm();
    const draft = safeReadDraft('new');
    if (draft) {
      const normalized = normalizeMemory(draft);
      if (normalized.content || normalized.occurredAt) {
        const occurredAt = normalized.occurredAt || (form.date + 'T' + form.time);
        form.content = normalized.content;
        form.date = occurredAt.slice(0, 10);
        form.time = occurredAt.slice(11);
        form.mood = normalized.mood;
        form.tagsInput = normalized.tags.join('，');
      }
    }
    this.setData({ composerShow: true, form, restoredDraft: Boolean(draft && draft.content) });
  },
  openEdit(event) { this.openEditById(event.currentTarget.dataset.id); },
  openEditById(id) {
    const record = store.state.records.memories && store.state.records.memories[id];
    if (!record || record.deletedAt || !record.data) return;
    clearTimeout(this.draftTimer);
    this.draftDirty = false;
    this.draftBaseUpdatedAt = Number(record.updatedAt) || 0;
    const source = normalizeMemory(record.data);
    const draft = safeReadDraft(id);
    const draftFresh = Boolean(draft && (Number.isFinite(draft.baseUpdatedAt)
      ? draft.baseUpdatedAt === this.draftBaseUpdatedAt
      : Number(draft.savedAt) >= this.draftBaseUpdatedAt));
    const value = draftFresh ? normalizeMemory(draft) : source;
    const occurredAt = value.occurredAt || source.occurredAt;
    this.setData({
      composerShow: true,
      restoredDraft: Boolean(draftFresh && draft.content),
      form: {
        id,
        content: value.content,
        date: occurredAt.slice(0, 10),
        time: occurredAt.slice(11),
        mood: value.mood,
        tagsInput: value.tags.join('，')
      }
    });
  },
  closeComposer() {
    /* 关闭/返回前先提交最后一段输入：350ms 防抖内的内容不能因为离开页面而丢（R05） */
    clearTimeout(this.draftTimer);
    if (!this.commitDraftNow()) return wx.showToast({ title: '草稿保存失败，请尽快保存记录', icon: 'none' });
    this.setData({ composerShow: false, restoredDraft: false });
  },
  noop() {},
  onContent(event) { this.setData({ 'form.content': event.detail.value }); this.scheduleDraft(); },
  onDate(event) { this.setData({ 'form.date': event.detail.value }); this.scheduleDraft(); },
  onTime(event) { this.setData({ 'form.time': event.detail.value }); this.scheduleDraft(); },
  onTags(event) { this.setData({ 'form.tagsInput': event.detail.value }); this.scheduleDraft(); },
  setMood(event) { this.setData({ 'form.mood': event.currentTarget.dataset.mood }); this.scheduleDraft(); },
  addTag(event) {
    const tag = event.currentTarget.dataset.tag;
    const tags = normalizeTags(String(this.data.form.tagsInput || '').split(/[，,\s]+/).concat([tag]));
    this.setData({ 'form.tagsInput': tags.join('，') });
    this.scheduleDraft();
  },
  scheduleDraft() {
    this.draftDirty = true;
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      if (!this.commitDraftNow()) {
        wx.showToast({ title: '草稿保存失败，请尽快保存记录', icon: 'none' });
      }
    }, 350);
  },
  commitDraftNow() {
    if (!this.data.composerShow || !this.draftDirty) return true;
    const form = this.data.form;
    const id = form.id || 'new';
    const saved = !String(form.content || '').trim() ? clearDraft(id) : safeWriteDraft(id, {
      content: form.content,
      occurredAt: form.date + 'T' + form.time,
      mood: form.mood,
      tags: normalizeTags(String(form.tagsInput || '').split(/[，,\s]+/)),
      savedAt: Date.now(),
      ...(form.id && { baseUpdatedAt: this.draftBaseUpdatedAt })
    });
    if (saved) this.draftDirty = false;
    return saved;
  },
  saveDraft() {
    clearTimeout(this.draftTimer);
    this.draftDirty = true;
    this.commitDraftNow();
  },
  saveMemory() {
    /* 先停掉草稿定时器再清理：否则 350ms 后定时器把已保存的内容重新写成草稿（R05 probe） */
    clearTimeout(this.draftTimer);
    this.draftTimer = null;
    const form = this.data.form;
    const data = normalizeMemory({
      content: form.content,
      occurredAt: form.date + 'T' + form.time,
      mood: form.mood,
      tags: String(form.tagsInput || '').split(/[，,\s]+/)
    });
    if (!data.content) return wx.showToast({ title: '写下一点此刻的感受吧', icon: 'none' });
    if (!data.occurredAt) return wx.showToast({ title: '请选择发生时间', icon: 'none' });
    if (ui.isRepeatedTap(this, 'memory-save', 800)) return;
    const save = (id) => {
      sync.upsert('memories', data, id);
      clearDraft(form.id || 'new');
      this.draftDirty = false;
      this.setData({ composerShow: false, restoredDraft: false });
      wx.showToast({ title: '已留在时间线', icon: 'success' });
    };
    const current = form.id && store.state.records.memories[form.id];
    if (form.id && this.draftBaseUpdatedAt !== undefined &&
        (!current || current.deletedAt || (Number(current.updatedAt) || 0) !== this.draftBaseUpdatedAt)) {
      this.commitDraftNow();
      return wx.showModal({
        title: '这条随记已在其他设备更新',
        content: '可以把当前内容另存为一条随记。',
        confirmText: '另存',
        success: ({ confirm }) => { if (confirm) save(undefined); }
      });
    }
    save(form.id || undefined);
  },
  removeMemory(event) {
    const id = event.currentTarget.dataset.id;
    const record = store.state.records.memories && store.state.records.memories[id];
    if (!record || record.deletedAt || !record.data) return;
    const undoData = record.data;
    sync.remove('memories', id);
    ui.armUndo(this, {
      onUndo: () => {
        sync.upsert('memories', undoData, id);
        wx.showToast({ title: '已恢复', icon: 'success' });
      }
    });
  },
  onUndoTap() { ui.performUndo(this); },
  /* 搜索输入 300ms 防抖（与统一搜索页同一策略）：每次按键都全量过滤分组会明显卡顿 */
  onKeyword(event) {
    this.setData({ keyword: event.detail.value });
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.resetTimeline(), 300);
  },
  setFilterMood(event) {
    const mood = event.currentTarget.dataset.mood;
    this.setData({ selectedMood: mood === this.data.selectedMood ? '' : mood });
    this.resetTimeline();
  },
  setFilterTag(event) {
    const tag = event.currentTarget.dataset.tag;
    this.setData({ selectedTag: tag === this.data.selectedTag ? '' : tag });
    this.resetTimeline();
  },
  clearFilters() { this.setData({ keyword: '', selectedMood: '', selectedTag: '', selectedDate: '' }); this.resetTimeline(); },
  goSearch() { wx.navigateTo({ url: '/pages/search/search?kind=memory' }); }
});
