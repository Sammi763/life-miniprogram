const store = require('../../utils/store');
const sync = require('../../utils/sync');
const { pickSettings } = require('../../utils/settings-utils');
const theme = require('../../utils/theme');

const WEEKDAYS = [
  { value: 1, label: '周一' }, { value: 2, label: '周二' }, { value: 3, label: '周三' },
  { value: 4, label: '周四' }, { value: 5, label: '周五' }, { value: 6, label: '周六' }, { value: 7, label: '周日' }
];

function dateString(date) { return sync.fmtDate(date); }
function addDays(date, amount) { const result = new Date(date); result.setDate(result.getDate() + amount); return result; }
function monday(date) { const result = new Date(date); const day = result.getDay() || 7; result.setDate(result.getDate() - day + 1); return result; }
function shortDate(date) { return date.slice(5).replace('-', '/'); }
function planWeekStart(record) { return record && record.data && (record.data.weekStart || record.data.date) || ''; }

Page({
  data: {
    offline: false,
    range: 7,
    latest: null,
    latestRows: [],
    bmi: '—',
    bmiLabel: '先设置身高',
    bmiClass: '',
    heightInput: '',
    targetWeightInput: '',
    targetWeight: 0,
    targetDiff: '—',
    targetProgress: 0,
    chartEmpty: false,
    deficits: [],
    deficitTotal: 0,
    weekdays: WEEKDAYS,
    weekStart: '',
    planDayLabel: '周一',
    plans: [],
    weightSheet: false,
    deficitSheet: false,
    planSheet: false,
    settingsSheet: false,
    weightForm: { id: '', date: '', weight: '', bodyfat: '' },
    deficitForm: { id: '', date: '', intake: '', burned: '' },
    planForm: { id: '', weekday: 1, content: '', done: false }
  },
  unsub: null,
  chartRecords: [],

  onLoad() {
    theme.applyToPage(this);
    this.unsub = store.subscribe(() => this.render());
    this.render();
  },
  onShow() { theme.applyToPage(this); this.render(); },
  onUnload() { this.unsub && this.unsub(); },
  onPullDownRefresh() {
    sync.pull().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },

  render() {
    const records = Object.values(store.state.records.fitness).filter((record) => !record.deletedAt && record.data);
    const byDate = {};
    records.filter((record) => record.data.kind === 'weight' && record.data.date && Number(record.data.weight) > 0)
      .forEach((record) => {
        if (!byDate[record.data.date] || byDate[record.data.date].updatedAt < record.updatedAt) byDate[record.data.date] = record;
      });
    const weights = Object.keys(byDate).sort().map((date) => ({
      id: byDate[date].id,
      date,
      dateText: shortDate(date),
      weight: Number(byDate[date].data.weight),
      bodyfat: Number(byDate[date].data.bodyfat) > 0 ? Number(byDate[date].data.bodyfat) : 0,
      updatedAt: byDate[date].updatedAt
    }));
    this.chartRecords = weights.slice(-this.data.range);
    const latest = weights[weights.length - 1] || null;
    const settings = store.state.records.settings.app && store.state.records.settings.app.data || {};
    const height = Number(settings.height) || 0;
    const targetWeight = Number(settings.targetWeight) || 0;
    const bmiValue = latest && height > 0 ? latest.weight / Math.pow(height / 100, 2) : 0;
    const bmiInfo = bmiValue ? this.getBmiInfo(bmiValue) : { label: height ? '记录体重后计算' : '先设置身高', className: '' };
    const targetDiff = latest && targetWeight ? (latest.weight - targetWeight).toFixed(1) : '—';
    const targetProgress = latest && targetWeight ? Math.min(100, Math.round((targetWeight / latest.weight) * 100)) : 0;
    const deficits = records.filter((record) => record.data.kind === 'deficit' && record.data.date)
      .map((record) => ({
        id: record.id, date: record.data.date, dateText: shortDate(record.data.date),
        intake: Number(record.data.intake) || 0, burned: Number(record.data.burned) || 0,
        deficit: (Number(record.data.burned) || 0) - (Number(record.data.intake) || 0), updatedAt: record.updatedAt
      })).sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt - a.updatedAt).slice(0, 7);
    const deficitTotal = deficits.reduce((sum, item) => sum + item.deficit, 0);
    const weekStart = dateString(monday(new Date()));
    const planMap = {};
    records.filter((record) => record.data.kind === 'plan' && record.data.content && planWeekStart(record) === weekStart)
      .forEach((record) => {
        const key = Number(record.data.weekday);
        if (!planMap[key] || planMap[key].updatedAt < record.updatedAt) planMap[key] = record;
      });
    const plans = WEEKDAYS.map((weekday) => {
      const record = planMap[weekday.value];
      return record ? { id: record.id, weekday: weekday.value, day: weekday.label, content: record.data.content, done: !!record.data.done } : null;
    }).filter(Boolean);
    this.setData({
      offline: store.state.syncState === 'offline',
      latest: latest ? { ...latest, weightText: latest.weight.toFixed(1), bodyfatText: latest.bodyfat ? latest.bodyfat.toFixed(1) + '%' : '未记录' } : null,
      latestRows: weights.slice(-10).reverse().map((record) => ({
        ...record,
        weightText: record.weight.toFixed(1),
        bodyfatText: record.bodyfat ? record.bodyfat.toFixed(1) + '%' : '未记录'
      })),
      bmi: bmiValue ? bmiValue.toFixed(1) : '—',
      bmiLabel: bmiInfo.label,
      bmiClass: bmiInfo.className,
      heightInput: settings.height ? String(settings.height) : '',
      targetWeightInput: settings.targetWeight ? String(settings.targetWeight) : '',
      targetWeight,
      targetDiff,
      targetProgress,
      chartEmpty: this.chartRecords.length === 0,
      deficits,
      deficitTotal,
      plans,
      weekStart
    }, () => this.drawChart());
  },

  getBmiInfo(value) {
    if (value < 18.5) return { label: '偏瘦', className: 'bmi-thin' };
    if (value < 24) return { label: '正常', className: 'bmi-normal' };
    if (value < 28) return { label: '超重', className: 'bmi-over' };
    return { label: '肥胖', className: 'bmi-high' };
  },
  setRange(event) { this.setData({ range: Number(event.currentTarget.dataset.range) }); this.render(); },
  drawChart() {
    const palette = theme.getTheme(this.data.themeId).tokens;
    const gridColor = palette['--line'];
    const mutedColor = palette['--ink-2'];
    const accentColor = palette['--accent'];
    const context = wx.createCanvasContext('weightChart', this);
    const width = 702;
    const height = 360;
    context.clearRect(0, 0, width, height);
    context.setStrokeStyle(gridColor);
    context.setLineWidth(1);
    for (let i = 0; i < 4; i++) {
      const y = 44 + i * 82;
      context.beginPath(); context.moveTo(42, y); context.lineTo(width - 24, y); context.stroke();
    }
    if (!this.chartRecords.length) {
      context.setFillStyle(mutedColor); context.setFontSize(14); context.fillText('记录体重后，这里会出现趋势', 245, 190); context.draw(); return;
    }
    const values = this.chartRecords.map((record) => record.weight);
    const min = Math.min(...values) - 1;
    const max = Math.max(...values) + 1;
    const xStep = this.chartRecords.length === 1 ? 0 : (width - 78) / (this.chartRecords.length - 1);
    const point = (index, value) => ({ x: 42 + index * xStep, y: 44 + (max - value) * 250 / (max - min) });
    context.setStrokeStyle(accentColor); context.setLineWidth(4); context.beginPath();
    this.chartRecords.forEach((record, index) => { const p = point(index, record.weight); index ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y); });
    context.stroke();
    context.setFillStyle(accentColor);
    this.chartRecords.forEach((record, index) => { const p = point(index, record.weight); context.beginPath(); context.arc(p.x, p.y, 7, 0, Math.PI * 2); context.fill(); });
    if (context.setLineDash) context.setLineDash([8, 8]);
    context.setStrokeStyle(mutedColor); context.setLineWidth(2); context.beginPath();
    this.chartRecords.forEach((record, index) => {
      const windowRecords = this.chartRecords.slice(Math.max(0, index - 6), index + 1);
      const average = windowRecords.reduce((sum, item) => sum + item.weight, 0) / windowRecords.length;
      const p = point(index, average); index ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y);
    });
    context.stroke();
    if (context.setLineDash) context.setLineDash([]);
    context.setFillStyle(mutedColor); context.setFontSize(12);
    this.chartRecords.forEach((record, index) => { const p = point(index, record.weight); context.fillText(record.dateText, p.x - 18, 330); });
    context.draw();
  },

  openWeight() { this.setData({ weightSheet: true, weightForm: { id: '', date: dateString(new Date()), weight: '', bodyfat: '' } }); },
  editWeight(event) {
    const id = event.currentTarget.dataset.id;
    const record = store.state.records.fitness[id];
    if (!record || record.deletedAt) return;
    this.setData({ weightSheet: true, weightForm: { id, date: record.data.date, weight: String(record.data.weight), bodyfat: record.data.bodyfat ? String(record.data.bodyfat) : '' } });
  },
  closeWeight() { this.setData({ weightSheet: false }); },
  onWeightDate(event) { this.setData({ 'weightForm.date': event.detail.value }); },
  onWeight(event) { this.setData({ 'weightForm.weight': event.detail.value }); },
  onBodyfat(event) { this.setData({ 'weightForm.bodyfat': event.detail.value }); },
  saveWeight() {
    const form = this.data.weightForm;
    const weight = Math.round(Number(form.weight) * 10) / 10;
    const bodyfat = form.bodyfat === '' ? 0 : Math.round(Number(form.bodyfat) * 10) / 10;
    if (!(weight > 0) || weight > 500) return wx.showToast({ title: '请输入正确体重', icon: 'none' });
    if (bodyfat < 0 || bodyfat >= 100 || !Number.isFinite(bodyfat)) return wx.showToast({ title: '请输入正确体脂', icon: 'none' });
    sync.upsert('fitness', { kind: 'weight', date: form.date || dateString(new Date()), weight, bodyfat }, form.id || undefined);
    this.closeWeight();
  },
  removeWeight(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({ title: '删除这条体重记录？', confirmColor: '#C0392B', success: (result) => { if (result.confirm) sync.remove('fitness', id); } });
  },

  openDeficit() { this.setData({ deficitSheet: true, deficitForm: { id: '', date: dateString(new Date()), intake: '', burned: '' } }); },
  closeDeficit() { this.setData({ deficitSheet: false }); },
  onDeficitDate(event) { this.setData({ 'deficitForm.date': event.detail.value }); },
  onIntake(event) { this.setData({ 'deficitForm.intake': event.detail.value }); },
  onBurned(event) { this.setData({ 'deficitForm.burned': event.detail.value }); },
  saveDeficit() {
    const form = this.data.deficitForm;
    const intake = Number(form.intake); const burned = Number(form.burned);
    if (!Number.isFinite(intake) || intake < 0 || !Number.isFinite(burned) || burned < 0) return wx.showToast({ title: '请输入正确热量', icon: 'none' });
    sync.upsert('fitness', { kind: 'deficit', date: form.date || dateString(new Date()), intake, burned }, form.id || undefined);
    this.closeDeficit();
  },
  removeDeficit(event) { wx.showModal({ title: '删除这条热量记录？', confirmColor: '#C0392B', success: (result) => { if (result.confirm) sync.remove('fitness', event.currentTarget.dataset.id); } }); },

  findCurrentWeekPlan(weekday) {
    const weekStart = dateString(monday(new Date()));
    let matched = null;
    for (const record of Object.values(store.state.records.fitness)) {
      if (!record.deletedAt && record.data && record.data.kind === 'plan' && Number(record.data.weekday) === Number(weekday) && planWeekStart(record) === weekStart) {
        if (!matched || (matched.updatedAt || 0) < (record.updatedAt || 0)) matched = record;
      }
    }
    return matched;
  },
  openPlan() {
    const firstAvailable = WEEKDAYS.find((weekday) => !this.findCurrentWeekPlan(weekday.value)) || WEEKDAYS[0];
    const record = this.findCurrentWeekPlan(firstAvailable.value);
    this.setData({
      planSheet: true,
      planDayLabel: firstAvailable.label,
      planForm: record
        ? { id: record.id, weekday: firstAvailable.value, content: record.data.content || '', done: !!record.data.done }
        : { id: '', weekday: firstAvailable.value, content: '', done: false }
    });
  },
  editPlan(event) {
    const id = event.currentTarget.dataset.id; const record = store.state.records.fitness[id];
    if (!record || record.deletedAt) return;
    const weekday = Number(record.data.weekday);
    this.setData({ planSheet: true, planDayLabel: (WEEKDAYS[weekday - 1] || WEEKDAYS[0]).label, planForm: { id, weekday, content: record.data.content || '', done: !!record.data.done } });
  },
  closePlan() { this.setData({ planSheet: false }); },
  onPlanDay(event) {
    const weekday = Number(event.detail.value) + 1;
    const record = this.findCurrentWeekPlan(weekday);
    if (record && record.id !== this.data.planForm.id) {
      this.setData({
        planDayLabel: WEEKDAYS[weekday - 1].label,
        planForm: { id: record.id, weekday, content: record.data.content || '', done: !!record.data.done }
      });
      return;
    }
    this.setData({ 'planForm.weekday': weekday, planDayLabel: WEEKDAYS[weekday - 1].label });
  },
  onPlanContent(event) { this.setData({ 'planForm.content': event.detail.value }); },
  onPlanDone(event) { this.setData({ 'planForm.done': !!event.detail.value }); },
  savePlan() {
    const form = this.data.planForm;
    const content = String(form.content || '').trim();
    if (!content) return wx.showToast({ title: '请填写运动项', icon: 'none' });
    if (content.length > 40) return wx.showToast({ title: '运动项最多 40 个字', icon: 'none' });
    const weekday = Number(form.weekday);
    if (!WEEKDAYS.some((item) => item.value === weekday)) return wx.showToast({ title: '请选择正确的星期', icon: 'none' });
    const weekStart = dateString(monday(new Date()));
    const existing = form.id ? null : this.findCurrentWeekPlan(weekday);
    sync.upsert('fitness', {
      kind: 'plan',
      weekday,
      content,
      done: !!form.done,
      date: weekStart,
      weekStart
    }, form.id || (existing && existing.id) || undefined);
    this.closePlan();
  },
  togglePlan(event) {
    const record = store.state.records.fitness[event.currentTarget.dataset.id];
    if (record && !record.deletedAt) sync.upsert('fitness', { ...record.data, done: !record.data.done }, record.id);
  },
  removePlan(event) { wx.showModal({ title: '删除这项计划？', confirmColor: '#C0392B', success: (result) => { if (result.confirm) sync.remove('fitness', event.currentTarget.dataset.id); } }); },

  openSettings() {
    const settings = store.state.records.settings.app && store.state.records.settings.app.data || {};
    this.setData({ settingsSheet: true, heightInput: settings.height ? String(settings.height) : '', targetWeightInput: settings.targetWeight ? String(settings.targetWeight) : '' });
  },
  closeSettings() { this.setData({ settingsSheet: false }); },
  onHeight(event) { this.setData({ heightInput: event.detail.value }); },
  onTargetWeight(event) { this.setData({ targetWeightInput: event.detail.value }); },
  saveSettings() {
    const height = Number(this.data.heightInput); const targetWeight = Number(this.data.targetWeightInput);
    if (height && (height < 80 || height > 250)) return wx.showToast({ title: '身高范围应为 80～250 cm', icon: 'none' });
    if (targetWeight && (targetWeight < 20 || targetWeight > 300)) return wx.showToast({ title: '目标体重范围不正确', icon: 'none' });
    const old = pickSettings(store.state.records.settings.app && store.state.records.settings.app.data);
    sync.upsert('settings', { ...old, height: height || 0, targetWeight: targetWeight || 0 }, 'app');
    this.closeSettings();
  }
});
