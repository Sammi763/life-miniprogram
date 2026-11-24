const { toCents } = require('../../utils/amount');
const store = require('../../utils/store');
const sync = require('../../utils/sync');
const ui = require('../../utils/ui');
const theme = require('../../utils/theme');
const { formatMoney } = require('../../utils/finance');

Page({
  data: { month: '', type: 'expense', category: '', rows: [], groups: [], totalText: '', limit: 50 },
  onLoad(options = {}) {
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(options.month || '') ? options.month : sync.fmtDate(new Date()).slice(0, 7);
    this.setData({ month, category: options.category || '' });
    theme.applyToPage(this);
    this.unsubscribe = ui.bindStore(this, ['money', 'accounts'], () => this.render());
    this.render();
  },
  onShow() { this.__pageHidden = false; this.render(); },
  onHide() { this.__pageHidden = true; },
  onUnload() { if (this.unsubscribe) this.unsubscribe(); },
  selectType(event) { this.setData({ type: event.currentTarget.dataset.type, category: '', limit: 50 }); this.render(); },
  selectCategory(event) { this.setData({ category: event.currentTarget.dataset.category, limit: 50 }); this.render(); },
  clearCategory() { this.setData({ category: '', limit: 50 }); this.render(); },
  selectMonth(event) { this.setData({ month: event.detail.value, limit: 50 }); this.render(); },
  more() { this.setData({ limit: this.data.limit + 50 }); this.render(); },
  render() {
    const { month, type, category, limit } = this.data;
    const { money, accounts } = store.state.records;
    const accountName = (id) => accounts[id] && !accounts[id].deletedAt ? accounts[id].data.name : '未关联账户';
    const categories = new Map();
    let total = 0;
    const rows = Object.entries(money).filter(([, row]) => !row.deletedAt && row.data && row.data.type === type && row.data.date.slice(0, 7) === month)
      .map(([id, { data }]) => {
        const name = data.category || '其他';
        const cents = toCents(data.amount) || 0;
        categories.set(name, (categories.get(name) || 0) + cents);
        return { ...data, id, name, cents };
      }).filter((row) => !category || row.name === category);
    rows.forEach((row) => { total += row.cents; });
    rows.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    const groups = Array.from(categories, ([name, cents]) => ({ name, cents, amount: formatMoney(cents / 100) }))
      .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    this.setData({
      groups, totalText: formatMoney(total / 100), hasMore: rows.length > limit,
      rows: rows.slice(0, limit).map((row) => ({
        ...row, amountText: formatMoney(row.amount),
        accountText: type === 'transfer' ? accountName(row.accountId) + ' → ' + accountName(row.toAccountId) : accountName(row.accountId)
      }))
    });
  }
});
