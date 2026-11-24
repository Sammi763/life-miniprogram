const store = require('../../utils/store');
const sync = require('../../utils/sync');
const ui = require('../../utils/ui');
const api = require('../../utils/api');
const runtime = require('../../config/runtime');
const { formatMoney } = require('../../utils/finance');
const { buildMonthlyReport } = require('../../utils/report-utils');
const theme = require('../../utils/theme');
const share = require('../../utils/share');

function hasAiConsent() {
  const { aiConsentKey } = runtime.getRuntimeConfig();
  if (!aiConsentKey) return false;
  const setting = store.state.records.settings && store.state.records.settings.app;
  return Boolean(setting && !setting.deletedAt && setting.data && setting.data[aiConsentKey] === true);
}

function monthString(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
}

function formatChange(value) {
  const number = Number(value) || 0;
  return (number > 0 ? '+' : '') + number;
}

/* 展示用金额：负数把负号放在 ¥ 前（-¥123 而不是 ¥-123） */
function yuan(value) {
  const number = Number(value) || 0;
  return (number < 0 ? '-' : '') + '¥' + formatMoney(Math.abs(number));
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
    trendExpanded: false,
    trendTotal: 0,
    summary: '',
    aiSummary: '',
    aiSummaryLabel: '根据记录整理',
    aiSummaryLoading: false,
    aiSummaryKey: '',
    aiSummaryFaded: false,
    aiConsent: false
  },
  unsub: null,

  openCategoryDetails(event) {
    const category = event.currentTarget.dataset.category;
    wx.navigateTo({ url: '/pages/categories/categories?month=' + this.data.month + (category ? '&category=' + encodeURIComponent(category) : '') });
  },

  onLoad() {
    this.setData({ month: monthString(new Date()) });
    this.unsub = ui.bindStore(this,
      ['money', 'habit', 'plan', 'fitness', 'media', 'settings', 'memories', '__sync__'],
      () => this.render(),
      () => ui.diffSetData(this, { offline: store.state.syncState === 'offline' }));
  },
  onShow() { this.__pageHidden = false; theme.applyToPage(this); share.enableShareMenu(); this.render(); this.loadAiSummary(); },
  onShareAppMessage: share.onShareAppMessage('report'),
  onShareTimeline: share.onShareTimeline('report'),
  onHide() { this.__pageHidden = true; },
  onUnload() { this.unsub && this.unsub(); },
  retrySync() { return ui.retryWithFeedback(() => sync.pull()); },
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
      this.setData({ aiSummary: this.data.summary || '', aiSummaryLabel: '本机整理', aiSummaryLoading: false, aiSummaryKey: '', aiConsent: false });
      return;
    }
    if (!force && (this.data.aiSummaryLoading || this.data.aiSummaryKey === month)) return;
    this.setData({ aiSummaryKey: month, aiSummaryLoading: true, aiConsent: true });
    sync.flush().then(() => hasAiConsent() && api.getInsight('month', month)).then((result) => {
      if (this.data.aiSummaryKey !== month || !hasAiConsent()) return;
      const content = String(result && result.content || '').trim();
      if (!content) return;
      /* 内容到达时先瞬时降透明度再移除，触发一次淡入，避免正文无过渡地整体替换 */
      this.setData({
        aiSummary: content,
        aiSummaryLabel: result.source === 'ai' || result.source === 'cache' ? 'AI 生成 · 仅你可见' : '根据记录整理',
        aiSummaryFaded: true
      });
      setTimeout(() => this.setData({ aiSummaryFaded: false }), 30);
    }).catch(() => {
      if (this.data.aiSummaryKey === month) this.setData({ aiSummaryKey: '', aiSummaryLoading: false });
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
      amountText: formatMoney(item.amount),
      width: Math.max(item.amount ? 8 : 0, Math.round(item.amount * 100 / maxTrend))
    }));
    /* 趋势降噪：默认只看最近 7 个有支出的日子，可展开全部 */
    const trendShown = this.data.trendExpanded ? trend : trend.slice(-7);
    const finance = {
      ...report.finance,
      balanceText: yuan(report.finance.balance),
      incomeText: formatMoney(report.finance.income),
      expenseText: formatMoney(report.finance.expense),
      budgetText: formatMoney(report.finance.budget),
      topCategories: (report.finance.topCategories || []).map((item) => ({ ...item, amountText: formatMoney(item.amount) })),
      categoryBudgets: (report.finance.categoryBudgets || []).map((item) => ({
        ...item,
        spentText: formatMoney(item.spent),
        budgetText: formatMoney(item.budget),
        overText: formatMoney(item.over),
        suggestedText: formatMoney(item.suggested)
      }))
    };
    const [year, number] = month.split('-');
    ui.diffSetData(this, {
      month,
      monthText: year + ' 年 ' + Number(number) + ' 月',
      canNext: month < monthString(new Date()),
      offline: store.state.syncState === 'offline',
      finance,
      life: report.life,
      trend: trendShown,
      trendTotal: trend.length,
      summary: report.summary,
      aiConsent,
      aiSummary: aiConsent ? this.data.aiSummary : report.summary,
      aiSummaryLabel: aiConsent ? this.data.aiSummaryLabel : '本机整理',
      aiSummaryLoading: aiConsent ? this.data.aiSummaryLoading : false
    });
  },
  toggleTrend() { this.setData({ trendExpanded: !this.data.trendExpanded }); this.render(); },
  goBudget() { wx.switchTab({ url: '/pages/mine/mine' }); },

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
