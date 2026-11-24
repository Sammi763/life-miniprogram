const { toCents } = require('./amount');
const { addDays, parseDate, formatDate } = require('./plan-utils');

function compactId(id, limit = 45) {
  if (id.length <= limit) return id;
  let first = 2166136261;
  let second = 5381;
  for (const letter of id) {
    first = Math.imul(first ^ letter.charCodeAt(0), 16777619);
    second = Math.imul(second, 33) ^ letter.charCodeAt(0);
  }
  return 'long_' + id.slice(0, Math.min(22, limit - 21)) + '_' + (first >>> 0).toString(36) + '_' + (second >>> 0).toString(36);
}

const cycleId = (id, date) => 'cycle-' + compactId(id) + '-' + date;
function repaymentId(id, date, part = 1) {
  if (part === 1) return 'repay-' + compactId(id) + '-' + date;
  return 'repay-' + compactId(id, 30) + '-' + date + '-' + part;
}

function repaymentDateFor(id, accountId) {
  if (typeof accountId !== 'string' || !accountId || typeof id !== 'string' || !id.startsWith('repay-')) return '';
  const match = /-(\d{4}-\d{2}-\d{2})(?:-([1-9]\d*))?$/.exec(id);
  if (!match) return '';
  const part = match[2] ? Number(match[2]) : 1;
  return Number.isSafeInteger(part) && parseDate(match[1]) && repaymentId(accountId, match[1], part) === id
    ? match[1] : '';
}

function nextRepaymentId(records, accountId, date) {
  for (let part = 1; ; part++) {
    const id = repaymentId(accountId, date, part);
    if (!records[id] || records[id].deletedAt) return id;
  }
}

function billRepaymentCents(records) {
  const totals = new Map();
  for (const [key, record] of Object.entries(records || {})) {
    if (!record || record.deletedAt || !record.data || record.data.type !== 'transfer') continue;
    const data = record.data;
    const date = repaymentDateFor(record.id || key, data.toAccountId);
    if (!date) continue;
    const cents = toCents(data.amount);
    if (!(cents > 0) || !Number.isSafeInteger(cents)) continue;
    const cycle = repaymentId(data.toAccountId, date);
    totals.set(cycle, (totals.get(cycle) || 0) + cents);
  }
  return totals;
}

function remainingBillCents(amount, totals, accountId, date) {
  return Math.max(0, (toCents(amount) || 0) - (totals.get(repaymentId(accountId, date)) || 0));
}

function monthDate(year, month, day) {
  return formatDate(new Date(year, month, Math.min(day, new Date(year, month + 1, 0).getDate())));
}

function occurrences(rule, from, until) {
  if (!rule.active || !from || from > until) return [];
  const anchor = parseDate(rule.startDate);
  const lower = parseDate(from);
  if (!anchor || !lower) return [];
  const rows = [];
  if (rule.frequency === 'weekly') {
    const offset = (anchor.getDay() - lower.getDay() + 7) % 7;
    for (let day = addDays(from, offset); day <= until; day = addDays(day, 7)) rows.push(day);
  } else {
    const month = new Date(lower.getFullYear(), lower.getMonth(), 1);
    const last = parseDate(until);
    while (month <= last) {
      const day = monthDate(month.getFullYear(), month.getMonth(), anchor.getDate());
      if (day >= from && day <= until) rows.push(day);
      month.setMonth(month.getMonth() + 1);
    }
  }
  return rows;
}

function later(a, b) { return a > b ? a : b; }

function dueCycles(rules, money, today) {
  const result = [];
  for (const [id, record] of Object.entries(rules)) {
    if (record.deletedAt || !record.data) continue;
    const { versions } = record.data;
    versions.forEach((rule, index) => {
      const from = later(rule.startDate, rule.effective);
      const next = versions[index + 1];
      const end = next && next.effective <= today ? addDays(next.effective, -1) : today;
      for (const date of occurrences(rule, from, end)) {
        const transactionId = cycleId(id, date);
        if (!money[transactionId]) result.push({ ...rule, date, id: transactionId });
      }
    });
  }
  return result.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

function nextCycle(rule, today) {
  const from = later(later(rule.startDate, rule.effective), today);
  return occurrences(rule, from, addDays(from, 35))[0] || '';
}

module.exports = { cycleId, repaymentId, repaymentDateFor, nextRepaymentId, billRepaymentCents, remainingBillCents, dueCycles, nextCycle };
