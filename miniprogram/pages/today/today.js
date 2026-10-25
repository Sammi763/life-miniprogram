const store = require('../../utils/store');
const sync = require('../../utils/sync');
const ui = require('../../utils/ui');
const api = require('../../utils/api');
const { addDays, derivePlanOccurrences, makeOccurrenceId } = require('../../utils/plan-utils');
const { buildTodayQueue, chooseFocusTask } = require('../../utils/daily-utils');
const habitUtils = require('../../utils/habit-utils');
const { buildBillAlerts, buildBudgetAdvice } = require('../../utils/ledger-utils');
const { setPendingOpen } = require('../../utils/pending-open');
const { syncTabBar, attachOverlayWatcher, TAB } = require('../../utils/tabbar');
const theme = require('../../utils/theme');
const share = require('../../utils/share');

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const MEDIA_STATUS_LABELS = { wishlist: '想看', doing: '在看', done: '看完' };

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
    todayQueue: [],
    focusTask: null,
    billAlerts: [],
    memoryCount: 0,
    recentRecords: [],
    /* 首次使用（账本/习惯/日程/待买都还没有记录）时突出「三步开始」，不做强制引导 */
    firstRun: false,
    overdueCount: 0,
    aiInsight: '今天先从一件小事开始，慢慢来就好。',
    aiInsightLabel: '根据记录整理',
    aiInsightLoading: false,
    aiInsightKey: '',
    aiConsent: false,
    /* 队列行完成中的 key（kind:id）：行先播放划除动画再真正移除 */
    finishingKey: '',
    /* 数值型习惯的轻量录入弹层 */
    valueSheetShow: false,
    valueForm: { id: '', name: '', unit: '', value: '' }
  },
  unsub: null,
  currentQueue: [],
  onLoad() {
    theme.applyToPage(this);
    // 弹层打开时隐藏悬浮导航（数值录入弹层），与 money/habit 同一套机制
    attachOverlayWatcher(this);
    this.unsub = store.subscribe(() => this.render());
    this.render();
    this.loadInsight();
  },
  onShow() { theme.applyToPage(this); share.enableShareMenu(); this.render(); this.loadInsight(); },
  onShareAppMessage: share.onShareAppMessage('today'),
  onShareTimeline: share.onShareTimeline('today'),
  onUnload() {
    this.unsub && this.unsub();
    clearTimeout(this.__undoTimer);
  },
  retrySync() { return ui.retryWithFeedback(() => sync.pull()); },
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
        const target = habitUtils.entryTarget(e, d);
        return {
          id: d.id, name: d.data.name, mode: d.data.mode,
          unit: d.data.unit || '', target,
          value: val, done: habitUtils.isEntryDone(e, d),
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

    const queueSource = { plan: planRecords, habit: Object.values(s.records.habit), shopping: Object.values(s.records.shopping) };
    const todayQueue = buildTodayQueue(queueSource, t).slice(0, 8).map((item) => ({
      ...item,
      kindText: item.kind === 'plan' ? '日程' : item.kind === 'habit' ? '习惯' : '待买',
      actionText: item.kind === 'habit' ? (item.mode === 'count' ? '+1' : item.mode === 'value' ? '记录' : '打卡') : item.kind === 'shopping' ? '买到' : '完成',
      pinText: item.pinned ? '取消置顶' : '置顶'
    }));
    const focusTask = chooseFocusTask(todayQueue);
    this.currentQueue = todayQueue;
    const memoryCount = Object.values(s.records.memories || {}).filter((record) => !record.deletedAt && record.data && String(record.data.occurredAt || '').slice(0, 10) === t).length;

    const budgetPct = budget > 0 ? Math.min(100, Math.round((monthOut / budget) * 100)) : 0;
    const habitDone = habits.filter((habit) => habit.done).length;
    const planDone = plans.filter((plan) => plan.done).length;
    const overdueCount = plans.filter((plan) => plan.overdue && !plan.done).length;
    /* 首次使用：四个核心记录集合都为空时突出「记一笔 / 建习惯 / 排日程」；任何一条记录出现即消失 */
    const firstRun = ['money', 'habit', 'plan', 'shopping'].every((coll) =>
      !Object.values(s.records[coll] || {}).some((record) => !record.deletedAt && record.data));
    /* 跨模块预算建议（只读）：待买预估 + 本月支出 超预算时提示；不自动改任何状态 */
    const budgetAdvice = buildBudgetAdvice(settingsRec, s.records.money || {}, s.records.shopping || {}, month);
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
    /* 四类新来源：习惯打卡（含补录）、日程、书影音、体重。sub 带类型标签，与「财务」「待买」口径一致 */
    const habitNames = {};
    for (const r of Object.values(s.records.habit)) {
      if (r.deletedAt || !r.data) continue;
      if (r.data.kind === 'def') habitNames[r.id] = r.data.name || '习惯';
    }
    /* 系列标题表：occurrence 行的展示与跳转都要用（跳到系列编辑，而非单日覆盖记录） */
    const seriesTitles = {};
    for (const r of Object.values(s.records.plan)) {
      if (r.deletedAt || !r.data || r.data.kind !== 'series' || !r.data.title) continue;
      seriesTitles[r.id] = String(r.data.title);
    }
    for (const r of Object.values(s.records.habit)) {
      if (r.deletedAt || !r.data || r.data.kind !== 'entry') continue;
      const name = habitNames[r.data.habitId] || '习惯';
      recentRecords.push({
        id: r.id, kind: 'habit',
        title: name + ' ' + (Number(r.data.value) || 0),
        sub: (r.data.date === t ? '今天' : r.data.date) + ' · 习惯',
        amount: '', amountClass: '', updatedAt: r.updatedAt || 0
      });
    }
    for (const r of Object.values(s.records.plan)) {
      if (r.deletedAt || !r.data) continue;
      /* 重复日程的单日覆盖记录（occurrence）自身不写 title：借系列标题展示，跳转目标给系列 id
         （occurrence 不可直接编辑，plan.js openEditById 有对应守卫） */
      if (r.data.kind === 'occurrence') {
        const seriesTitle = r.data.titleSnapshot || seriesTitles[r.data.seriesId];
        if (!seriesTitle) continue;
        recentRecords.push({
          id: r.id, kind: 'plan', navId: r.data.seriesId, title: String(seriesTitle),
          sub: (r.data.date === t ? '今天' : r.data.date) + ' · ' + (r.data.done ? '日程已完成' : '日程'),
          amount: '', amountClass: '', updatedAt: r.updatedAt || 0
        });
        continue;
      }
      const title = r.data.title;
      if (!title) continue;
      recentRecords.push({
        id: r.id, kind: 'plan', navId: r.id, title: String(title),
        sub: (r.data.date === t ? '今天' : r.data.date) + ' · ' + (r.data.done ? '日程已完成' : '日程'),
        amount: '', amountClass: '', updatedAt: r.updatedAt || 0
      });
    }
    for (const r of Object.values(s.records.media || {})) {
      if (r.deletedAt || !r.data || !r.data.title) continue;
      const statusText = MEDIA_STATUS_LABELS[r.data.status] || '想看';
      recentRecords.push({
        id: r.id, kind: 'media', title: r.data.title + ' · ' + statusText,
        sub: (r.data.date === t ? '今天' : r.data.date) + ' · 书影音',
        amount: '', amountClass: '', updatedAt: r.updatedAt || 0
      });
    }
    for (const r of Object.values(s.records.fitness || {})) {
      if (r.deletedAt || !r.data || r.data.kind !== 'weight') continue;
      recentRecords.push({
        id: r.id, kind: 'fitness', title: (Number(r.data.weight) || 0) + ' kg',
        sub: (r.data.date === t ? '今天' : r.data.date) + ' · 体重',
        amount: '', amountClass: '', updatedAt: r.updatedAt || 0
      });
    }
    recentRecords.sort((a, b) => b.updatedAt - a.updatedAt);

    this.setData({
      dateText: (now.getMonth() + 1) + '月' + now.getDate() + '日 · ' + WEEK[now.getDay()],
      lifeIndex, lifeMessage,
      offline: s.syncState === 'offline',
      syncing: s.syncState === 'syncing',
      todayIn: tIn, todayOut: tOut,
      monthOut, budget, budgetPct,
      habits, plans, todayQueue, focusTask,
      firstRun, overdueCount, budgetAdvice,
      billAlerts: buildBillAlerts(s.records.accounts || {}, s.records.money || {}, now),
      memoryCount,
      recentRecords: recentRecords.slice(0, 5),
      aiConsent,
      aiInsight: aiConsent ? this.data.aiInsight : lifeMessage,
      aiInsightLabel: aiConsent ? this.data.aiInsightLabel : '本机整理',
      aiInsightLoading: aiConsent ? this.data.aiInsightLoading : false
    });
    /* 角标：今日待处理队列条数 */
    syncTabBar(this, TAB.TODAY, { [TAB.TODAY]: todayQueue.length });
  },

  // ---- 交互：改数据 → sync.upsert → store.notify → 各页自渲染 ----
  onQueueTap(e) {
    const { id, kind } = e.currentTarget.dataset;
    if (ui.isRepeatedTap(this, 'queue-tap-' + kind + '-' + id, 400)) return;
    const item = this.currentQueue.find((candidate) => candidate.id === id && candidate.kind === kind);
    if (!item) return;
    /* 数值型习惯打开轻量录入弹层，其余项先播放划除动画再真正完成 */
    if (kind === 'habit' && item.mode === 'value') return this.openValueSheet(item);
    this.setData({ finishingKey: kind + ':' + id });
    setTimeout(() => {
      this.completeQueueItem(item);
      this.setData({ finishingKey: '' });
      ui.completeFeedback({});
    }, 220);
  },
  completeQueueItem(item) {
    if (item.kind === 'habit') {
      const t = sync.fmtDate(new Date());
      const def = store.state.records.habit[item.sourceId];
      if (!def || def.deletedAt) return;
      const existing = habitUtils.findEntry(store.state.records.habit, item.sourceId, t);
      const current = existing ? Number(existing.data.value) || 0 : 0;
      const next = item.mode === 'count' ? current + 1 : 1;
      const w = habitUtils.entryWrite(store.state.records.habit, def, t, next);
      sync.upsert('habit', w.data, w.id);
      return;
    }
    if (item.kind === 'shopping') {
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

  openValueSheet(item) {
    const habit = this.data.habits.find((candidate) => candidate.id === item.sourceId);
    if (!habit) return;
    this.setData({ valueSheetShow: true, valueForm: { id: habit.id, name: habit.name, unit: habit.unit, value: String(habit.value || '') } });
  },
  closeValueSheet() { this.setData({ valueSheetShow: false }); },
  noop() {},
  onValueInput(e) { this.setData({ 'valueForm.value': e.detail.value }); },
  valueStep(e) {
    const delta = Number(e.currentTarget.dataset.delta) || 0;
    const current = Number(this.data.valueForm.value) || 0;
    this.setData({ 'valueForm.value': String(Math.max(0, current + delta)) });
  },
  saveValue() {
    const form = this.data.valueForm;
    const value = Number(form.value);
    if (!Number.isFinite(value) || value < 0) return wx.showToast({ title: '请输入正确的数值', icon: 'none' });
    if (ui.isRepeatedTap(this, 'today-value-save', 400)) return;
    const t = sync.fmtDate(new Date());
    const def = store.state.records.habit[form.id];
    if (!def || def.deletedAt) return;
    const w = habitUtils.entryWrite(store.state.records.habit, def, t, value);
    sync.upsert('habit', w.data, w.id);
    this.setData({ valueSheetShow: false });
    ui.completeFeedback({ toast: '已记录' });
  },

  goMoney() { wx.switchTab({ url: '/pages/money/money' }); },
  goHabit() { wx.switchTab({ url: '/pages/habit/habit' }); },
  goMine() { wx.switchTab({ url: '/pages/mine/mine' }); },
  goMemory() { wx.navigateTo({ url: '/pages/memory/memory?compose=1' }); },
  goPlan() { wx.navigateTo({ url: '/pages/plan/plan' }); },
  goShopping() { wx.navigateTo({ url: '/pages/shopping/shopping' }); },
  goFitness() { wx.navigateTo({ url: '/pages/fitness/fitness' }); },
  goReport() { wx.navigateTo({ url: '/pages/report/report' }); },
  goSearch() { wx.navigateTo({ url: '/pages/search/search' }); },

  /* 最近记录行跳转分发：money 走 storage 中转（与搜索页同一套 pending-open），其余直达对应页；
     plan 行优先用 navId（occurrence 行指向系列编辑），其余 kind 的 navId 等同 id */
  onRecentTap(e) {
    const dataset = e.currentTarget.dataset || {};
    const { id, kind } = dataset;
    if (!kind) return;
    const navId = dataset.navId || id;
    if (ui.isRepeatedTap(this, 'recent-' + kind + '-' + id, 400)) return;
    if (kind === 'money') {
      if (id) setPendingOpen('money', id);
      return wx.switchTab({ url: '/pages/money/money' });
    }
    if (kind === 'habit') return wx.switchTab({ url: '/pages/habit/habit' });
    if (kind === 'memory') return wx.navigateTo({ url: '/pages/memory/memory' + (navId ? '?id=' + encodeURIComponent(navId) : '') });
    if (kind === 'plan') return wx.navigateTo({ url: '/pages/plan/plan' + (navId ? '?id=' + encodeURIComponent(navId) : '') });
    if (kind === 'shopping') return wx.navigateTo({ url: '/pages/shopping/shopping' + (navId ? '?id=' + encodeURIComponent(navId) : '') });
    if (kind === 'media') return wx.navigateTo({ url: '/pages/media/media' + (navId ? '?id=' + encodeURIComponent(navId) : '') });
    if (kind === 'fitness') return wx.navigateTo({ url: '/pages/fitness/fitness' + (navId ? '?id=' + encodeURIComponent(navId) : '') });
  }
});
