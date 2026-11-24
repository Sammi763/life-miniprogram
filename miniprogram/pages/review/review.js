const store = require('../../utils/store');
const sync = require('../../utils/sync');
const ui = require('../../utils/ui');
const { addDays, getWeekDates } = require('../../utils/plan-utils');
const { formatMoney } = require('../../utils/finance');
const { buildWeeklyReview } = require('../../utils/review-utils');
const theme = require('../../utils/theme');
const share = require('../../utils/share');

function weekStartFor(date) { return getWeekDates(sync.fmtDate(date || new Date()))[0]; }
function weekText(start, end) { return start.slice(5).replace('-', ' 月 ') + ' 日 - ' + end.slice(5).replace('-', ' 月 ') + ' 日'; }

Page({
  data: {
    offline: false,
    weekStart: '',
    weekLabel: '',
    canNext: false,
    review: { period: {}, finance: {}, plan: {}, habit: {}, weight: {}, memories: { topTags: [], moods: [] }, nextPlans: [] },
    /* U13 复盘闭环：「下周一个调整」手动转为日程或习惯，不自动创建任何内容 */
    adjustText: ''
  },
  unsub: null,
  onLoad() {
    theme.applyToPage(this);
    this.setData({ weekStart: weekStartFor(new Date()) });
    this.unsub = ui.bindStore(this, ['money', 'habit', 'plan', 'fitness', 'memories', 'focusSessions', 'weeklyReviews', '__sync__'],
      () => this.render(),
      () => this.renderSyncState());
    this.render();
  },
  onShow() { this.__pageHidden = false; theme.applyToPage(this); share.enableShareMenu(); this.render(); },
  onShareAppMessage: share.onShareAppMessage('review'),
  onShareTimeline: share.onShareTimeline('review'),
  onHide() { this.__pageHidden = true; },
  onUnload() { this.unsub && this.unsub(); },
  /* 同步状态变化只更新状态横幅，不做整页重算（性能方案 §5） */
  renderSyncState() {
    ui.diffSetData(this, { offline: store.state.syncState === 'offline' });
  },
  retrySync() { return ui.retryWithFeedback(() => sync.pull()); },
  onPullDownRefresh() { sync.pull().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh()); },
  render() {
    const source = {};
    for (const collection of ['money', 'habit', 'plan', 'fitness', 'memories']) source[collection] = Object.values(store.state.records[collection] || {}).filter((record) => !record.deletedAt && record.data);
    const review = buildWeeklyReview(source, this.data.weekStart || weekStartFor(new Date()));
    review.finance = {
      ...review.finance,
      incomeText: formatMoney(review.finance.income),
      expenseText: formatMoney(review.finance.expense),
      balanceText: formatMoney(review.finance.balance)
    };
    const current = weekStartFor(new Date());
    const draft = this.reviewDrafts && this.reviewDrafts[review.period.start];
    const saved = (store.state.records.weeklyReviews || {})[review.period.start];
    const notes = draft || (saved && !saved.deletedAt && saved.data) || {};
    const sessions = Object.values(store.state.records.focusSessions || {}).filter((record) =>
      !record.deletedAt && record.data && record.data.date >= review.period.start && record.data.date <= review.period.end);
    const elapsed = sessions.reduce((sum, { data }) => sum + data.endedAt - data.startedAt, 0);
    ui.diffSetData(this, {
      offline: store.state.syncState === 'offline',
      weekStart: review.period.start,
      weekLabel: weekText(review.period.start, review.period.end),
      canNext: review.period.start < current,
      focusCount: sessions.length, focusMinutes: Math.round(elapsed / 6000) / 10,
      adjustText: notes.adjustment || '', reflection: notes.reflection || '',
      review
    });
  },
  previousWeek() { this.setData({ weekStart: addDays(this.data.weekStart, -7) }); this.render(); },
  nextWeek() { if (!this.data.canNext) return; this.setData({ weekStart: addDays(this.data.weekStart, 7) }); this.render(); },
  goCurrentWeek() { this.setData({ weekStart: weekStartFor(new Date()) }); this.render(); },
  /* 「下周先安排」的自然动作是去日程页处理 */
  goPlan() { wx.navigateTo({ url: '/pages/plan/plan' }); },

  /* ---- U13：把一个调整亲手变成下周的行动（显式动作，不自动生成） ---- */
  openFocus() { wx.navigateTo({ url: '/pages/focus/focus' }); },
  onAdjustInput(event) { this.editNotes({ adjustment: event.detail.value }); },
  onReflectionInput(event) { this.editNotes({ reflection: event.detail.value }); },
  editNotes(patch) {
    this.reviewDrafts = this.reviewDrafts || {};
    this.reviewDrafts[this.data.weekStart] = { adjustment: this.data.adjustText, reflection: this.data.reflection || '', ...patch };
    const notes = this.reviewDrafts[this.data.weekStart];
    this.setData({ adjustText: notes.adjustment, reflection: notes.reflection });
  },
  saveNotes() {
    const weekStart = this.data.weekStart;
    const data = { weekStart, adjustment: this.data.adjustText.trim(), reflection: String(this.data.reflection || '').trim() };
    if (this.reviewDrafts) delete this.reviewDrafts[weekStart];
    sync.upsert('weeklyReviews', data, weekStart);
    wx.showToast({ title: '复盘已保存' });
  },
  /* 转为日程：落到下周一；标题上限 30 字与 plan 校验一致 */
  adjustToPlan() {
    const title = String(this.data.adjustText || '').trim();
    if (!title) return wx.showToast({ title: '先写下一个调整', icon: 'none' });
    if (title.length > 30) return wx.showToast({ title: '日程标题最多 30 个字', icon: 'none' });
    if (ui.isRepeatedTap(this, 'review-to-plan', 600)) return;
    const week = this.data.weekStart || weekStartFor(new Date());
    const nextMonday = addDays(week, 7);
    const id = 'review-plan-' + week;
    if (store.state.records.plan[id]) return wx.showToast({ title: '本周调整已转成日程', icon: 'none' });
    sync.upsert('plan', { title, date: nextMonday, time: '', done: false }, id, { createOnly: true });
    ui.completeFeedback({ toast: '已排入下周一日程' });
  },
  /* 转为习惯：每日勾选；名字上限 12 字与习惯页输入框上限一致（校验白名单为 24，这里取更严的 UI 口径） */
  adjustToHabit() {
    const name = String(this.data.adjustText || '').trim();
    if (!name) return wx.showToast({ title: '先写下一个调整', icon: 'none' });
    if (name.length > 12) return wx.showToast({ title: '习惯名最多 12 个字', icon: 'none' });
    if (ui.isRepeatedTap(this, 'review-to-habit', 600)) return;
    const id = 'review-habit-' + (this.data.weekStart || weekStartFor(new Date()));
    if (store.state.records.habit[id]) return wx.showToast({ title: '本周调整已转成习惯', icon: 'none' });
    sync.upsert('habit', { kind: 'def', name, mode: 'check', target: 1, unit: '' }, id, { createOnly: true });
    ui.completeFeedback({ toast: '已建立习惯「' + name + '」' });
  }
});
