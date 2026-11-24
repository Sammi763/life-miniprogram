const api = require('../../utils/api');
const sync = require('../../utils/sync');
const { focusDraftKey, readFocusDraft } = require('../../utils/focus-draft');
const theme = require('../../utils/theme');
const { ID_PATTERN } = require('../../utils/record-validation');

const MINUTE = 60000;
const pad = (value) => String(value).padStart(2, '0');

Page({
  data: { minutes: '25', display: '25:00', active: false, finished: false, title: '' },

  onLoad(options = {}) {
    const kind = ['plan', 'habit'].includes(options.kind) && ID_PATTERN.test(options.id || '') ? options.kind : '';
    this.source = { sourceKind: kind, sourceId: kind ? options.id : '', title: String(options.title || '').slice(0, 60) };
    this.setData({ title: this.source.title });
  },

  onShow() {
    theme.applyToPage(this);
    this.visible = true;
    this.restoreDraft();
    if (!this.key && api.getToken()) {
      api.validateSession().then(() => { if (this.visible) this.restoreDraft(); }).catch(() => {});
    }
  },
  restoreDraft() {
    this.key = focusDraftKey();
    this.session = readFocusDraft(this.key);
    if (this.session) {
      this.setData({ active: true, finished: false, title: this.session.title });
      this.startTicker();
    } else if (this.data.active) {
      this.resetDisplay();
    }
  },
  onHide() { this.visible = false; clearInterval(this.timer); },
  onUnload() { this.onHide(); },

  onMinutes(event) {
    const minutes = event.detail.value;
    this.setData({ minutes, display: (minutes || '0') + ':00' });
  },
  start() {
    if (this.session) return;
    this.restoreDraft();
    if (this.session) return;
    if (!this.key) return wx.showToast({ title: '请先联网确认账号', icon: 'none' });
    const minutes = Number(this.data.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
      return wx.showToast({ title: '请输入 1 至 120 分钟', icon: 'none' });
    }
    const startedAt = Date.now();
    const id = 'f' + startedAt.toString(36) + Math.random().toString(36).slice(2, 12);
    const session = { ...this.source, id, startedAt, targetAt: startedAt + minutes * MINUTE, date: sync.fmtDate(new Date(startedAt)) };
    try { wx.setStorageSync(this.key, session); } catch (error) {
      return wx.showToast({ title: '无法保存计时，请检查本机空间', icon: 'none' });
    }
    this.session = session;
    this.setData({ active: true, finished: false, title: session.title });
    this.startTicker();
  },
  startTicker() {
    clearInterval(this.timer);
    this.tick();
    if (this.session && !this.data.finished) this.timer = setInterval(() => this.tick(), 250);
  },
  tick() {
    if (!this.session) return;
    const seconds = Math.max(0, Math.ceil((this.session.targetAt - Date.now()) / 1000));
    const display = pad(Math.floor(seconds / 60)) + ':' + pad(seconds % 60);
    if (display !== this.data.display || (seconds === 0) !== this.data.finished) {
      this.setData({ display, finished: seconds === 0 });
    }
    if (!seconds) clearInterval(this.timer);
  },
  finish() {
    if (!this.session || this.key !== focusDraftKey()) return;
    if (readFocusDraft(this.key)?.id !== this.session.id) return this.restoreDraft();
    const { id, startedAt, targetAt, ...data } = this.session;
    const endedAt = Math.min(Date.now(), targetAt);
    if (endedAt - startedAt < 1000) return;
    sync.upsert('focusSessions', { ...data, startedAt, endedAt }, id, { createOnly: true });
    this.clearSession(true);
    wx.showToast({ title: '专注已记录' });
  },
  cancel() {
    if (!this.session) return;
    const id = this.session.id;
    wx.showModal({
      title: '放弃本次专注？',
      success: (result) => {
        if (result.confirm && this.key === focusDraftKey() && readFocusDraft(this.key)?.id === id) this.clearSession();
      }
    });
  },
  clearSession(recorded) {
    try {
      wx.removeStorageSync(this.key);
    } catch (error) {
      if (!recorded) return wx.showToast({ title: '无法移除计时，请重试', icon: 'none' });
    }
    this.session = null;
    this.resetDisplay();
  },
  resetDisplay() {
    clearInterval(this.timer);
    this.setData({ active: false, finished: false, display: this.data.minutes + ':00', title: this.source.title });
  }
});
