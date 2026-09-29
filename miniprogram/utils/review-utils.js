const { addDays, derivePlanOccurrences, valuesOfRecords } = require('./plan-utils');
const { buildMemorySummary } = require('./memory-utils');
const { isEntryDone } = require('./habit-utils');

function oneDecimal(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function buildWeeklyReview(source, weekStart) {
  if (!validDate(weekStart)) throw new Error('invalid_week_start');
  const end = addDays(weekStart, 6);
  const nextEnd = addDays(weekStart, 13);
  let income = 0;
  let expense = 0;
  valuesOfRecords(source && source.money).forEach((record) => {
    const data = record.data;
    if (data.date < weekStart || data.date > end) return;
    const amount = Number(data.amount) || 0;
    if (data.type === 'income') income += amount;
    if (data.type === 'expense') expense += amount;
  });
  const occurrences = derivePlanOccurrences(source && source.plan, weekStart, end).filter((item) => !item.skipped);
  const planDone = occurrences.filter((item) => item.done).length;
  const definitions = valuesOfRecords(source && source.habit).filter((record) => record.data.kind === 'def');
  const entries = {};
  valuesOfRecords(source && source.habit).forEach((record) => {
    if (record.data.kind === 'entry' && record.data.date >= weekStart && record.data.date <= end) entries[record.data.habitId + '|' + record.data.date] = record.data;
  });
  let habitDone = 0;
  definitions.forEach((definition) => {
    for (let offset = 0; offset < 7; offset++) {
      const data = entries[definition.id + '|' + addDays(weekStart, offset)];
      if (isEntryDone(data, definition)) habitDone++;
    }
  });
  const weights = valuesOfRecords(source && source.fitness).map((record) => record.data)
    .filter((data) => data.kind === 'weight' && data.date >= weekStart && data.date <= end && Number(data.weight) > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  /* 无数据时返回 null（页面显示「—」），不要返回 0 值对象被误读为「体重 0 kg」 */
  const weight = weights.length ? {
    start: Number(weights[0].weight),
    end: Number(weights[weights.length - 1].weight),
    change: oneDecimal(Number(weights[weights.length - 1].weight) - Number(weights[0].weight))
  } : null;
  if (weight) weight.changeText = (weight.change > 0 ? '+' : '') + weight.change;
  const nextPlans = derivePlanOccurrences(source && source.plan, addDays(end, 1), nextEnd).filter((item) => !item.done && !item.skipped).map((item) => ({
    id: item.id,
    title: item.title,
    date: item.date,
    dateShort: item.date.slice(5).replace('-', '/'),
    time: item.time || ''
  }));
  const memoryItems = valuesOfRecords(source && source.memories).filter((record) => {
    const date = String(record.data.occurredAt || '').slice(0, 10);
    return date >= weekStart && date <= end;
  });
  const memoryMap = Object.fromEntries(memoryItems.map((record) => [record.id, record]));
  return {
    period: { start: weekStart, end },
    finance: { income: oneDecimal(income), expense: oneDecimal(expense), balance: oneDecimal(income - expense) },
    plan: { total: occurrences.length, done: planDone, rate: occurrences.length ? oneDecimal(planDone * 100 / occurrences.length) : 0 },
    habit: { total: definitions.length * 7, done: habitDone, rate: definitions.length ? oneDecimal(habitDone * 100 / (definitions.length * 7)) : 0 },
    weight,
    memories: buildMemorySummary(memoryMap),
    nextPlans
  };
}

module.exports = { buildWeeklyReview };
