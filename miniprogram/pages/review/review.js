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
    review: { period: {}, finance: {}, plan: {}, habit: {}, weight: {}, memories: { topTags: [], moods: [] }, nextPlans: [] }
  },
  unsub: null,
  onLoad() {
    theme.applyToPage(this);
    this.setData({ weekStart: weekStartFor(new Date()) });
    this.unsub = store.subscribe(() => this.render());
    this.render();
  },
  onShow() { theme.applyToPage(this); share.enableShareMenu(); this.render(); },
  onShareAppMessage: share.onShareAppMessage('review'),
  onShareTimeline: share.onShareTimeline('review'),
  onUnload() { this.unsub && this.unsub(); },
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
    this.setData({
      offline: store.state.syncState === 'offline',
      weekStart: review.period.start,
      weekLabel: weekText(review.period.start, review.period.end),
      canNext: review.period.start < current,
      review
    });
  },
  previousWeek() { this.setData({ weekStart: addDays(this.data.weekStart, -7) }); this.render(); },
  nextWeek() { if (!this.data.canNext) return; this.setData({ weekStart: addDays(this.data.weekStart, 7) }); this.render(); },
  goCurrentWeek() { this.setData({ weekStart: weekStartFor(new Date()) }); this.render(); },
  /* 「下周先安排」的自然动作是去日程页处理 */
  goPlan() { wx.navigateTo({ url: '/pages/plan/plan' }); }
});
