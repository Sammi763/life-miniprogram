const { fromCents, monetaryFields, toCents } = require('./amount');
const { calculateAccountBalances } = require('./ledger-utils');

const AUDIT_COLLECTIONS = ['accounts', 'money', 'moneyRules', 'settings', 'shopping'];

function moneyAdjustments(collection, id, data) {
  const changes = [];
  monetaryFields(collection, data, (target, field, path) => {
    const original = target[field];
    if (typeof original !== 'number') return;
    const cents = toCents(original);
    if (Number.isSafeInteger(cents) && original !== fromCents(cents)) changes.push({ collection, id, field: path, original, cents });
  });
  return changes;
}

function compareCents(previousCents, currentCents) {
  // Math.round 可产生 -0，报告统一输出 0。
  return { previousCents: previousCents || 0, currentCents, differenceCents: currentCents - previousCents };
}

function monthlyMoneyDifferences(money) {
  const totals = new Map();
  for (const record of Object.values(money || {})) {
    if (!record || record.deletedAt || !record.data) continue;
    const { amount, date, type } = record.data;
    if (!Number.isFinite(amount) || amount <= 0 || !['income', 'expense', 'transfer'].includes(type)) continue;
    const month = String(date || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    if (!totals.has(month)) totals.set(month, { income: [0, 0], expense: [0, 0], transfer: [0, 0] });
    const pair = totals.get(month)[type];
    pair[0] += amount;
    pair[1] += toCents(amount) || 0;
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([month, amounts]) => {
    const { income, expense, transfer } = amounts;
    return {
      month,
      income: compareCents(Math.round(income[0] * 100), income[1]),
      expense: compareCents(Math.round(expense[0] * 100), expense[1]),
      transfer: compareCents(Math.round(transfer[0] * 100), transfer[1]),
      balance: compareCents(Math.round(income[0] * 100) - Math.round(expense[0] * 100), income[1] - expense[1])
    };
  });
}

// 复现旧账户页的期初、校准与逐笔入账舍入，供发布前核对。
function previousAccountBalances(accounts, money) {
  const round = (amount) => Math.round(amount * 100) / 100;
  const balances = new Map();
  for (const { id, data } of accounts) {
    if (!['asset', 'liability'].includes(data.kind) || !String(data.name || '').trim()) continue;
    const opening = Number(data.openingBalance);
    const balance = Number.isFinite(opening) ? opening : Math.max(0, Number(data.balance) || 0);
    balances.set(id, { kind: data.kind, balance: round(round(balance) + round(Number(data.manualAdjustment) || 0)) });
  }
  function apply(id, amount) {
    const account = balances.get(id);
    if (account) account.balance = round(account.balance + (account.kind === 'asset' ? amount : -amount));
  }
  for (const { data } of money) {
    const { type, accountId, toAccountId } = data;
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (type === 'income') apply(accountId, amount);
    if (type === 'expense' || type === 'transfer') apply(accountId, -amount);
    if (type === 'transfer') apply(toAccountId, amount);
  }
  return balances;
}

function buildMoneyAudit(records) {
  const rows = {};
  const adjustments = [];
  for (const collection of AUDIT_COLLECTIONS) {
    rows[collection] = Object.entries(records[collection] || {})
      .filter(([, row]) => row && !row.deletedAt && row.data)
      .map(([key, row]) => ({ id: row.id || key, data: row.data }))
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const { id, data } of rows[collection]) adjustments.push(...moneyAdjustments(collection, id, data));
  }
  const before = previousAccountBalances(rows.accounts, rows.money);
  const after = calculateAccountBalances(rows.accounts, rows.money);
  const accounts = after.list.map(({ id, balance }) => ({
    id,
    ...compareCents(Math.round(before.get(id).balance * 100), toCents(balance))
  })).sort((a, b) => a.id.localeCompare(b.id));
  return { adjustments, months: monthlyMoneyDifferences(rows.money), accounts };
}

module.exports = { buildMoneyAudit, moneyAdjustments, monthlyMoneyDifferences };
