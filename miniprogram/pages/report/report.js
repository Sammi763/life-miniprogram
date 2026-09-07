const store = require('../../utils/store');
const sync = require('../../utils/sync');
const api = require('../../utils/api');
const { buildMonthlyReport } = require('../../utils/report-utils');
const theme = require('../../utils/theme');

function hasAiConsent() {
  const setting = store.state.records.settings && store.state.records.settings.app;
  return Boolean(setting && !setting.deletedAt && setting.data && setting.data.aiConsent === true);
}

function monthString(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
}

function formatChange(value) {
  const number = Number(value) || 0;
  return (number > 0 ? '+' : '') + number;
}

Page({
  data: {
    month: '',
    monthText: '',
    canNext: false,
    offline: false,
    finance: { income: 0, expense: 0, balance: 0, budget: 0, budgetUsed: 0, incomeChange: 0, expenseChange: 0, topCategories: [], dailyTrend: [], categoryBudgets: [], overspent: [] },
    life: { habit: { rate: 0 }, plan: { rate: 0 }, weight: { hasData: false }, media: { completed: 0, averageRating: 0 }, memory: { count: 0, days: 0, topTags: [], moods: [] } },
    trend: [],
    summary: '',
    aiSummary: '',
    aiSummaryLabel: '根据记录整理',
    aiSummaryLoading: false,
    aiSummaryKey: '',
    aiConsent: false
  },
  unsub: null,

  onLoad() {
    theme.applyToPage(this);
    this.setData({ month: monthString(new Date()) });
    this.unsub = store.subscribe(() => this.render());
    this.render();
    this.loadAiSummary();
  },
  onShow() { theme.applyToPage(this); this.render(); this.loadAiSummary(); },
  onUnload() { this.unsub && this.unsub(); },
  onPullDownRefresh() {
    sync.pull().then(() => {
      this.render();
      this.loadAiSummary(true);
    }).finally(() => wx.stopPullDownRefresh());
  },

  loadAiSummary(force) {
    const month = this.data.month || monthString(new Date());
    if (!api.getToken()) return;
    if (!hasAiConsent()) {
      this.setData({ aiSummary: this.data.summary || '', aiSummaryLabel: '本机整理', aiSummaryLoading: false, aiSummaryKey: month, aiConsent: false });
      return;
    }
    if (!force && (this.data.aiSummaryLoading || this.data.aiSummaryKey === month)) return;
    this.setData({ aiSummaryKey: month, aiSummaryLoading: true, aiConsent: true });
    api.getInsight('month', month).then((result) => {
      if (this.data.aiSummaryKey !== month) return;
      const content = String(result && result.content || '').trim();
      if (!content) return;
      this.setData({
        aiSummary: content,
        aiSummaryLabel: result.source === 'ai' || result.source === 'cache' ? 'AI 生成 · 仅你可见' : '根据记录整理'
      });
    }).catch(() => {
      // 模型不可用时继续展示客户端确定性总结。
    }).finally(() => {
      if (this.data.aiSummaryKey === month) this.setData({ aiSummaryLoading: false });
    });
  },

  render() {
    const month = this.data.month || monthString(new Date());
    const source = {};
    for (const collection of ['money', 'habit', 'plan', 'fitness', 'media', 'settings', 'memories']) {
      source[collection] = Object.values(store.state.records[collection] || {}).filter((record) => !record.deletedAt && record.data);
    }
    const report = buildMonthlyReport(source, month);
    const aiConsent = hasAiConsent();
    const maxTrend = Math.max(1, ...report.finance.dailyTrend.map((item) => item.amount));
    const trend = report.finance.dailyTrend.map((item) => ({
      ...item,
      day: item.date.slice(-2),
      width: Math.max(item.amount ? 8 : 0, Math.round(item.amount * 100 / maxTrend))
    }));
    const [year, number] = month.split('-');
    this.setData({
      month,
      monthText: year + ' 年 ' + Number(number) + ' 月',
      canNext: month < monthString(new Date()),
      offline: store.state.syncState === 'offline',
      finance: report.finance,
      life: report.life,
      trend,
      summary: report.summary,
      aiConsent,
      aiSummary: aiConsent ? this.data.aiSummary : report.summary,
      aiSummaryLabel: aiConsent ? this.data.aiSummaryLabel : '本机整理',
      aiSummaryLoading: aiConsent ? this.data.aiSummaryLoading : false
    });
  },

  shiftMonth(offset) {
    const [year, month] = this.data.month.split('-').map(Number);
    const target = new Date(year, month - 1 + offset, 1);
    const next = monthString(target);
    if (next > monthString(new Date())) return;
    this.setData({ month: next, aiSummaryKey: '' });
    this.render();
    this.loadAiSummary(true);
  },
  previousMonth() { this.shiftMonth(-1); },
  nextMonth() { this.shiftMonth(1); }
});
