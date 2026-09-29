const store = require('../../utils/store');
const sync = require('../../utils/sync');
const ui = require('../../utils/ui');
const habitUtils = require('../../utils/habit-utils');
const { syncTabBar, attachOverlayWatcher, TAB } = require('../../utils/tabbar');
const theme = require('../../utils/theme');
const share = require('../../utils/share');

Page({
  data: {
    offline: false,
    habits: [],
    sheetShow: false,
    form: { id: '', name: '', mode: 'check', target: '1', unit: '', pinned: false },
    modes: [{ k: 'check', label: '勾选' }, { k: 'count', label: '计数' }, { k: 'value', label: '数值' }],
    valueSheetShow: false,
    valueForm: { id: '', name: '', unit: '', value: '' },
    saving: false,
    undoShow: false,
    /* 近 12 周历史热力图（展开单个习惯） */
    historyShow: '',
    historyGrid: [],
    historyRange: '',
    minDate: '',
    today: '',
    /* 补录/修正过去日期的弹层 */
    backfillSheetShow: false,
    backfillForm: { habitId: '', name: '', mode: 'check', unit: '', date: '', value: '', hadEntry: false }
  },
  unsub: null,
  onLoad() {
    theme.applyToPage(this);
    // 弹层打开时隐藏悬浮导航：自定义 tabBar 压在页面之上，「保存」按钮会被它盖住（详见 utils/tabbar.js）
    attachOverlayWatcher(this);
    this.unsub = store.subscribe(() => this.render());
    this.render();
  },
  onShow() { theme.applyToPage(this); share.enableShareMenu(); this.render(); },
  onShareAppMessage: share.onShareAppMessage('habit'),
  onShareTimeline: share.onShareTimeline('habit'),
  onUnload() {
    this.unsub && this.unsub();
    clearTimeout(this.__undoTimer);
  },
  retrySync() { return ui.retryWithFeedback(() => sync.pull()); },
  onPullDownRefresh() { sync.pull().then(() => wx.stopPullDownRefresh()); },

  render() {
    const s = store.state;
    const t = sync.fmtDate(new Date());
    const defs = [], entries = {};
    for (const r of Object.values(s.records.habit)) {
      if (r.deletedAt || !r.data) continue;
      if (r.data.kind === 'def') defs.push(r);
      else entries[r.data.habitId + '|' + r.data.date] = r;
    }
    const habits = defs.map((d) => {
      const e = entries[d.id + '|' + t];
      const val = e ? Number(e.data.value) || 0 : 0;
      const target = habitUtils.entryTarget(e, d);
      // 连续天数：从今天往回数；完成判定统一走 habit-utils（entry 快照优先，缺省回退当前目标）
      let streak = 0;
      for (let i = 0; i < 365; i++) {
        const dd = new Date(); dd.setDate(dd.getDate() - i);
        const ee = entries[d.id + '|' + sync.fmtDate(dd)];
        const ok = habitUtils.isEntryDone(ee, d);
        if (ok) streak++;
        else if (i > 0) break;
        else continue; // 今天还没打卡不打断连续计数
      }
      return {
        id: d.id, name: d.data.name, mode: d.data.mode, unit: d.data.unit || '',
        pinned: Boolean(d.data.pinned),
        target, value: val,
        done: habitUtils.isEntryDone(e, d),
        text: d.data.mode === 'check' ? (val >= 1 ? '已完成' : '今日未打卡') : val + ' / ' + target + (d.data.unit ? ' ' + d.data.unit : ''),
        streak
      };
    });
    // 排序可预期：置顶 → 今日未完成在前 → 连续天数多的在前 → 名称
    habits.sort((a, b) => (b.pinned - a.pinned) || (a.done - b.done) || (b.streak - a.streak) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    /* 展开中的历史网格随数据变化重建（补录后立即看到格子变色） */
    let historyGrid = this.data.historyGrid, historyRange = this.data.historyRange, minDate = this.data.minDate;
    if (this.data.historyShow) {
      const def = defs.find((d) => d.id === this.data.historyShow);
      if (def) {
        const history = habitUtils.buildHabitHistory(s.records.habit, def, t);
        historyGrid = history.grid;
        historyRange = history.start + ' 至 ' + t;
        minDate = history.start;
      } else {
        this.data.historyShow = '';
        historyGrid = []; historyRange = ''; minDate = '';
      }
    }
    this.setData({
      habits: habits.map((item) => ({ ...item, streakText: item.streak > 0 ? item.streak + ' 天' : '' })),
      offline: s.syncState === 'offline',
      today: t,
      historyGrid, historyRange, minDate
    });
    /* 角标：今日未完成的习惯数，打卡后即时刷新 */
    const undone = habits.filter((item) => !item.done).length;
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
      this.setData({ historyShow: '', historyGrid: [], historyRange: '', minDate: '' });
      return;
    }
    const t = sync.fmtDate(new Date());
    const def = store.state.records.habit[id];
    if (!def || def.deletedAt || !def.data) return;
    const history = habitUtils.buildHabitHistory(store.state.records.habit, def, t);
    this.setData({ historyShow: id, historyGrid: history.grid, historyRange: history.start + ' 至 ' + t, minDate: history.start });
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
    this.setData({
      sheetShow: true,
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

  openAdd() { this.setData({ sheetShow: true, form: { id: '', name: '', mode: 'check', target: '1', unit: '', pinned: false } }); },
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
    if (ui.isRepeatedTap(this, 'habit-save', 800)) return;
    this.setData({ saving: true });
    sync.upsert('habit', data, f.id || undefined);
    this.setData({ sheetShow: false, saving: false });
    ui.completeFeedback({ toast: '已保存' });
  }
});
