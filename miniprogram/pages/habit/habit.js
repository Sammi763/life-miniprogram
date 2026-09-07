const store = require('../../utils/store');
const sync = require('../../utils/sync');
const { syncTabBar } = require('../../utils/tabbar');
const theme = require('../../utils/theme');

Page({
  data: {
    offline: false,
    habits: [],
    sheetShow: false,
    form: { id: '', name: '', mode: 'check', target: '1', unit: '', pinned: false },
    modes: [{ k: 'check', label: '勾选' }, { k: 'count', label: '计数' }, { k: 'value', label: '数值' }]
  },
  unsub: null,
  onLoad() {
    theme.applyToPage(this);
    this.unsub = store.subscribe(() => this.render());
    this.render();
  },
  onShow() { theme.applyToPage(this); syncTabBar(this, 2); this.render(); },
  onUnload() { this.unsub && this.unsub(); },
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
      const target = Number(d.data.target) || 1;
      // 连续天数：从今天往回数
      let streak = 0;
      for (let i = 0; i < 365; i++) {
        const dd = new Date(); dd.setDate(dd.getDate() - i);
        const key = d.id + '|' + sync.fmtDate(dd);
        const ee = entries[key];
        const v = ee ? Number(ee.data.value) || 0 : 0;
        const ok = d.data.mode === 'check' ? v >= 1 : v >= target;
        if (ok) streak++;
        else if (i > 0) break;
        else continue; // 今天还没打卡不打断连续计数
      }
      return {
        id: d.id, name: d.data.name, mode: d.data.mode, unit: d.data.unit || '',
        target, value: val,
        done: d.data.mode === 'check' ? val >= 1 : val >= target,
        text: d.data.mode === 'check' ? (val >= 1 ? '已完成' : '今日未打卡') : val + ' / ' + target + (d.data.unit ? ' ' + d.data.unit : ''),
        streak: streak + (streak > 0 ? ' 天' : '')
      };
    }).sort((a, b) => (a.id > b.id ? 1 : -1));
    this.setData({ habits, offline: s.syncState === 'offline' });
  },

  tapHabit(e) {
    const { id, mode } = e.currentTarget.dataset;
    const t = sync.fmtDate(new Date());
    let entry = null;
    for (const r of Object.values(store.state.records.habit)) {
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
        title: '记录数值', editable: true, placeholderText: '输入今日数值',
        success: (res) => {
          if (!res.confirm) return;
          const v = Number(res.content);
          if (isNaN(v) || v < 0) return;
          sync.upsert('habit', { kind: 'entry', habitId: id, date: t, value: v }, entry && entry.id);
        }
      });
    }
  },
  editHabit(e) {
    const id = e.currentTarget.dataset.id;
    const r = store.state.records.habit[id];
    if (!r || r.deletedAt || !r.data) return;
    wx.showActionSheet({
      itemList: ['编辑习惯', '删除习惯'],
      itemColor: '#C0392B',
      success: (res) => {
        if (res.tapIndex === 0) {
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
          return;
        }
        if (res.tapIndex === 1) this.removeHabit(id);
      }
    });
  },

  removeHabit(id) {
    const record = store.state.records.habit[id];
    if (!record || record.deletedAt || !record.data) return;
    wx.showModal({
      title: '删除「' + record.data.name + '」？',
      content: '历史打卡记录也会一并删除',
      confirmColor: '#C0392B',
      success: (result) => {
        if (!result.confirm) return;
        for (const item of Object.values(store.state.records.habit)) {
          if (!item.deletedAt && item.data && (item.id === id || item.data.habitId === id)) sync.remove('habit', item.id);
        }
      }
    });
  },

  openAdd() { this.setData({ sheetShow: true, form: { id: '', name: '', mode: 'check', target: '1', unit: '', pinned: false } }); },
  closeSheet() { this.setData({ sheetShow: false }); },
  noop() { },
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
    sync.upsert('habit', data, f.id || undefined);
    this.setData({ sheetShow: false });
  }
});
