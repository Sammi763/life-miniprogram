const { toCents, fromCents } = require('../../utils/amount');
const { formatMoney } = require('../../utils/finance');
const store = require('../../utils/store');
const sync = require('../../utils/sync');
const ui = require('../../utils/ui');
const api = require('../../utils/api');
const { readFocusDraft } = require('../../utils/focus-draft');
const runtime = require('../../config/runtime');
const { occurrencePatch } = require('../../utils/plan-utils');
const { buildTodayQueue, chooseFocusTask } = require('../../utils/daily-utils');
const habitUtils = require('../../utils/habit-utils');
const { buildBillAlerts, buildBudgetAdvice } = require('../../utils/ledger-utils');
const { setPendingOpen, ACTIONS } = require('../../utils/pending-open');
const { syncTabBar, attachOverlayWatcher, TAB } = require('../../utils/tabbar');
const theme = require('../../utils/theme');
const share = require('../../utils/share');

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const MEDIA_STATUS_LABELS = { wishlist: '想看', doing: '在看', done: '看完' };
const LIFE_TOOLS = [
  { title: '生活时间线', detail: '随手写下此刻', glyph: '记', url: '/pages/memory/memory' },
  { title: '每周复盘', detail: '完成、账本与下周', glyph: '周', url: '/pages/review/review' },
  { title: '统一搜索', detail: '回看所有生活记录', glyph: '查', url: '/pages/search/search' },
  { title: '日程统筹', detail: '待办与提醒', glyph: '日', url: '/pages/plan/plan' },
  { title: '月度报告', detail: '私密财务与生活回顾', glyph: '月', url: '/pages/report/report' },
  { title: '待买清单', detail: '采购与心愿', glyph: '购', url: '/pages/shopping/shopping' },
  { title: '书影音', detail: '收藏与回顾', glyph: '阅', url: '/pages/media/media' },
  { title: '减脂健身', detail: '体重与计划', glyph: '健', url: '/pages/fitness/fitness' }
];

function hasAiConsent() {
  const { aiConsentKey } = runtime.getRuntimeConfig();
  if (!aiConsentKey) return false;
  const setting = store.state.records.settings && store.state.records.settings.app;
  return Boolean(setting && !setting.deletedAt && setting.data && setting.data[aiConsentKey] === true);
}

Page({
  data: {
    dateText: '',
    lifeMessage: '今天先从一件小事开始，慢慢来就好。',
    offline: false,
    hasPendingSave: false,
    saveIssue: false,
    todayIn: 0, todayOut: 0,
    monthOut: 0, budget: 0, budgetPct: 0,
    todayQueue: [],
    queueCount: 0,
    queueExpanded: false,
    focusTask: null,
    runningFocus: null,
    billAlerts: [],
    memoryCount: 0,
    recentRecords: [],
    firstRun: false,
    overdueCount: 0,
    lifeTools: LIFE_TOOLS,
    toolsSheetShow: false,
    aiInsight: '今天先从一件小事开始，慢慢来就好。',
    aiInsightLabel: '根据记录整理',
    aiInsightLoading: false,
    aiInsightKey: '',
    aiConsent: false,
    undoShow: false,
    undoText: '',
    /* 数值型习惯的轻量录入弹层 */
    valueSheetShow: false,
    valueForm: { id: '', name: '', unit: '', value: '' }
  },
  unsub: null,
  currentQueue: [],
  onLoad() {
    // 弹层打开时隐藏悬浮导航
    attachOverlayWatcher(this);
    // 性能方案 §5：按集合订阅 + 隐藏页只标 dirty + 同步状态变化只轻更新状态区
    this.unsubFocus = ui.bindStore(this, ['focusSessions'], () => this.renderRunningFocus());
    this.unsub = ui.bindStore(this,
      ['money', 'habit', 'plan', 'shopping', 'media', 'fitness', 'memories', 'settings', 'accounts', '__sync__'],
      () => this.render(),
      () => this.renderSyncState());
  },
  onShow() {
    this.__pageHidden = false;
    theme.applyToPage(this); share.enableShareMenu(); this.render(); this.renderRunningFocus(); this.loadInsight();
  },
  onHide() {
    this.__pageHidden = true;
    clearTimeout(this.focusDeadline);
  },
  onShareAppMessage: share.onShareAppMessage('today'),
  onShareTimeline: share.onShareTimeline('today'),
  onUnload() {
    this.onHide();
    this.unsubFocus && this.unsubFocus();
    this.unsub && this.unsub();
    clearTimeout(this.__undoTimer);
  },
  renderRunningFocus() {
    clearTimeout(this.focusDeadline);
    const draft = readFocusDraft();
    const remaining = draft ? draft.targetAt - Date.now() : 0;
    ui.diffSetData(this, { runningFocus: draft ? {
      title: draft.title || '自由专注',
      action: remaining > 0 ? '继续专注' : '记录本次'
    } : null });
    if (remaining > 0 && !this.__pageHidden) {
      this.focusDeadline = setTimeout(() => this.renderRunningFocus(), remaining);
    }
  },
  resumeFocus() {
    wx.navigateTo({ url: '/pages/focus/focus' });
  },
  renderSyncState() {
    const s = store.state;
    ui.diffSetData(this, {
      offline: s.syncState === 'offline',
      hasPendingSave: s.syncState === 'offline' && s.queue.length > 0,
      saveIssue: Boolean(s.persistError || s.rejectedWrites.length)
    });
  },
  retrySync() { return ui.retryWithFeedback(() => sync.pull()); },
  openSaveHelp() { wx.switchTab({ url: '/pages/mine/mine' }); },
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
      this.setData({ aiInsight: this.data.lifeMessage || '今天先从一件小事开始，慢慢来就好。', aiInsightLabel: '本机整理', aiInsightLoading: false, aiInsightKey: '', aiConsent: false });
      return;
    }
    if (!force && (this.data.aiInsightLoading || this.data.aiInsightKey === period)) return;
    this.setData({ aiInsightKey: period, aiInsightLoading: true, aiConsent: true });
    sync.flush().then(() => hasAiConsent() && api.getInsight('today')).then((result) => {
      if (!hasAiConsent()) return;
      const content = String(result && result.content || '').trim();
      if (!content) return;
      this.setData({
        aiInsight: content,
        aiInsightLabel: result.source === 'ai' || result.source === 'cache' ? 'AI 生成 · 仅你可见' : '根据记录整理'
      });
    }).catch(() => {
      this.setData({ aiInsightKey: '' });
    }).finally(() => this.setData({ aiInsightLoading: false }));
  },

  /*
   * 今日页派生数据（性能方案 §5）：月/日汇总、习惯、日程、待处理队列、最近记录全部在这里计算，
   * 以「相关集合版本号 + 日期」为缓存 key —— 任一相关集合变化或跨天才重算，
   * 未变化的重复 render（onShow、无关集合通知）直接复用上次结果。
   */
  computeTodayModel(t, month) {
    const s = store.state;
    const key = ['money', 'habit', 'plan', 'shopping', 'media', 'fitness', 'memories', 'accounts', 'settings']
      .map((c) => store.version(c)).join(',') + '|' + t;
    if (this.__todayModel && this.__todayModel.key === key) return this.__todayModel.model;
    // 本月/今日收支
    let monthOut = 0, tIn = 0, tOut = 0;
    for (const r of Object.values(s.records.money)) {
      if (r.deletedAt || !r.data) continue;
      const amt = toCents(r.data.amount) || 0;
      if (r.data.type === 'expense' && (r.data.date || '').slice(0, 7) === month) monthOut += amt;
      if (r.data.date === t) {
        if (r.data.type === 'income') tIn += amt;
        if (r.data.type === 'expense') tOut += amt;
      }
    }
    let budget = 0;
    const settingsRec = s.records.settings['app'];
    if (settingsRec && settingsRec.data) budget = toCents(settingsRec.data.budget) || 0;

    const queueSource = { plan: s.records.plan, habit: s.records.habit, shopping: s.records.shopping };
    const todayQueue = buildTodayQueue(queueSource, t).map((item) => ({
      ...item,
      kindText: item.kind === 'plan' ? '日程' : item.kind === 'habit' ? '习惯' : '待买',
      actionText: item.kind === 'habit' ? (item.mode === 'count' ? '+1' : item.mode === 'value' ? '记录' : '打卡') : item.kind === 'shopping' ? '买到' : '完成',
      pinText: item.pinned ? '取消置顶' : '置顶'
    }));
    const focusTask = chooseFocusTask(todayQueue);
    const memoryCount = Object.values(s.records.memories || {}).filter((record) => !record.deletedAt && record.data && String(record.data.occurredAt || '').slice(0, 10) === t).length;

    const budgetPct = budget > 0 ? Math.min(100, Math.round((monthOut / budget) * 100)) : 0;
    const overdueCount = todayQueue.filter((item) => item.overdue).length;
    const firstRun = store.COLLECTIONS.filter((collection) => collection !== 'settings').every((collection) =>
      !Object.values(s.records[collection]).some((record) => !record.deletedAt && record.data));
    /* 跨模块预算建议（只读）：待买预估 + 本月支出 超预算时提示；不自动改任何状态 */
    const budgetAdvice = buildBudgetAdvice(settingsRec, s.records.money || {}, s.records.shopping || {}, month);
    const lifeMessage = focusTask ? '可以从「' + focusTask.title + '」开始。' : '今天可以留一点时间给自己。';
    const recentRecords = [];
    for (const r of Object.values(s.records.money)) {
      if (r.deletedAt || !r.data) continue;
      recentRecords.push({
        id: r.id, kind: 'money', title: r.data.note || r.data.category || '记账',
        sub: (r.data.date === t ? '今天' : r.data.date) + ' · 财务',
        amount: (r.data.type === 'income' ? '+' : r.data.type === 'transfer' ? '↔' : '-') + '¥' + formatMoney(r.data.amount),
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
    const model = {
      monthOut: fromCents(monthOut), tIn: fromCents(tIn), tOut: fromCents(tOut), budget: fromCents(budget),
      todayQueue, focusTask, memoryCount,
      billAlerts: buildBillAlerts(s.records.accounts, s.records.money, new Date(t + 'T00:00:00')),
      budgetPct, overdueCount, firstRun, budgetAdvice, lifeMessage,
      recentRecords: recentRecords.slice(0, 5)
    };
    this.__todayModel = { key, model };
    return model;
  },

  openPastMemory() {
    if (this.data.pastMemory) wx.navigateTo({ url: '/pages/memory/memory?id=' + encodeURIComponent(this.data.pastMemory.id) });
  },

  render() {
    const now = new Date();
    const t = sync.fmtDate(now);
    const month = t.slice(0, 7);
    const model = this.computeTodayModel(t, month);
    const memories = store.state.records.memories || {};
    const memoryVersion = store.version && store.version('memories');
    const past = memoryVersion === undefined || !this.__pastMemories || this.__pastMemories.version !== memoryVersion || this.__pastMemories.date !== t
      ? Object.entries(memories).filter(([, record]) => {
        const date = String(record.data && record.data.occurredAt || '').slice(0, 10);
        return !record.deletedAt && date.slice(0, 4) < t.slice(0, 4) && date.slice(4) === t.slice(4);
      }).sort((a, b) => b[1].data.occurredAt.localeCompare(a[1].data.occurredAt))[0] : this.__pastMemories.item;
    this.__pastMemories = { version: memoryVersion, date: t, item: past };
    this.currentQueue = model.todayQueue;
    const aiConsent = hasAiConsent();
    ui.diffSetData(this, {
      dateText: (now.getMonth() + 1) + '月' + now.getDate() + '日 · ' + WEEK[now.getDay()],
      lifeMessage: model.lifeMessage,
      todayIn: model.tIn, todayOut: model.tOut,
      monthOut: model.monthOut, budget: model.budget, budgetPct: model.budgetPct,
      focusTask: model.focusTask,
      todayQueue: this.data.queueExpanded ? model.todayQueue : model.todayQueue.slice(0, 8),
      queueCount: model.todayQueue.length,
      firstRun: model.firstRun, overdueCount: model.overdueCount, budgetAdvice: model.budgetAdvice,
      billAlerts: model.billAlerts,
      memoryCount: model.memoryCount,
      pastMemory: past ? { id: past[0], content: String(past[1].data.content || '').slice(0, 100), date: past[1].data.occurredAt.slice(0, 10) } : null,
      recentRecords: model.recentRecords,
      aiConsent,
      aiInsight: aiConsent ? this.data.aiInsight : model.lifeMessage,
      aiInsightLabel: aiConsent ? this.data.aiInsightLabel : '本机整理',
      aiInsightLoading: aiConsent ? this.data.aiInsightLoading : false
    });
    this.renderSyncState();
    /* 角标：今日待处理队列条数 */
    syncTabBar(this, TAB.TODAY, { [TAB.TODAY]: model.todayQueue.length });
  },

  // ---- 交互：改数据 → sync.upsert → store.notify → 各页自渲染 ----
  /*
   * U08：查看详情与完成分离 —— 点行进详情，独立「完成」按钮才写入；
   * 计数习惯保留连点语义（不节流），完成动画只做视觉反馈、不阻塞真实写入。
   */
  toggleQueue() {
    const queueExpanded = !this.data.queueExpanded;
    this.setData({
      queueExpanded,
      todayQueue: queueExpanded ? this.currentQueue : this.currentQueue.slice(0, 8)
    });
  },
  onUndoTap() { ui.performUndo(this); },
  onQueueDetail(e) {
    const { id, kind } = e.currentTarget.dataset;
    if (ui.isRepeatedTap(this, 'queue-detail-' + kind + '-' + id, 400)) return;
    const item = this.currentQueue.find((candidate) => candidate.id === id && candidate.kind === kind);
    if (!item) return;
    if (kind === 'habit') return wx.switchTab({ url: '/pages/habit/habit' });
    if (kind === 'shopping') return wx.navigateTo({ url: '/pages/shopping/shopping?id=' + encodeURIComponent(item.sourceId) });
    return wx.navigateTo({ url: '/pages/plan/plan?id=' + encodeURIComponent(item.sourceId) +
      (item.isVirtual ? '&date=' + encodeURIComponent(item.date) : '') });
  },
  onQueueComplete(e) {
    const { id, kind } = e.currentTarget.dataset;
    const item = this.currentQueue.find((candidate) => candidate.id === id && candidate.kind === kind);
    if (!item) return;
    /* 数值型习惯打开轻量录入弹层 */
    if (kind === 'habit' && item.mode === 'value') return this.openValueSheet(item);
    /* 计数习惯允许快速连点累加，不节流、不进动画（动画不能成为真实写入的前置条件） */
    if (kind === 'habit' && item.mode === 'count') {
      this.completeQueueItem(item);
      ui.completeFeedback({});
      return;
    }
    if (ui.isRepeatedTap(this, 'queue-done-' + kind + '-' + id, 400)) return;
    const undo = this.captureQueueUndo(item);
    this.completeQueueItem(item);
    ui.completeFeedback({});
    if (undo) ui.armUndo(this, { text: '已完成', onUndo: undo });
  },
  /* 完成前的快照：撤销恢复到完成前的值（含「原本不存在」的情况） */
  captureQueueUndo(item) {
    const t = sync.fmtDate(new Date());
    if (item.kind === 'habit') {
      const def = store.state.records.habit[item.sourceId];
      if (!def || def.deletedAt) return null;
      const existing = habitUtils.findEntry(store.state.records.habit, item.sourceId, t);
      return () => {
        const currentDef = store.state.records.habit[item.sourceId];
        if (!currentDef || currentDef.deletedAt) return;
        if (existing) sync.upsert('habit', existing.data, existing.id);
        else {
          const nowEntry = habitUtils.findEntry(store.state.records.habit, item.sourceId, t);
          if (nowEntry) sync.remove('habit', nowEntry.id);
        }
      };
    }
    if (item.kind === 'shopping') {
      const record = store.state.records.shopping[item.sourceId];
      if (!record || record.deletedAt) return null;
      const wasDone = !!record.data.done;
      return () => {
        const cur = store.state.records.shopping[item.sourceId];
        if (cur && !cur.deletedAt) sync.upsert('shopping', { ...cur.data, done: wasDone }, item.sourceId);
      };
    }
    if (item.isVirtual) {
      const before = store.state.records.plan[item.id];
      const old = before && !before.deletedAt && before.data || {};
      return () => {
        const entry = occurrencePatch(store.state.records.plan, item, { done: Boolean(old.done), skipped: Boolean(old.skipped) });
        if (!before && !entry.data.completedSubtasks && entry.data.titleOverride === undefined && entry.data.timeOverride === undefined) {
          sync.remove('plan', entry.id);
        } else sync.upsert('plan', entry.data, entry.id);
      };
    }
    const record = store.state.records.plan[item.sourceId];
    if (!record || record.deletedAt) return null;
    const wasDone = !!record.data.done;
    return () => {
      const cur = store.state.records.plan[item.sourceId];
      if (cur && !cur.deletedAt) sync.upsert('plan', { ...cur.data, done: wasDone, skipped: false }, item.sourceId);
    };
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
      const entry = occurrencePatch(store.state.records.plan, item, { done: true, skipped: false });
      sync.upsert('plan', entry.data, entry.id);
      return;
    }
    const record = store.state.records.plan[item.sourceId];
    if (record && !record.deletedAt) {
      const data = { ...record.data, done: true, skipped: false };
      sync.upsert('plan', data, item.sourceId);
    }
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
    const habit = store.state.records.habit[item.sourceId];
    if (!habit || habit.deletedAt || !habit.data) return;
    this.setData({
      valueSheetShow: true,
      valueForm: { id: habit.id, name: habit.data.name, unit: habit.data.unit || '', value: String(item.value || '') }
    });
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

  /*
   * U01 快捷直达：入口携带一次性「新增」意图，目标页打开即新增表单（区别于浏览入口）。
   * money 是 tab 页经 storage 中转；plan/fitness/shopping 用页面参数，onLoad 消费一次。
   */
  goMoney() { setPendingOpen('money', '', ACTIONS.CREATE); return wx.switchTab({ url: '/pages/money/money' }); },
  goHabit() { setPendingOpen('habit', '', ACTIONS.CREATE); return wx.switchTab({ url: '/pages/habit/habit' }); },
  goLedger() { return wx.switchTab({ url: '/pages/money/money' }); },
  goAccounts(event) {
    const { id } = event.currentTarget.dataset;
    setPendingOpen('money', id, id ? ACTIONS.ACCOUNT : ACTIONS.ACCOUNTS);
    return this.goLedger();
  },
  goPlanList() { return wx.navigateTo({ url: '/pages/plan/plan' }); },
  goQueue() { wx.pageScrollTo({ selector: '#today-queue', duration: 200 }); },
  goMemory() { wx.navigateTo({ url: '/pages/memory/memory?compose=1' }); },
  goPlan() { wx.navigateTo({ url: '/pages/plan/plan?create=1' }); },
  goShopping() { wx.navigateTo({ url: '/pages/shopping/shopping?create=1' }); },
  goFitness() { wx.navigateTo({ url: '/pages/fitness/fitness?create=weight' }); },
  /* 预算设置直达记账页的预算编辑器 */
  goBudget() { setPendingOpen('money', '', ACTIONS.BUDGET); return wx.switchTab({ url: '/pages/money/money' }); },
  goReport() { wx.navigateTo({ url: '/pages/report/report' }); },
  goSearch() { wx.navigateTo({ url: '/pages/search/search' }); },
  openToolsSheet() { this.setData({ toolsSheetShow: true }); },
  closeToolsSheet() { this.setData({ toolsSheetShow: false }); },
  openLifeTool(event) {
    const url = event.currentTarget.dataset.url;
    if (!this.data.toolsSheetShow || !url) return;
    this.closeToolsSheet();
    wx.navigateTo({ url });
  },

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
