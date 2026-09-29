/* 手工账本计算。银行、支付平台和征信数据永远不会被读取或上传。 */
function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function oneDecimal(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function values(records) {
  const input = Array.isArray(records) ? records : Object.values(records || {});
  return input.map((record, index) => {
    const data = record && record.data && typeof record.data === 'object' ? record.data : record;
    if (!record || record.deletedAt || !data || typeof data !== 'object') return null;
    return { id: String(record.id || data.id || index), data, updatedAt: Number(record.updatedAt || data.updatedAt || 0) };
  }).filter(Boolean);
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : (fallback || 0);
}

function normalizeAccount(record) {
  const data = record.data;
  if (!['asset', 'liability'].includes(data.kind) || !String(data.name || '').trim()) return null;
  const hasOpening = Number.isFinite(Number(data.openingBalance));
  const openingBalance = hasOpening ? number(data.openingBalance) : Math.max(0, number(data.balance));
  return {
    id: record.id,
    kind: data.kind,
    name: String(data.name).trim(),
    category: String(data.category || '其他'),
    note: String(data.note || ''),
    openingBalance: round(openingBalance),
    manualAdjustment: round(number(data.manualAdjustment)),
    currentBill: Math.max(0, round(number(data.currentBill))),
    minimumPayment: Math.max(0, round(number(data.minimumPayment))),
    statementDay: Number.isInteger(Number(data.statementDay)) ? Number(data.statementDay) : 0,
    dueDay: Number.isInteger(Number(data.dueDay)) ? Number(data.dueDay) : 0,
    legacyBalance: !hasOpening && Number.isFinite(Number(data.balance))
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
    byId[account.id] = { ...account, flow: 0, balance: round(account.openingBalance + account.manualAdjustment) };
  });
  const apply = (id, direction, amount) => {
    const account = byId[String(id || '')];
    if (!account) return;
    const delta = changeFor(account.kind, direction, amount);
    account.flow = round(account.flow + delta);
    account.balance = round(account.balance + delta);
  };
  values(moneyRecords).forEach((record) => {
    const data = record.data;
    const amount = number(data.amount);
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
  });
  return {
    list,
    byId,
    overview: {
      assetTotal: round(assetTotal),
      liabilityTotal: round(liabilityTotal),
      netAssets: round(assetTotal - liabilityTotal),
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
    const amount = number(data.amount);
    if (!(amount > 0)) return;
    if (data.type === 'income') income += amount;
    if (data.type === 'expense') expense += amount;
    if (data.type === 'transfer') transfer += amount;
  });
  return { income: round(income), expense: round(expense), balance: round(income - expense), transfer: round(transfer) };
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
  // moneyRecords 保留在签名中，便于后续基于流水估算本期应还；当前只显示用户明确手工填写的账单。
  void moneyRecords;
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
      minimumPayment: account.minimumPayment
    };
  }).filter((item) => item.daysLeft >= 0 && item.daysLeft <= maxDays)
    .sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

function buildCategoryBudgetProgress(moneyRecords, categoryBudgets, month) {
  const spent = {};
  values(moneyRecords).forEach((record) => {
    const data = record.data;
    if (data.type !== 'expense' || String(data.date || '').slice(0, 7) !== month) return;
    const amount = number(data.amount);
    if (!(amount > 0)) return;
    const category = String(data.category || '其他');
    spent[category] = round((spent[category] || 0) + amount);
  });
  const budgets = categoryBudgets && typeof categoryBudgets === 'object' && !Array.isArray(categoryBudgets) ? categoryBudgets : {};
  const names = Object.keys(budgets);
  const rows = names.map((category) => {
    const budget = Math.max(0, round(number(budgets[category])));
    const amount = round(spent[category] || 0);
    const over = Math.max(0, round(amount - budget));
    return {
      category,
      budget,
      spent: amount,
      remaining: Math.max(0, round(budget - amount)),
      used: budget ? oneDecimal(amount * 100 / budget) : 0,
      over,
      suggested: Math.ceil(Math.max(budget, amount * 1.2) / 50) * 50
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
  const budget = number(data.budget);
  if (!(budget > 0)) return null;
  let monthOut = 0;
  values(moneyRecords).forEach((record) => {
    const item = record.data;
    if (item.type === 'expense' && String(item.date || '').slice(0, 7) === month) monthOut += number(item.amount);
  });
  let pendingEstimate = 0;
  values(shoppingRecords).forEach((record) => {
    const item = record.data;
    if (!item.done && number(item.price) > 0) pendingEstimate += number(item.price);
  });
  const total = round(monthOut + pendingEstimate);
  if (total <= budget) return null;
  return {
    budget: round(budget),
    monthOut: round(monthOut),
    pendingEstimate: round(pendingEstimate),
    over: round(total - budget)
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
