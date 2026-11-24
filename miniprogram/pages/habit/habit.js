const store = require('../../utils/store');
const sync = require('../../utils/sync');
const ui = require('../../utils/ui');
const habitUtils = require('../../utils/habit-utils');
const reminderClient = require('../../utils/reminder-client');
const { returnToSearch } = require('../../utils/search-return');
const { consumePendingAction, ACTIONS } = require('../../utils/pending-open');
const { syncTabBar, attachOverlayWatcher, TAB } = require('../../utils/tabbar');
const theme = require('../../utils/theme');
const share = require('../../utils/share');

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function weekdayOptions(days) {
  return WEEKDAYS.map((label, index) => ({ label, bit: 1 << index, selected: Boolean(days & (1 << index)) }));
}

const HABIT_PRESETS = [
  { name: '喝水', mode: 'count', target: '8', unit: '杯' },
  { name: '阅读', mode: 'value', target: '20', unit: '分钟' },
  { name: '睡前整理', mode: 'check', target: '1', unit: '' }
];

Page({
  data: {
    habitPresets: HABIT_PRESETS,
    offline: false,
    habits: [],
    sheetShow: false,
    form: { id: '', name: '', mode: 'check', target: '1', unit: '', pinned: false },
    scheduleDays: habitUtils.EVERY_DAY,
    customSchedule: false,
    weekdayOptions: [],
    modes: [{ k: 'check', label: '勾选' }, { k: 'count', label: '计数' }, { k: 'value', label: '数值' }],
    valueSheetShow: false,
    valueForm: { id: '', name: '', unit: '', value: '' },
    saving: false,
    undoShow: false,
    /* 近 12 周历史热力图（展开单个习惯） */
    historyShow: '',
    historyDate: '',
    returnSearch: false,
    historyGrid: [],
    historyRange: '',
    minDate: '',
    today: '',
    /* 补录/修正过去日期的弹层 */
    backfillSheetShow: false,
    backfillForm: { habitId: '', name: '', mode: 'check', unit: '', date: '', value: '', hadEntry: false },
    /* 打卡提醒（v2.11 提醒矩阵）：开关 + 提醒时间 + 剩余额度；额度耗尽显示续订横幅 */
    habitReminder: { enabled: false, capEnabled: false, credits: 0, time: reminderClient.DEFAULT_HABIT_TIME, state: 'off', statusText: '未开启', banner: '' }
  },
  unsub: null,
  /* 最近一次能力查询结果（enabled/templateId/credits），onShow 刷新 */
  reminderCaps: null,
  openFocus(event) {
    const id = event.currentTarget.dataset.id;
    const record = store.state.records.habit[id];
    if (!record || record.deletedAt || !record.data) return;
    wx.navigateTo({ url: '/pages/focus/focus?kind=habit&id=' + encodeURIComponent(id) + '&title=' + encodeURIComponent(record.data.name) });
  },

  onLoad() {
    // 弹层打开时隐藏悬浮导航：自定义 tabBar 压在页面之上，「保存」按钮会被它盖住（详见 utils/tabbar.js）
    attachOverlayWatcher(this);
    this.unsub = ui.bindStore(this, ['habit', 'settings', '__sync__'],
      () => this.render(),
      () => this.renderSyncState());
  },
  onShow() { this.__pageHidden = false; theme.applyToPage(this); share.enableShareMenu(); this.render();
    this.consumePendingOpen();
    this.refreshReminderCaps();
  },
  /*
   * 搜索深链（U07）：结果是打卡记录（entry id）—— 展开对应习惯的历史热力图，
   * 让用户看到这条记录所在的日期；定义本身不可直接编辑。
   */
  consumePendingOpen() {
    const intent = consumePendingAction('habit');
    this.setData({ returnSearch: intent.action === ACTIONS.SEARCH });
    if (intent.action === ACTIONS.CREATE) return this.openAdd();
    if (!intent.id) return;
    const entry = store.state.records.habit[intent.id];
    if (!entry || entry.deletedAt || !entry.data || entry.data.kind !== 'entry') return;
    const habitId = entry.data.habitId;
    const def = store.state.records.habit[habitId];
    if (!def || def.deletedAt || !def.data) return;
    const today = sync.fmtDate(new Date());
    const recent = habitUtils.buildHabitHistory(store.state.records.habit, def, today);
    const date = entry.data.date;
    const anchor = date < recent.start ? date : today;
    const history = anchor === today ? recent : habitUtils.buildHabitHistory(store.state.records.habit, def, anchor);
    this.setData({
      historyShow: habitId, historyDate: date, historyGrid: history.grid,
      historyRange: history.start + ' 至 ' + anchor, minDate: recent.start
    }, () => {
      if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ selector: '#habit-' + habitId, duration: 200 });
    });
  },
  returnToSearch,
  async refreshReminderCaps() {
    const caps = await reminderClient.fetchCaps();
    if (!caps) return;
    this.reminderCaps = caps;
    if (this.__pageHidden) return;
    ui.diffSetData(this, { habitReminder: reminderClient.buildReminderView(store.state.records, 'habit', caps) });
  },
  onShareAppMessage: share.onShareAppMessage('habit'),
  onShareTimeline: share.onShareTimeline('habit'),
  onHide() { this.__pageHidden = true; },
  onUnload() {
    this.__pageHidden = true;
    this.unsub && this.unsub();
    clearTimeout(this.__undoTimer);
  },
  /* 同步状态变化只更新状态横幅，不做整页重算（性能方案 §5） */
  renderSyncState() {
    ui.diffSetData(this, { offline: store.state.syncState === 'offline' });
  },
  retrySync() { return ui.retryWithFeedback(() => sync.pull()); },
  onPullDownRefresh() { sync.pull().then(() => wx.stopPullDownRefresh()); },

  render() {
    const s = store.state;
    const now = new Date();
    const t = sync.fmtDate(now);
    const defs = [], entries = {};
    for (const r of Object.values(s.records.habit)) {
      if (r.deletedAt || !r.data) continue;
      if (r.data.kind === 'def') defs.push(r);
      else entries[r.data.habitId + '|' + r.data.date] = r;
    }
    const streakDates = [t];
    const habits = defs.map((d) => {
      const e = entries[d.id + '|' + t];
      const val = e ? Number(e.data.value) || 0 : 0;
      const target = habitUtils.entryTarget(e, d);
      const scheduled = habitUtils.isScheduled(d, t);
      // 连续天数：从今天往回数；完成判定统一走 habit-utils（entry 快照优先，缺省回退当前目标）
      let streak = 0;
      for (let i = 0; i < 365; i++) {
        if (!streakDates[i]) {
          const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
          streakDates[i] = sync.fmtDate(date);
        }
        if (!habitUtils.isScheduled(d, streakDates[i])) continue;
        const ee = entries[d.id + '|' + streakDates[i]];
        const ok = habitUtils.isEntryDone(ee, d);
        if (ok) streak++;
        else if (i > 0) break;
        else continue; // 今天还没打卡不打断连续计数
      }
      return {
        id: d.id, name: d.data.name, mode: d.data.mode, unit: d.data.unit || '',
        pinned: Boolean(d.data.pinned),
        target, value: val, scheduled,
        done: habitUtils.isEntryDone(e, d),
        text: d.data.mode === 'check' ? (val >= 1 ? '已完成' : '今日未打卡') : val + ' / ' + target + (d.data.unit ? ' ' + d.data.unit : ''),
        streak,
        restText: scheduled ? '' : '休息日 · '
      };
    });
    // 排序可预期：置顶 → 今日未完成在前 → 连续天数多的在前 → 名称
    habits.sort((a, b) => (b.scheduled - a.scheduled) || (b.pinned - a.pinned) || (a.done - b.done) || (b.streak - a.streak) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    /* 展开中的历史网格随数据变化重建（补录后立即看到格子变色） */
    let historyGrid = this.data.historyGrid, historyRange = this.data.historyRange, minDate = this.data.minDate;
    if (this.data.historyShow) {
      const def = defs.find((d) => d.id === this.data.historyShow);
      if (def) {
        const recent = habitUtils.buildHabitHistory(s.records.habit, def, t);
        const date = this.data.historyDate;
        const anchor = date && date < recent.start ? date : t;
        const history = anchor === t ? recent : habitUtils.buildHabitHistory(s.records.habit, def, anchor);
        historyGrid = history.grid;
        historyRange = history.start + ' 至 ' + anchor;
        minDate = recent.start;
      } else {
        this.data.historyShow = '';
        historyGrid = []; historyRange = ''; minDate = '';
      }
    }
    ui.diffSetData(this, {
      habits: habits.map((item) => ({ ...item, streakText: item.streak > 0 ? item.streak + ' 次' : '' })),
      offline: s.syncState === 'offline',
      today: t,
      historyGrid, historyRange, minDate,
      habitReminder: reminderClient.buildReminderView(s.records, 'habit', this.reminderCaps)
    });
    /* 角标：今日未完成的习惯数，打卡后即时刷新 */
    const undone = habits.filter((item) => item.scheduled && !item.done).length;
    syncTabBar(this, TAB.HABIT, { [TAB.HABIT]: undone });
  },

  tapHabit(e) {
    const { id, mode } = e.currentTarget.dataset;
    const t = sync.fmtDate(new Date());
    const def = store.state.records.habit[id];
    if (!def || def.deletedAt) return;
    const existing = habitUtils.findEntry(store.state.records.habit, id, t);
    const current = existing ? Number(existing.data.value) || 0 : 0;
    if (mode === 'check') {
      // 勾选是切换语义：快速双击会「打卡后立刻取消」，看起来像没反应，这里按习惯去重
      if (ui.isRepeatedTap(this, 'habit-check-' + id, 400)) return;
      const next = current >= 1 ? 0 : 1;
      this.writeEntry(def, t, next);
      if (next) ui.completeFeedback({});
    } else if (mode === 'count') {
      // 计数模式允许连点累加，不能被节流误伤（见 tests/ui-interaction.test.js 契约）
      this.writeEntry(def, t, current + 1);
      ui.completeFeedback({});
    } else {
      // 数值型：打开轻量数值弹层（带单位与 ±1），替代与全 app 风格割裂的系统 modal
      this.openValueSheet(id);
    }
  },
  /* 统一写入口：同日已有 entry 复用其 ID（含存量随机 ID），新记录用确定性 ID 保证唯一 */
  writeEntry(def, date, value) {
    const w = habitUtils.entryWrite(store.state.records.habit, def, date, value);
    sync.upsert('habit', w.data, w.id);
    return w;
  },
  /* 计数误触修正：−1，下限 0；同样允许连点 */
  tapHabitMinus(e) {
    const id = e.currentTarget.dataset.id;
    const t = sync.fmtDate(new Date());
    const def = store.state.records.habit[id];
    if (!def || def.deletedAt) return;
    const existing = habitUtils.findEntry(store.state.records.habit, id, t);
    const next = Math.max(0, (existing ? Number(existing.data.value) || 0 : 0) - 1);
    if (existing && next === Number(existing.data.value || 0)) return;
    this.writeEntry(def, t, next);
    ui.completeFeedback({});
  },

  openValueSheet(id) {
    const habit = this.data.habits.find((item) => item.id === id);
    if (!habit) return;
    this.setData({ valueSheetShow: true, valueForm: { id, name: habit.name, unit: habit.unit, value: String(habit.value || '') } });
  },
  closeValueSheet() { this.setData({ valueSheetShow: false }); },
  noop() { },
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
    if (ui.isRepeatedTap(this, 'habit-value-save', 400)) return;
    const t = sync.fmtDate(new Date());
    this.writeEntry(store.state.records.habit[form.id], t, value);
    this.setData({ valueSheetShow: false });
    ui.completeFeedback({ toast: '已记录' });
  },

  // ---- 近 12 周历史热力图：展开单个习惯，点任意格子进入补录/修正 ----
  toggleHistory(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.historyShow === id) {
      this.setData({ historyShow: '', historyDate: '', historyGrid: [], historyRange: '', minDate: '' });
      return;
    }
    const t = sync.fmtDate(new Date());
    const def = store.state.records.habit[id];
    if (!def || def.deletedAt || !def.data) return;
    const history = habitUtils.buildHabitHistory(store.state.records.habit, def, t);
    this.setData({ historyShow: id, historyDate: '', historyGrid: history.grid, historyRange: history.start + ' 至 ' + t, minDate: history.start });
  },

  // ---- 补录/修正过去日期（限近 12 周，与历史视图一致）----
  /* 补录窗口：无论热力图是否展开，日期选择与最终保存都必须落在近 12 周内 */
  backfillMinDate(todayText) {
    if (this.data.minDate) return this.data.minDate;
    const def = store.state.records.habit[this.data.backfillForm.habitId];
    if (!def || def.deletedAt) return '';
    return habitUtils.buildHabitHistory(store.state.records.habit, def, todayText).start;
  },
  withinBackfillWindow(date, todayText) {
    if (!date || date > todayText) return false;
    const min = this.backfillMinDate(todayText);
    return !min || date >= min;
  },
  /* 切换日期必须重读该日记录：数值、hadEntry（决定删除入口与保存文案）都要跟着日期走 */
  loadBackfillDay(date) {
    const form = this.data.backfillForm;
    const entry = habitUtils.findEntry(store.state.records.habit, form.habitId, date);
    const value = entry ? Number(entry.data.value) || 0 : 0;
    this.setData({ 'backfillForm.date': date, 'backfillForm.value': String(value), 'backfillForm.hadEntry': Boolean(entry) });
  },
  openBackfill(e) {
    const id = e.currentTarget.dataset.id;
    const date = e.currentTarget.dataset.date || sync.fmtDate(new Date());
    const def = store.state.records.habit[id];
    if (!def || def.deletedAt || !def.data) return;
    const t = sync.fmtDate(new Date());
    const min = habitUtils.buildHabitHistory(store.state.records.habit, def, t).start;
    if (date < min || date > t) { wx.showToast({ title: '只能补录近 12 周', icon: 'none' }); return; }
    const entry = habitUtils.findEntry(store.state.records.habit, id, date);
    this.setData({
      backfillSheetShow: true,
      minDate: min,
      backfillForm: {
        habitId: id, name: def.data.name, mode: def.data.mode || 'check', unit: def.data.unit || '',
        date, value: String(entry ? Number(entry.data.value) || 0 : 0), hadEntry: Boolean(entry)
      }
    });
  },
  closeBackfillSheet() { this.setData({ backfillSheetShow: false }); },
  onBackfillDate(e) {
    const date = e.detail.value;
    if (!this.withinBackfillWindow(date, sync.fmtDate(new Date()))) {
      wx.showToast({ title: '只能选择近 12 周内的日期', icon: 'none' });
      return;
    }
    this.loadBackfillDay(date);
  },
  onBackfillInput(e) { this.setData({ 'backfillForm.value': e.detail.value }); },
  backfillStep(e) {
    const delta = Number(e.currentTarget.dataset.delta) || 0;
    const current = Number(this.data.backfillForm.value) || 0;
    this.setData({ 'backfillForm.value': String(Math.max(0, current + delta)) });
  },
  setBackfillDone(e) { this.setData({ 'backfillForm.value': e.currentTarget.dataset.v }); },
  saveBackfill() {
    const f = this.data.backfillForm;
    if (!f.habitId || !f.date) return;
    // 保存前终检：picker 之外的任何路径都不允许写入 12 周窗口之外的日期
    if (!this.withinBackfillWindow(f.date, sync.fmtDate(new Date()))) {
      wx.showToast({ title: '只能补录近 12 周', icon: 'none' });
      return;
    }
    const value = Number(f.value);
    if (f.mode !== 'check' && (!Number.isFinite(value) || value < 0)) {
      wx.showToast({ title: '请输入正确的数值', icon: 'none' });
      return;
    }
    if (ui.isRepeatedTap(this, 'habit-backfill-save', 400)) return;
    const finalValue = f.mode === 'check' ? (value >= 1 ? 1 : 0) : value;
    const existed = habitUtils.findEntry(store.state.records.habit, f.habitId, f.date);
    this.writeEntry(store.state.records.habit[f.habitId], f.date, finalValue);
    this.setData({ backfillSheetShow: false });
    ui.completeFeedback({ toast: existed ? '已更新' : '已补录' });
  },
  /* 清除某天的打卡记录：立即删除 + 5 秒撤销，与全 app 删除范式一致 */
  clearBackfillDay() {
    const f = this.data.backfillForm;
    const entry = habitUtils.findEntry(store.state.records.habit, f.habitId, f.date);
    if (!entry) return;
    sync.remove('habit', entry.id);
    this.setData({ backfillSheetShow: false });
    ui.armUndo(this, { text: '当日打卡已删除', onUndo: () => sync.upsert('habit', entry.data, entry.id) });
  },
  onUndoTap() { ui.performUndo(this); },

  // ---- 打卡提醒（v2.11）：开关/时间写 settings 随账号同步；开启与续订时弹订阅并上报额度 ----
  async onHabitReminderToggle(e) {
    const enable = Boolean(e.detail && e.detail.value);
    if (!enable) {
      reminderClient.saveReminderSettings(store.state.records, { habitReminderEnabled: false });
      return;
    }
    if (!this.reminderCaps) {
      this.reminderCaps = await reminderClient.fetchCaps();
    }
    const result = await reminderClient.subscribeAndCredit('habit', this.reminderCaps || {});
    if (result.ok) {
      wx.showToast({ title: '提醒已开启', icon: 'success' });
    } else if (result.reason === 'unavailable') {
      wx.showToast({ title: '服务端未开启习惯提醒', icon: 'none' });
    } else if (result.reason === 'rejected') {
      wx.showToast({ title: '未同意订阅，提醒不会送达', icon: 'none' });
    } else {
      wx.showToast({ title: '额度上报失败，可稍后续订', icon: 'none' });
    }
    // 开关保存用户意图；订阅被拒时额度保持 0，由横幅引导续订
    reminderClient.saveReminderSettings(store.state.records, { habitReminderEnabled: true });
    this.refreshReminderCaps();
  },
  onHabitReminderTime(e) {
    const value = String(e.detail && e.detail.value || '');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return;
    reminderClient.saveReminderSettings(store.state.records, { habitReminderTime: value });
    wx.showToast({ title: '提醒时间已保存', icon: 'success' });
  },
  async onReminderRenew() {
    if (ui.isRepeatedTap(this, 'habit-reminder-renew', 800)) return;
    if (!this.reminderCaps) this.reminderCaps = await reminderClient.fetchCaps();
    const result = await reminderClient.subscribeAndCredit('habit', this.reminderCaps || {});
    if (result.ok) wx.showToast({ title: '已续订', icon: 'success' });
    else if (result.reason === 'rejected') wx.showToast({ title: '未同意订阅', icon: 'none' });
    else wx.showToast({ title: '续订失败，请稍后重试', icon: 'none' });
    this.refreshReminderCaps();
  },

  /* 长按卡片 = 编辑/删除入口；「管理」按钮保留为可见兜底 */
  onCardLongpress(e) {
    const id = e.currentTarget.dataset.id;
    wx.showActionSheet({
      itemList: ['编辑习惯', '删除习惯'],
      itemColor: theme.activeTokens()['--red'],
      success: (res) => {
        if (res.tapIndex === 0) this.openEditHabit(id);
        if (res.tapIndex === 1) this.removeHabit(id);
      }
    });
  },
  editHabit(e) { this.openEditHabit(e.currentTarget.dataset.id); },
  openEditHabit(id) {
    const r = store.state.records.habit[id];
    if (!r || r.deletedAt || !r.data) return;
    const days = habitUtils.scheduledWeekdays(r, sync.fmtDate(new Date())) || habitUtils.EVERY_DAY;
    this.initialScheduleDays = days;
    this.setData({
      sheetShow: true, scheduleDays: days, customSchedule: days !== habitUtils.EVERY_DAY,
      weekdayOptions: weekdayOptions(days),
      form: {
        id,
        name: r.data.name || '',
        mode: r.data.mode || 'check',
        target: String(Number(r.data.target) || 1),
        unit: r.data.unit || '',
        pinned: Boolean(r.data.pinned)
      }
    });
  },

  /* 删除习惯 = 立即删除定义与全部打卡，5 秒内可整体撤销。
     两种入口：长按 ActionSheet 直接传 id；编辑弹层内按钮传 event。 */
  removeHabit(e) {
    const id = typeof e === 'string' ? e : e.currentTarget.dataset.id;
    const record = store.state.records.habit[id];
    if (!record || record.deletedAt || !record.data) return;
    const removed = [];
    for (const item of Object.values(store.state.records.habit)) {
      if (!item.deletedAt && item.data && (item.id === id || item.data.habitId === id)) removed.push({ id: item.id, data: item.data });
    }
    removed.forEach((item) => sync.remove('habit', item.id));
    ui.armUndo(this, {
      onUndo: () => {
        removed.forEach((item) => sync.upsert('habit', item.data, item.id));
        wx.showToast({ title: '已恢复', icon: 'success' });
      }
    });
  },

  openAdd() {
    this.initialScheduleDays = habitUtils.EVERY_DAY;
    this.setData({
      sheetShow: true, scheduleDays: habitUtils.EVERY_DAY, customSchedule: false,
      weekdayOptions: weekdayOptions(habitUtils.EVERY_DAY),
      form: { id: '', name: '', mode: 'check', target: '1', unit: '', pinned: false }
    });
  },
  chooseSchedule(event) {
    const customSchedule = event.currentTarget.dataset.mode === 'custom';
    const days = customSchedule ? this.data.scheduleDays : habitUtils.EVERY_DAY;
    this.setData({ customSchedule, scheduleDays: days, weekdayOptions: weekdayOptions(days) });
  },
  toggleWeekday(event) {
    const bit = Number(event.currentTarget.dataset.bit);
    const days = this.data.scheduleDays ^ bit;
    this.setData({ scheduleDays: days, weekdayOptions: weekdayOptions(days) });
  },
  applyPreset(event) {
    if (this.data.form.id) return;
    const preset = HABIT_PRESETS.find((item) => item.name === event.currentTarget.dataset.name);
    if (preset) this.setData({ form: { ...this.data.form, ...preset } });
  },
  closeSheet() { if (!this.data.saving) this.setData({ sheetShow: false }); },
  setName(e) { this.setData({ 'form.name': e.detail.value }); },
  setTarget(e) { this.setData({ 'form.target': e.detail.value }); },
  setUnit(e) { this.setData({ 'form.unit': e.detail.value }); },
  setMode(e) { this.setData({ 'form.mode': e.currentTarget.dataset.k }); },
  onPinned(e) { this.setData({ 'form.pinned': Boolean(e.detail.value) }); },
  save() {
    const f = this.data.form;
    const name = String(f.name || '').trim();
    if (!name) { wx.showToast({ title: '给习惯起个名字', icon: 'none' }); return; }
    if (name.length > 12) { wx.showToast({ title: '习惯名最多 12 个字', icon: 'none' }); return; }
    const mode = ['check', 'count', 'value'].includes(f.mode) ? f.mode : 'check';
    const targetInput = Number(f.target);
    if (mode !== 'check' && (!Number.isFinite(targetInput) || targetInput <= 0 || targetInput > 1000000)) {
      wx.showToast({ title: '请输入正确的每日目标', icon: 'none' });
      return;
    }
    const unit = String(f.unit || '').trim();
    if (unit.length > 6) { wx.showToast({ title: '单位最多 6 个字', icon: 'none' }); return; }
    const target = mode === 'check' ? 1 : targetInput;
    const data = { kind: 'def', name, mode, target, unit };
    if (f.pinned) data.pinned = true;
    const days = this.data.scheduleDays;
    if (!days) return wx.showToast({ title: '请至少选择一个星期几', icon: 'none' });
    const existing = f.id && store.state.records.habit[f.id];
    if (f.id && (!existing || existing.deletedAt)) {
      return wx.showToast({ title: '这个习惯已删除', icon: 'none' });
    }
    const schedule = existing && days === this.initialScheduleDays
      ? existing.data.schedule
      : habitUtils.updateSchedule(existing, sync.fmtDate(new Date()), days);
    if (schedule) data.schedule = schedule;
    if (ui.isRepeatedTap(this, 'habit-save', 800)) return;
    this.setData({ saving: true });
    sync.upsert('habit', data, f.id || undefined);
    this.setData({ sheetShow: false, saving: false });
    ui.completeFeedback({ toast: '已保存' });
  }
});
