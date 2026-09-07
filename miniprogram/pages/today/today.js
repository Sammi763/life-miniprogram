const store = require('../../utils/store');
const sync = require('../../utils/sync');
const api = require('../../utils/api');
const { addDays, derivePlanOccurrences, makeOccurrenceId } = require('../../utils/plan-utils');
const { buildTodayQueue, chooseFocusTask } = require('../../utils/daily-utils');
const { buildBillAlerts } = require('../../utils/ledger-utils');
const { syncTabBar } = require('../../utils/tabbar');
const theme = require('../../utils/theme');

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function hasAiConsent() {
  const setting = store.state.records.settings && store.state.records.settings.app;
  return Boolean(setting && !setting.deletedAt && setting.data && setting.data.aiConsent === true);
}

Page({
  data: {
    dateText: '',
    lifeIndex: 60,
    lifeMessage: '今天先从一件小事开始，慢慢来就好。',
    offline: false,
    syncing: false,
    todayIn: 0, todayOut: 0,
    monthOut: 0, budget: 0, budgetPct: 0,
    habits: [],
    plans: [],
    shopping: [],
    todayQueue: [],
    focusTask: null,
    billAlerts: [],
    memoryCount: 0,
    recentRecords: [],
    aiInsight: '今天先从一件小事开始，慢慢来就好。',
    aiInsightLabel: '根据记录整理',
    aiInsightLoading: false,
    aiInsightKey: '',
    aiConsent: false
  },
  unsub: null,
  currentPlans: [],
  currentQueue: [],
  onLoad() {
    theme.applyToPage(this);
    this.unsub = store.subscribe(() => this.render());
    this.render();
    this.loadInsight();
  },
  onShow() { theme.applyToPage(this); syncTabBar(this, 0); this.render(); this.loadInsight(); },
  onUnload() {
    this.unsub && this.unsub();
  },
  onPullDownRefresh() {
    sync.pull().then(() => {
      this.render();
      this.loadInsight(true);
    }).finally(() => wx.stopPullDownRefresh());
  },

  loadInsight(force) {
    const period = sync.fmtDate(new Date());
    if (!api.getToken()) return;
    if (!hasAiConsent()) {
      this.setData({ aiInsight: this.data.lifeMessage || '今天先从一件小事开始，慢慢来就好。', aiInsightLabel: '本机整理', aiInsightLoading: false, aiInsightKey: period, aiConsent: false });
      return;
    }
    if (!force && (this.data.aiInsightLoading || this.data.aiInsightKey === period)) return;
    this.setData({ aiInsightKey: period, aiInsightLoading: true, aiConsent: true });
    api.getInsight('today').then((result) => {
      const content = String(result && result.content || '').trim();
      if (!content) return;
      this.setData({
        aiInsight: content,
        aiInsightLabel: result.source === 'ai' || result.source === 'cache' ? 'AI 生成 · 仅你可见' : '根据记录整理'
      });
    }).catch(() => {
      // 网络或模型不可用时保留本地默认文案，不打断今日页。
    }).finally(() => this.setData({ aiInsightLoading: false }));
  },

  render() {
    const s = store.state;
    const now = new Date();
    const t = sync.fmtDate(now);
    const y = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return sync.fmtDate(d); })();
    const month = t.slice(0, 7);

    // 本月/今日收支
    let monthIn = 0, monthOut = 0, tIn = 0, tOut = 0;
    for (const r of Object.values(s.records.money)) {
      if (r.deletedAt || !r.data) continue;
      const amt = Number(r.data.amount) || 0;
      if ((r.data.date || '').slice(0, 7) === month) {
        if (r.data.type === 'income') monthIn += amt;
        if (r.data.type === 'expense') monthOut += amt;
      }
      if (r.data.date === t) {
        if (r.data.type === 'income') tIn += amt;
        if (r.data.type === 'expense') tOut += amt;
      }
    }
    let budget = 0;
    const settingsRec = s.records.settings['app'];
    if (settingsRec && settingsRec.data) budget = Number(settingsRec.data.budget) || 0;

    // 习惯（定义 + 今日打卡）
    const defs = [], entries = {};
    for (const r of Object.values(s.records.habit)) {
      if (r.deletedAt || !r.data) continue;
      if (r.data.kind === 'def') defs.push(r);
      else if (r.data.kind === 'entry' && r.data.date === t) entries[r.data.habitId] = r;
    }
    const habits = defs
      .sort((a, b) => (a.data.name > b.data.name ? 1 : -1))
      .map((d) => {
        const e = entries[d.id];
        const val = e ? Number(e.data.value) || 0 : 0;
        const target = Number(d.data.target) || 1;
        return {
          id: d.id, name: d.data.name, mode: d.data.mode,
          unit: d.data.unit || '', target,
          value: val, done: d.data.mode === 'check' ? val >= 1 : val >= target,
          text: d.data.mode === 'check' ? (val >= 1 ? '已完成' : '未完成') : val + ' / ' + target + ' ' + (d.data.unit || '')
        };
      });

    // 日程：今日 + 逾期未完成。重复事项只展开近 30 天，并且每个系列仅保留最近一项逾期，避免首页堆满旧日期。
    const planRecords = Object.values(s.records.plan).filter((record) => !record.deletedAt && record.data);
    const directPlans = planRecords.filter((record) => record.data.kind !== 'series' && record.data.kind !== 'occurrence')
      .filter((record) => record.data.date === t || (!record.data.done && !record.data.skipped && record.data.date < t))
      .map((record) => ({
        id: record.id, sourceId: record.id, isVirtual: false, title: record.data.title, date: record.data.date,
        time: record.data.time || '', done: !!record.data.done, skipped: !!record.data.skipped
      }));
    const recurringCandidates = derivePlanOccurrences(planRecords, addDays(t, -30), t)
      .filter((item) => item.isVirtual && !item.skipped && (item.date === t || (!item.done && item.date < t)));
    const recurringLatest = {};
    recurringCandidates.forEach((item) => {
      const old = recurringLatest[item.seriesId];
      if (!old || item.date > old.date) recurringLatest[item.seriesId] = item;
    });
    const plans = directPlans.concat(Object.values(recurringLatest)).map((item) => ({
      ...item,
      overdue: !item.done && item.date < t,
      dateText: item.date === t ? '' : item.date.slice(5) + ' · '
    }));
    plans.sort((a, b) => (a.overdue === b.overdue ? (a.time > b.time ? 1 : -1) : (a.overdue ? -1 : 1)));
    this.currentPlans = plans;

    // 待买预览（未完成前 3 条）
    const shopping = Object.values(s.records.shopping)
      .filter((r) => !r.deletedAt && r.data && !r.data.done)
      .sort((a, b) => (a.updatedAt > b.updatedAt ? 1 : -1))
      .slice(0, 3)
      .map((r) => ({ id: r.id, name: r.data.name }));

    const queueSource = { plan: planRecords, habit: Object.values(s.records.habit), shopping: Object.values(s.records.shopping) };
    const todayQueue = buildTodayQueue(queueSource, t).slice(0, 8).map((item) => ({
      ...item,
      kindText: item.kind === 'plan' ? '日程' : item.kind === 'habit' ? '习惯' : '待买',
      actionText: item.kind === 'habit' ? (item.mode === 'count' ? '+1' : '打卡') : item.kind === 'shopping' ? '买到' : '完成',
      pinText: item.pinned ? '取消置顶' : '置顶'
    }));
    const focusTask = chooseFocusTask(todayQueue);
    this.currentQueue = todayQueue;
    const memoryCount = Object.values(s.records.memories || {}).filter((record) => !record.deletedAt && record.data && String(record.data.occurredAt || '').slice(0, 10) === t).length;

    const budgetPct = budget > 0 ? Math.min(100, Math.round((monthOut / budget) * 100)) : 0;
    const habitDone = habits.filter((habit) => habit.done).length;
    const planDone = plans.filter((plan) => plan.done).length;
    const lifeIndex = Math.max(0, Math.min(100, Math.round(45 + (defs.length ? habitDone / defs.length * 35 : 0) + (plans.length ? planDone / plans.length * 20 : 20))));
    const lifeMessage = lifeIndex >= 80 ? '节奏很好，给自己留一点余地。' : lifeIndex >= 60 ? '今天先从一件小事开始，慢慢来就好。' : '不用一次做完，完成一件就很棒。';
    const aiConsent = hasAiConsent();
    const recentRecords = [];
    for (const r of Object.values(s.records.money)) {
      if (r.deletedAt || !r.data) continue;
      recentRecords.push({
        id: r.id, kind: 'money', title: r.data.note || r.data.category || '记账',
        sub: (r.data.date === t ? '今天' : r.data.date) + ' · 财务',
        amount: (r.data.type === 'income' ? '+' : r.data.type === 'transfer' ? '↔' : '-') + '¥' + (Number(r.data.amount) || 0),
        amountClass: r.data.type === 'income' ? 'money-in' : r.data.type === 'transfer' ? 'money-transfer' : 'money-out', updatedAt: r.updatedAt || 0
      });
    }
    for (const r of Object.values(s.records.shopping)) {
      if (r.deletedAt || !r.data) continue;
      recentRecords.push({ id: r.id, kind: 'shopping', title: r.data.name, sub: r.data.done ? '已买' : '待买', amount: '', amountClass: '', updatedAt: r.updatedAt || 0 });
    }
    for (const r of Object.values(s.records.memories || {})) {
      if (r.deletedAt || !r.data) continue;
      recentRecords.push({ id: r.id, kind: 'memory', title: String(r.data.content || '').slice(0, 30), sub: String(r.data.occurredAt || '').replace('T', ' · '), amount: '', amountClass: '', updatedAt: r.updatedAt || 0 });
    }
    recentRecords.sort((a, b) => b.updatedAt - a.updatedAt);

    this.setData({
      dateText: (now.getMonth() + 1) + '月' + now.getDate() + '日 · ' + WEEK[now.getDay()],
      lifeIndex, lifeMessage,
      offline: s.syncState === 'offline',
      syncing: s.syncState === 'syncing',
      todayIn: tIn, todayOut: tOut,
      monthOut, budget, budgetPct,
      habits, plans, shopping, todayQueue, focusTask,
      billAlerts: buildBillAlerts(s.records.accounts || {}, s.records.money || {}, now),
      memoryCount,
      recentRecords: recentRecords.slice(0, 5),
      aiConsent,
      aiInsight: aiConsent ? this.data.aiInsight : lifeMessage,
      aiInsightLabel: aiConsent ? this.data.aiInsightLabel : '本机整理',
      aiInsightLoading: aiConsent ? this.data.aiInsightLoading : false
    });
  },

  // ---- 交互：改数据 → sync.upsert → store.notify → 各页自渲染 ----
  onHabitTap(e) {
    const { id, mode } = e.currentTarget.dataset;
    const t = sync.fmtDate(new Date());
    const s = store.state;
    // 找今日已有打卡
    let entry = null;
    for (const r of Object.values(s.records.habit)) {
      if (!r.deletedAt && r.data && r.data.kind === 'entry' && r.data.habitId === id && r.data.date === t) entry = r;
    }
    if (mode === 'check') {
      const next = entry && Number(entry.data.value) >= 1 ? 0 : 1;
      sync.upsert('habit', { kind: 'entry', habitId: id, date: t, value: next }, entry && entry.id);
    } else if (mode === 'count') {
      const next = (entry ? Number(entry.data.value) || 0 : 0) + 1;
      sync.upsert('habit', { kind: 'entry', habitId: id, date: t, value: next }, entry && entry.id);
    } else {
      wx.showModal({
        title: '记录数值',
        editable: true,
        placeholderText: '输入今日数值',
        success: (res) => {
          if (!res.confirm) return;
          const v = Number(res.content);
          if (isNaN(v) || v < 0) return;
          sync.upsert('habit', { kind: 'entry', habitId: id, date: t, value: v }, entry && entry.id);
        }
      });
    }
  },
  onPlanToggle(e) {
    const { id } = e.currentTarget.dataset;
    const item = this.currentPlans.find((plan) => plan.id === id);
    if (!item) return;
    if (item.isVirtual) {
      sync.upsert('plan', { kind: 'occurrence', seriesId: item.sourceId, date: item.date, done: !item.done, skipped: false }, makeOccurrenceId(item.sourceId, item.date));
      return;
    }
    const record = store.state.records.plan[item.id];
    if (record && !record.deletedAt) sync.upsert('plan', Object.assign({}, record.data, { done: !item.done, skipped: false }), item.id);
  },
  onQueueTap(e) {
    const { id, kind } = e.currentTarget.dataset;
    const item = this.currentQueue.find((candidate) => candidate.id === id && candidate.kind === kind);
    if (!item) return;
    if (kind === 'habit') return this.onHabitTap({ currentTarget: { dataset: { id: item.sourceId, mode: item.mode } } });
    if (kind === 'shopping') {
      const record = store.state.records.shopping[item.sourceId];
      if (record && !record.deletedAt) sync.upsert('shopping', { ...record.data, done: true }, item.sourceId);
      return;
    }
    if (item.isVirtual) {
      sync.upsert('plan', { kind: 'occurrence', seriesId: item.sourceId, date: item.date, done: true, skipped: false }, makeOccurrenceId(item.sourceId, item.date));
      return;
    }
    const record = store.state.records.plan[item.sourceId];
    if (record && !record.deletedAt) sync.upsert('plan', { ...record.data, done: true, skipped: false }, item.sourceId);
  },
  onQueuePin(e) {
    const { id, kind } = e.currentTarget.dataset;
    const item = this.currentQueue.find((candidate) => candidate.id === id && candidate.kind === kind);
    if (!item) return;
    const collection = kind === 'plan' ? 'plan' : kind === 'habit' ? 'habit' : 'shopping';
    const sourceId = item.sourceId;
    const record = store.state.records[collection][sourceId];
    if (record && !record.deletedAt && record.data) sync.upsert(collection, { ...record.data, pinned: !record.data.pinned }, sourceId);
  },
  goMoney() { wx.switchTab({ url: '/pages/money/money' }); },
  goHabit() { wx.switchTab({ url: '/pages/habit/habit' }); },
  goMemory() { wx.navigateTo({ url: '/pages/memory/memory?compose=1' }); },
  goPlan() { wx.navigateTo({ url: '/pages/plan/plan' }); },
  goShopping() { wx.navigateTo({ url: '/pages/shopping/shopping' }); },
  goMedia() { wx.navigateTo({ url: '/pages/media/media' }); },
  goFitness() { wx.navigateTo({ url: '/pages/fitness/fitness' }); },
  goReport() { wx.navigateTo({ url: '/pages/report/report' }); },
  goReview() { wx.navigateTo({ url: '/pages/review/review' }); },
  goSearch() { wx.navigateTo({ url: '/pages/search/search' }); }
});
