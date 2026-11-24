const store = require('../../utils/store');
const sync = require('../../utils/sync');
const ui = require('../../utils/ui');
const api = require('../../utils/api');
const {
  addDays,
  derivePlanOccurrences,
  getWeekDates,
  occurrencePatch,
  parseDate,
  summarizeOccurrences
} = require('../../utils/plan-utils');
const { buildBillAlerts } = require('../../utils/ledger-utils');
const theme = require('../../utils/theme');
const share = require('../../utils/share');

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const MONTHLY_DAY_OPTIONS = Array.from({ length: 31 }, (_, index) => String(index + 1));

function todayString() {
  return sync.fmtDate(new Date());
}

function dueAtFor(date, time) {
  if (!date || !time) return 0;
  const dueAt = new Date(date + 'T' + time + ':00').getTime();
  return Number.isFinite(dueAt) ? dueAt : 0;
}

function emptyForm(date) {
  return {
    id: '', sourceKind: 'one', title: '', date, time: '', done: false,
    repeat: 'none', repeatDay: '1', endDate: '', remind: false, pinned: false, subtasks: [], subtaskTitle: ''
  };
}

function dateText(date) {
  return date.slice(5).replace('-', '月') + '日';
}

Page({
  data: {
    offline: false,
    todayTotal: 0,
    weekRate: 0,
    weekStart: '',
    weekLabel: '',
    weekDays: [],
    selectedDate: '',
    selectedLabel: '',
    items: [],
    billAlerts: [],
    sheetShow: false,
    saving: false,
    undoShow: false,
    reminder: { enabled: false, templateId: '' },
    monthlyDayOptions: MONTHLY_DAY_OPTIONS,
    form: emptyForm('')
  },
  unsub: null,
  currentItems: [],

  onLoad(options) {
    theme.applyToPage(this);
    const today = todayString();
    this.setData({ weekStart: getWeekDates(today)[0], selectedDate: today });
    this.unsub = ui.bindStore(this, ['plan', 'settings', 'accounts', 'money', '__sync__'],
      () => this.render(),
      () => this.renderSyncState());
    this.loadReminderCapability();
    this.render();
    /* 搜索深链：直接定位到对应日程所在周并打开编辑 */
    if (options && options.id) {
      const source = store.state.records.plan[options.id];
      if (source && !source.deletedAt && source.data) {
        if (source.data.kind === 'series' && parseDate(options.date)) {
          this.setData({ weekStart: getWeekDates(options.date)[0], selectedDate: options.date });
          this.render();
          return;
        }
        this.openEditById(options.id);
      }
      return;
    }
    /* U01 一次性新增意图：今日页「排日程」直达新增表单 */
    if (options && options.create === '1') this.openAdd();
  },
  onShow() { this.__pageHidden = false; theme.applyToPage(this); share.enableShareMenu(); this.render(); },
  onShareAppMessage: share.onShareAppMessage('plan'),
  onShareTimeline: share.onShareTimeline('plan'),
  onHide() { this.__pageHidden = true; },
  onUnload() {
    this.unsub && this.unsub();
    clearTimeout(this.__undoTimer);
  },
  /* 同步状态变化只更新状态横幅，不做整页重算（性能方案 §5） */
  renderSyncState() {
    ui.diffSetData(this, { offline: store.state.syncState === 'offline' });
  },
  retrySync() { return ui.retryWithFeedback(() => sync.pull()); },
  onPullDownRefresh() {
    sync.pull().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },

  loadReminderCapability() {
    api.getReminderCapabilities().then((result) => {
      this.setData({ reminder: { enabled: Boolean(result.enabled), templateId: result.templateId || '' } });
    }).catch(() => {
      this.setData({ reminder: { enabled: false, templateId: '' } });
    });
  },

  render() {
    const today = todayString();
    const week = getWeekDates(this.data.weekStart || today);
    const selectedDate = week.includes(this.data.selectedDate) ? this.data.selectedDate : week[0];
    const records = Object.values(store.state.records.plan).filter((record) => !record.deletedAt && record.data);
    const occurrences = derivePlanOccurrences(records, week[0], week[6]);
    const stats = summarizeOccurrences(occurrences);
    const todayOccurrences = derivePlanOccurrences(records, today, today).filter((item) => !item.skipped);
    const weekDays = week.map((date, index) => {
      const dayItems = occurrences.filter((item) => item.date === date && !item.skipped);
      return {
        date,
        weekday: WEEKDAYS[index],
        day: date.slice(-2),
        total: dayItems.length,
        done: dayItems.filter((item) => item.done).length,
        isToday: date === today,
        isSelected: date === selectedDate
      };
    });
    const items = occurrences.filter((item) => item.date === selectedDate).map((item) => ({
      ...item,
      timeText: item.time || '全天',
      repeatText: item.isVirtual ? '重复事项' : '',
      overdue: !item.done && !item.skipped && item.date < today,
      reminderText: !item.done && item.reminder && item.reminder.enabled ? '到时提醒已开启' : ''
    }));
    this.currentItems = items;
    this.setData({
      offline: store.state.syncState === 'offline',
      todayTotal: todayOccurrences.length,
      weekRate: stats.rate,
      weekStart: week[0],
      weekLabel: dateText(week[0]) + ' - ' + dateText(week[6]),
      weekDays,
      selectedDate,
      selectedLabel: selectedDate === today ? '今天 · ' + dateText(selectedDate) : dateText(selectedDate),
      items,
      billAlerts: buildBillAlerts(store.state.records.accounts || {}, store.state.records.money || {}, new Date())
    });
  },

  previousWeek() { this.setData({ weekStart: addDays(this.data.weekStart, -7) }); this.render(); },
  nextWeek() { this.setData({ weekStart: addDays(this.data.weekStart, 7) }); this.render(); },
  goToday() {
    const today = todayString();
    this.setData({ weekStart: getWeekDates(today)[0], selectedDate: today });
    this.render();
  },
  selectDay(event) { this.setData({ selectedDate: event.currentTarget.dataset.date }); this.render(); },

  openAdd() {
    this.setData({ sheetShow: true, form: emptyForm(this.data.selectedDate || todayString()) });
  },
  openEdit(event) {
    const item = this.findItem(event.currentTarget.dataset.id);
    if (!item) return;
    const source = store.state.records.plan[item.sourceId || item.id];
    if (!source || source.deletedAt || !source.data) return;
    if (item.isVirtual) {
      wx.showActionSheet({
        itemList: ['只编辑这一次', '编辑整个系列'],
        success: ({ tapIndex }) => tapIndex === 0 ? this.editOccurrence(item) : this.fillFormFromSource(source, item.date)
      });
    } else this.fillFormFromSource(source, item.date);
  },
  /* 深链打开：按记录 id 直接构造表单，并把周历定位到该日程所在周 */
  openEditById(id) {
    let source = store.state.records.plan[id];
    if (!source || source.deletedAt || !source.data) return;
    /* occurrence 是重复日程的单日覆盖记录，不可直接编辑：能找到系列就打开系列表单；
       系列已不存在时只把周历定位到那天。若按一次性日程打开，保存会把 occurrence 覆写为
       one-off 形状、破坏该系列的完成/跳过语义（今日页最近记录深链到此，见 navId） */
    if (source.data.kind === 'occurrence') {
      const series = store.state.records.plan[source.data.seriesId];
      if (!(series && !series.deletedAt && series.data)) {
        const orphanDate = source.data.date || todayString();
        this.setData({ weekStart: getWeekDates(orphanDate)[0], selectedDate: orphanDate });
        this.render();
        return;
      }
      const date = source.data.date;
      this.setData({ weekStart: getWeekDates(date)[0], selectedDate: date });
      this.render();
      const item = this.findItem(id);
      if (item) this.editOccurrence(item);
      return;
    }
    const data = source.data;
    const anchorDate = data.kind === 'series' ? (data.startDate || todayString()) : (data.date || todayString());
    this.setData({ weekStart: getWeekDates(anchorDate)[0], selectedDate: anchorDate });
    this.render();
    this.fillFormFromSource(source, anchorDate);
  },
  fillFormFromSource(source, fallbackDate) {
    if (source.data.kind === 'series') {
      this.setData({
        sheetShow: true,
        form: {
          id: source.id, sourceKind: 'series', title: source.data.title || '', date: source.data.startDate || fallbackDate,
          time: source.data.time || '', done: false, repeat: source.data.repeat || 'daily',
          repeatDay: String(Number(source.data.repeatDay) || (source.data.startDate || fallbackDate || '').slice(-2) || '1'),
          endDate: source.data.endDate || '', remind: false, pinned: Boolean(source.data.pinned), subtasks: source.data.subtasks || [], subtaskTitle: ''
        }
      });
      return;
    }
    this.setData({
      sheetShow: true,
      form: {
        id: source.id, sourceKind: 'one', title: source.data.title || '', date: source.data.date || fallbackDate,
        time: source.data.time || '', done: Boolean(source.data.done), repeat: 'none', repeatDay: '1', endDate: '',
        remind: Boolean(source.data.reminder && source.data.reminder.enabled), pinned: Boolean(source.data.pinned), subtasks: source.data.subtasks || [], subtaskTitle: ''
      }
    });
  },
  editOccurrence(item) {
    this.setData({ sheetShow: true, form: {
      ...emptyForm(item.date), id: item.id, sourceKind: 'occurrence', sourceId: item.sourceId, title: item.title, time: item.time
    } });
  },
  onSubtaskTitle(event) { this.setData({ 'form.subtaskTitle': event.detail.value }); },
  addSubtask() {
    const { subtasks, subtaskTitle } = this.data.form;
    const title = String(subtaskTitle || '').trim();
    if (!title || subtasks.length >= 12) return;
    const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
    this.setData({ 'form.subtasks': subtasks.concat({ id, title, done: false }), 'form.subtaskTitle': '' });
  },
  removeSubtask(event) {
    this.setData({ 'form.subtasks': this.data.form.subtasks.filter((task) => task.id !== event.currentTarget.dataset.id) });
  },
  moveSubtask(event) {
    const tasks = this.data.form.subtasks.slice();
    const index = tasks.findIndex((task) => task.id === event.currentTarget.dataset.id);
    if (index <= 0) return;
    [tasks[index - 1], tasks[index]] = [tasks[index], tasks[index - 1]];
    this.setData({ 'form.subtasks': tasks });
  },
  patchOccurrence(item, patch) {
    const entry = occurrencePatch(store.state.records.plan, item, patch);
    sync.upsert('plan', entry.data, entry.id);
  },
  toggleSubtask(event) {
    const item = this.findItem(event.currentTarget.dataset.id);
    const task = item && item.subtasks.find((entry) => entry.id === event.currentTarget.dataset.task);
    if (!task) return;
    const tasks = item.subtasks.map((entry) => entry.id === task.id ? { ...entry, done: !entry.done } : entry);
    if (item.isVirtual) this.patchOccurrence(item, { completedSubtasks: tasks.filter((entry) => entry.done).map((entry) => entry.id) });
    else {
      const record = store.state.records.plan[item.id];
      if (record && !record.deletedAt) sync.upsert('plan', { ...record.data, subtasks: tasks }, item.id);
    }
  },
  openFocus(event) {
    const item = this.findItem(event.currentTarget.dataset.id);
    if (item) wx.navigateTo({ url: '/pages/focus/focus?kind=plan&id=' + encodeURIComponent(item.id) + '&title=' + encodeURIComponent(item.title) });
  },
  closeSheet() { if (!this.data.saving) this.setData({ sheetShow: false }); },
  noop() {},
  onTitle(event) { this.setData({ 'form.title': event.detail.value }); },
  onDate(event) { this.setData({ 'form.date': event.detail.value }); },
  onTime(event) { this.setData({ 'form.time': event.detail.value }); },
  clearTime() { this.setData({ 'form.time': '', 'form.remind': false }); },
  onDone(event) { this.setData({ 'form.done': Boolean(event.detail.value) }); },
  onReminder(event) { this.setData({ 'form.remind': Boolean(event.detail.value) }); },
  onPinned(event) { this.setData({ 'form.pinned': Boolean(event.detail.value) }); },
  setRepeat(event) {
    const repeat = event.currentTarget.dataset.repeat;
    if (this.data.form.sourceKind === 'series' && repeat === 'none') {
      wx.showToast({ title: '重复事项请使用“停止重复”', icon: 'none' });
      return;
    }
    this.setData({ 'form.repeat': repeat, 'form.remind': repeat === 'none' ? this.data.form.remind : false });
  },
  /* picker 的 event.detail.value 是选项下标（0 起），必须 +1 才是日期；
     此前直接存下标，选「15 号」实际存成 14、选「31 号」存成 30。 */
  onRepeatDay(event) { this.setData({ 'form.repeatDay': String((Number(event.detail.value) || 0) + 1) }); },

  save() {
    const form = this.data.form;
    const title = String(form.title || '').trim();
    if (!title) return wx.showToast({ title: '请填写日程标题', icon: 'none' });
    if (title.length > 30) return wx.showToast({ title: '标题最多 30 个字', icon: 'none' });
    if (!form.date) return wx.showToast({ title: '请选择日期', icon: 'none' });
    if (ui.isRepeatedTap(this, 'plan-save', 800)) return;
    if (form.sourceKind === 'occurrence') {
      this.patchOccurrence(form, { titleOverride: title, timeOverride: form.time });
      this.setData({ sheetShow: false });
      return;
    }
    const tasks = form.subtasks || [];
    if (form.repeat !== 'none') {
      const record = {
        kind: 'series', title, startDate: form.date, time: form.time || '', repeat: form.repeat,
        ...(form.endDate ? { endDate: form.endDate } : {})
      };
      // monthly 必须带固定日；其他重复类型不写 repeatDay（保持旧记录字段形状不变）
      if (form.repeat === 'monthly') {
        const day = Number(form.repeatDay);
        if (!Number.isInteger(day) || day < 1 || day > 31) return wx.showToast({ title: '请选择每月重复日期', icon: 'none' });
        record.repeatDay = day;
      }
      if (tasks.length || (form.id && store.state.records.plan[form.id] && store.state.records.plan[form.id].data.subtasks)) record.subtasks = tasks.map(({ id, title }) => ({ id, title }));
      if (form.pinned) record.pinned = true;
      sync.upsert('plan', record, form.id || undefined);
      this.setData({ sheetShow: false });
      return;
    }
    const dueAt = dueAtFor(form.date, form.time);
    const previous = store.state.records.plan[form.id];
    const reminder = previous && !previous.deletedAt && previous.data.reminder;
    const wantsReminder = form.remind && !form.done;
    const keepReminder = form.remind && reminder && reminder.enabled && reminder.dueAt === dueAt;
    const record = {
      title, date: form.date, time: form.time || '', done: Boolean(form.done),
      reminder: keepReminder ? reminder : { enabled: false }
    };
    if (tasks.length || (previous && previous.data.subtasks)) record.subtasks = tasks;
    if (form.pinned) record.pinned = true;
    const id = sync.upsert('plan', record, form.id || undefined);
    this.setData({ sheetShow: false });

    if (!wantsReminder || keepReminder) return;
    if (!this.data.reminder.enabled || dueAt <= Date.now() + 30000 || dueAt > Date.now() + 366 * 86400000) {
      wx.showToast({ title: '日程已保存，当前无法设置提醒', icon: 'none' });
      return;
    }
    return this.enableReminderAfterSave(id, dueAt, store.state.records.plan[id]);
  },

  async enableReminderAfterSave(id, dueAt, saved) {
    const accepted = await api.requestReminderSubscription(this.data.reminder.templateId);
    const current = store.state.records.plan[id];
    if (!current || !saved || current.deletedAt || current.updatedAt !== saved.updatedAt) return;
    if (!accepted) {
      wx.showToast({ title: '日程已保存，未开启提醒', icon: 'none' });
      return;
    }
    sync.upsert('plan', { ...current.data, reminder: { enabled: true, dueAt } }, id);
    try {
      await sync.flush();
      await api.scheduleReminder(id, dueAt);
      wx.showToast({ title: '日程与提醒已保存', icon: 'success' });
    } catch (error) {
      const latest = store.state.records.plan[id];
      const reminder = latest && !latest.deletedAt && latest.data.reminder;
      if (reminder && reminder.enabled && reminder.dueAt === dueAt && !latest.data.done) {
        sync.upsert('plan', { ...latest.data, reminder: { enabled: false } }, id);
        wx.showToast({ title: '日程已保存，提醒设置失败', icon: 'none' });
      }
    }
  },

  findItem(id) { return this.currentItems.find((item) => item.id === id); },
  toggle(event) {
    const item = this.findItem(event.currentTarget.dataset.id);
    if (!item) return;
    if (ui.isRepeatedTap(this, 'plan-toggle-' + item.id, 400)) return;
    if (item.isVirtual) {
      this.patchOccurrence(item, { done: !item.done, skipped: false });
      if (!item.done) ui.completeFeedback({});
      return;
    }
    const record = store.state.records.plan[item.id];
    if (record && !record.deletedAt) {
      const data = { ...record.data, done: !item.done, skipped: false };
      sync.upsert('plan', data, item.id);
      if (!item.done) ui.completeFeedback({});
    }
  },
  more(event) {
    const item = this.findItem(event.currentTarget.dataset.id);
    if (!item) return;
    const source = store.state.records.plan[item.sourceId || item.id];
    const pinLabel = source && source.data && source.data.pinned ? '取消置顶' : '置顶到今日';
    const actions = item.isVirtual ? ['跳过当天', '停止重复', pinLabel] : [pinLabel, '删除日程'];
    wx.showActionSheet({
      itemList: actions,
      itemColor: theme.activeTokens()['--red'],
      success: (result) => {
        if (!item.isVirtual) {
          if (result.tapIndex === 0) return this.togglePin(item);
          return this.removeOneOff(item);
        }
        if (result.tapIndex === 0) this.skipOccurrence(item);
        if (result.tapIndex === 1) this.stopSeries(item.sourceId);
        if (result.tapIndex === 2) this.togglePin(item);
      }
    });
  },
  togglePin(item) {
    const id = item.sourceId || item.id;
    const source = store.state.records.plan[id];
    if (source && !source.deletedAt && source.data) sync.upsert('plan', { ...source.data, pinned: !source.data.pinned }, id);
  },
  skipOccurrence(item) {
    this.patchOccurrence(item, { done: false, skipped: true });
  },
  /* 删除单次日程：立即执行 + 5 秒撤销条 */
  removeOneOff(item) {
    const record = store.state.records.plan[item.id];
    if (!record || record.deletedAt || !record.data) return;
    const undoData = record.data;
    sync.remove('plan', item.id);
    ui.armUndo(this, {
      text: '日程已删除',
      onUndo: () => {
        sync.upsert('plan', undoData, item.id);
        wx.showToast({ title: '已恢复', icon: 'success' });
      }
    });
  },
  stopSeries(sourceId) {
    const source = store.state.records.plan[sourceId];
    if (!source || source.deletedAt || !source.data) return;
    wx.showModal({
      title: '停止重复？', content: '今天及之前的完成记录会保留，之后不再生成。', confirmColor: theme.activeTokens()['--red'],
      success: (result) => {
        if (!result.confirm) return;
        sync.upsert('plan', { ...source.data, endDate: todayString() }, sourceId);
      }
    });
  },
  onUndoTap() { ui.performUndo(this); }
});
