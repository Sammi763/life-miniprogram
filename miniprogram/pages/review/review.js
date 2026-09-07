const store = require('../../utils/store');
const sync = require('../../utils/sync');
const { addDays, getWeekDates } = require('../../utils/plan-utils');
const { buildWeeklyReview } = require('../../utils/review-utils');
const theme = require('../../utils/theme');

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
  onShow() { theme.applyToPage(this); this.render(); },
  onUnload() { this.unsub && this.unsub(); },
  onPullDownRefresh() { sync.pull().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh()); },
  render() {
    const source = {};
    for (const collection of ['money', 'habit', 'plan', 'fitness', 'memories']) source[collection] = Object.values(store.state.records[collection] || {}).filter((record) => !record.deletedAt && record.data);
    const review = buildWeeklyReview(source, this.data.weekStart || weekStartFor(new Date()));
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
  goCurrentWeek() { this.setData({ weekStart: weekStartFor(new Date()) }); this.render(); }
});
