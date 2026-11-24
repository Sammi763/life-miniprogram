const api = require('../../utils/api');
const sync = require('../../utils/sync');
const theme = require('../../utils/theme');
const reminder = require('../../utils/reminder-client');

const STATUS = { pending: '待发送', sent: '已提交微信', failed: '失败', cancelled: '已取消' };
const pad = (value) => String(value).padStart(2, '0');

Page({
  data: { mode: 'reminders', view: 'pending', rows: [], next: null, loading: true, error: '', offline: false },

  onLoad(options) {
    const mode = options && options.mode === 'deleted' ? 'deleted' : 'reminders';
    this.setData({ mode, loading: false, habitCredits: '查询中', billCredits: '查询中' });
    wx.setNavigationBarTitle({ title: mode === 'deleted' ? '最近删除' : '提醒中心' });
    theme.applyToPage(this);
    this.reload();
    if (mode === 'reminders') reminder.fetchCaps().then((caps) => this.setData({
      habitCredits: caps && caps.habit ? caps.habit.credits : '暂不可确认',
      billCredits: caps && caps.bill ? caps.bill.credits : '暂不可确认'
    }));
  },

  changeView(event) {
    if (this.data.loading) return;
    this.setData({ view: event.currentTarget.dataset.view });
    this.reload();
  },

  async reload() {
    if (this.data.mode === 'deleted') await sync.flush().catch(() => {});
    return this.loadPage(0);
  },

  more() { if (this.data.next !== null) return this.loadPage(this.data.next); },

  async loadPage(offset) {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    const deleted = this.data.mode === 'deleted';
    const path = deleted ? '/api/memories/deleted?' : '/api/reminders?view=' + this.data.view + '&';
    try {
      const result = await api.request('GET', path + 'offset=' + offset);
      const rows = result.items.map((row) => {
        if (deleted) return row;
        const time = new Date(row.dueAt);
        return { ...row, statusText: STATUS[row.status], time: sync.fmtDate(time) + ' ' + pad(time.getHours()) + ':' + pad(time.getMinutes()) };
      });
      this.setData({ rows: offset ? this.data.rows.concat(rows) : rows, next: result.next });
    } catch (error) {
      this.setData({ error: '读取失败，请重试' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async restore(event) {
    if (this.restoring) return;
    const id = event.currentTarget.dataset.id;
    const row = this.data.rows.find((item) => item.id === id);
    if (!row) return;
    this.restoring = true;
    try {
      await api.request('POST', '/api/memories/' + encodeURIComponent(id) + '/restore', { deletedAt: row.deletedAt });
      await sync.pull();
      wx.showToast({ title: '已恢复' });
      await this.reload();
    } catch (error) {
      wx.showToast({ title: error.statusCode === 409 ? '这条随记已变更' : '恢复失败，请重试', icon: 'none' });
      if (error.statusCode === 409) await this.reload();
    } finally {
      this.restoring = false;
    }
  },

  openReminder(event) {
    const { kind, id } = event.currentTarget.dataset;
    if (kind === 'habit') return wx.switchTab({ url: '/pages/habit/habit' });
    if (kind === 'bill') {
      const account = /^bill:([^:]+):/.exec(id);
      return wx.navigateTo({ url: '/pages/bills/bills' + (account ? '?repay=' + encodeURIComponent(account[1]) : '') });
    }
    wx.navigateTo({ url: '/pages/plan/plan?id=' + encodeURIComponent(id) });
  }
});
