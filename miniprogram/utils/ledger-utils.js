/* 手工账本计算。银行、支付平台和征信数据永远不会被读取或上传。 */
const { repaymentId, billRepaymentCents, remainingBillCents } = require('./money-rules');
const { toCents, fromCents } = require('./amount');

function oneDecimal(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function values(records) {
  return Object.entries(records || {}).map(([key, record]) => {
    const data = record && record.data && typeof record.data === 'object' ? record.data : record;
    if (!record || record.deletedAt || !data || typeof data !== 'object') return null;
    return { id: String(record.id || data.id || key), data, updatedAt: Number(record.updatedAt || data.updatedAt || 0) };
  }).filter(Boolean);
}

function normalizeAccount(record) {
  const data = record.data;
  if (!['asset', 'liability'].includes(data.kind) || !String(data.name || '').trim()) return null;
  const hasOpening = Number.isFinite(toCents(data.openingBalance));
  const opening = hasOpening ? toCents(data.openingBalance) : Math.max(0, toCents(data.balance) || 0);
  return {
    id: record.id,
    kind: data.kind,
    name: String(data.name).trim(),
    category: String(data.category || '其他'),
    note: String(data.note || ''),
    openingBalance: fromCents(opening),
    manualAdjustment: fromCents(toCents(data.manualAdjustment) || 0),
    currentBill: Math.max(0, fromCents(toCents(data.currentBill) || 0)),
    minimumPayment: Math.max(0, fromCents(toCents(data.minimumPayment) || 0)),
    statementDay: Number.isInteger(Number(data.statementDay)) ? Number(data.statementDay) : 0,
    dueDay: Number.isInteger(Number(data.dueDay)) ? Number(data.dueDay) : 0,
    legacyBalance: !hasOpening && Number.isFinite(toCents(data.balance))
  };
}

function changeFor(kind, direction, amount) {
  if (direction === 'income') return kind === 'asset' ? amount : -amount;
  if (direction === 'expense') return kind === 'asset' ? -amount : amount;
  if (direction === 'transferOut') return kind === 'asset' ? -amount : amount;
  if (direction === 'transferIn') return kind === 'asset' ? amount : -amount;
  return 0;
}

function calculateAccountBalances(accountRecords, moneyRecords) {
  const rows = values(accountRecords).map(normalizeAccount).filter(Boolean);
  const byId = {};
  rows.forEach((account) => {
    byId[account.id] = { ...account, flow: 0, balance: toCents(account.openingBalance) + toCents(account.manualAdjustment) };
  });
  const apply = (id, direction, amount) => {
    const account = byId[String(id || '')];
    if (!account) return;
    const delta = changeFor(account.kind, direction, amount);
    account.flow += delta;
    account.balance += delta;
  };
  values(moneyRecords).forEach((record) => {
    const data = record.data;
    const amount = toCents(data.amount);
    if (!(amount > 0)) return;
    if (data.type === 'income') apply(data.accountId, 'income', amount);
    if (data.type === 'expense') apply(data.accountId, 'expense', amount);
    if (data.type === 'transfer') {
      apply(data.accountId, 'transferOut', amount);
      apply(data.toAccountId, 'transferIn', amount);
    }
  });
  const list = Object.values(byId).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-Hans-CN') : (a.kind === 'asset' ? -1 : 1)));
  let assetTotal = 0;
  let liabilityTotal = 0;
  let assetCount = 0;
  let liabilityCount = 0;
  list.forEach((account) => {
    if (account.kind === 'liability') { liabilityTotal += account.balance; liabilityCount++; }
    else { assetTotal += account.balance; assetCount++; }
    account.flow = fromCents(account.flow);
    account.balance = fromCents(account.balance);
  });
  return {
    list,
    byId,
    overview: {
      assetTotal: fromCents(assetTotal),
      liabilityTotal: fromCents(liabilityTotal),
      netAssets: fromCents(assetTotal - liabilityTotal),
      assetCount,
      liabilityCount,
      accountCount: assetCount + liabilityCount
    }
  };
}

function summarizeMoney(records, period) {
  let income = 0;
  let expense = 0;
  let transfer = 0;
  values(records).forEach((record) => {
    const data = record.data;
    if (period && String(data.date || '').slice(0, period.length) !== period) return;
    const amount = toCents(data.amount);
    if (!(amount > 0)) return;
    if (data.type === 'income') income += amount;
    if (data.type === 'expense') expense += amount;
    if (data.type === 'transfer') transfer += amount;
  });
  return { income: fromCents(income), expense: fromCents(expense), balance: fromCents(income - expense), transfer: fromCents(transfer) };
}

function dueDateFor(day, now) {
  const base = new Date(now.getFullYear(), now.getMonth(), 1);
  const maxThisMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  let target = new Date(base.getFullYear(), base.getMonth(), Math.min(day, maxThisMonth));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (target < today) {
    const nextMax = new Date(base.getFullYear(), base.getMonth() + 2, 0).getDate();
    target = new Date(base.getFullYear(), base.getMonth() + 1, Math.min(day, nextMax));
  }
  const pad = (value) => String(value).padStart(2, '0');
  return {
    date: target.getFullYear() + '-' + pad(target.getMonth() + 1) + '-' + pad(target.getDate()),
    daysLeft: Math.round((target.getTime() - today.getTime()) / 86400000)
  };
}

function buildBillAlerts(accountRecords, moneyRecords, now, horizon) {
  const paid = billRepaymentCents(moneyRecords);
  const today = now instanceof Date ? now : new Date();
  const maxDays = horizon === undefined ? 7 : Number(horizon);
  return values(accountRecords).map(normalizeAccount).filter((account) => {
    return account && account.kind === 'liability' && account.currentBill > 0 && account.dueDay >= 1 && account.dueDay <= 31;
  }).map((account) => {
    const due = dueDateFor(account.dueDay, today);
    return {
      id: account.id,
      name: account.name,
      dueDate: due.date,
      daysLeft: due.daysLeft,
      currentBill: account.currentBill,
      paidAmount: (paid.get(repaymentId(account.id, due.date)) || 0) / 100,
      remainingBill: remainingBillCents(account.currentBill, paid, account.id, due.date) / 100,
      minimumPayment: remainingBillCents(account.minimumPayment, paid, account.id, due.date) / 100
    };
  }).filter((item) => item.daysLeft >= 0 && item.daysLeft <= maxDays && item.remainingBill > 0)
    .sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

function buildCategoryBudgetProgress(moneyRecords, categoryBudgets, month) {
  const spent = Object.create(null);
  values(moneyRecords).forEach((record) => {
    const data = record.data;
    if (data.type !== 'expense' || String(data.date || '').slice(0, 7) !== month) return;
    const amount = toCents(data.amount);
    if (!(amount > 0)) return;
    const category = String(data.category || '其他');
    spent[category] = (spent[category] || 0) + amount;
  });
  const budgets = categoryBudgets && typeof categoryBudgets === 'object' && !Array.isArray(categoryBudgets) ? categoryBudgets : {};
  const names = Object.keys(budgets);
  const rows = names.map((category) => {
    const budget = Math.max(0, toCents(budgets[category]) || 0);
    const amount = spent[category] || 0;
    const over = Math.max(0, amount - budget);
    return {
      category,
      budget: fromCents(budget),
      spent: fromCents(amount),
      remaining: fromCents(Math.max(0, budget - amount)),
      used: budget ? oneDecimal(amount * 100 / budget) : 0,
      over: fromCents(over),
      suggested: Math.ceil(Math.max(budget * 5, amount * 6) / 25000) * 50
    };
  });
  return { rows, overspent: rows.filter((row) => row.over > 0) };
}

/*
 * 跨模块预算建议（只读）：待买预估价 + 本月支出 超过用户设置的月预算时给出提示。
 * 纯计算，绝不修改预算或待买状态；页面只负责展示与跳转「我的」页预算设置。
 */
function buildBudgetAdvice(settingsRecord, moneyRecords, shoppingRecords, month) {
  const data = settingsRecord && !settingsRecord.deletedAt && settingsRecord.data ? settingsRecord.data : {};
  const budget = toCents(data.budget);
  if (!(budget > 0)) return null;
  let monthOut = 0;
  values(moneyRecords).forEach((record) => {
    const item = record.data;
    if (item.type === 'expense' && String(item.date || '').slice(0, 7) === month) monthOut += toCents(item.amount) || 0;
  });
  let pendingEstimate = 0;
  values(shoppingRecords).forEach((record) => {
    const item = record.data;
    const price = toCents(item.price);
    if (!item.done && price > 0) pendingEstimate += price;
  });
  const total = monthOut + pendingEstimate;
  if (total <= budget) return null;
  return {
    budget: fromCents(budget),
    monthOut: fromCents(monthOut),
    pendingEstimate: fromCents(pendingEstimate),
    over: fromCents(total - budget)
  };
}

module.exports = {
  buildBillAlerts,
  buildBudgetAdvice,
  buildCategoryBudgetProgress,
  calculateAccountBalances,
  summarizeMoney,
  values
};
