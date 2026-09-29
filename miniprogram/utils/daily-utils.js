const { addDays, derivePlanOccurrences, makeOccurrenceId, valuesOfRecords } = require('./plan-utils');
const { isEntryDone, entryTarget } = require('./habit-utils');

function todayHabitItems(records, date) {
  const definitions = {};
  const entries = {};
  valuesOfRecords(records).forEach((record) => {
    const data = record.data;
    if (data.kind === 'def') definitions[record.id] = record;
    if (data.kind === 'entry' && data.date === date) entries[data.habitId] = record;
  });
  return Object.keys(definitions).map((id) => {
    const record = definitions[id];
    const data = record.data;
    const entry = entries[id];
    const value = Number(entry && entry.data.value) || 0;
    const target = entryTarget(entry, record);
    return {
      id,
      kind: 'habit',
      sourceId: id,
      title: String(data.name || ''),
      subtitle: data.mode === 'check' ? (value >= 1 ? '已完成' : '轻触打卡') : value + ' / ' + target + (data.unit ? ' ' + data.unit : ''),
      mode: data.mode || 'check',
      done: isEntryDone(entry, record),
      pinned: Boolean(data.pinned),
      overdue: false,
      value,
      target
    };
  });
}

function todayPlanItems(records, date) {
  const normalized = valuesOfRecords(records);
  const direct = normalized.filter((record) => {
    const data = record.data;
    return data.kind !== 'series' && data.kind !== 'occurrence' && data.date <= date && !data.skipped;
  }).map((record) => ({
    id: record.id,
    kind: 'plan',
    sourceId: record.id,
    title: String(record.data.title || ''),
    subtitle: record.data.time || (record.data.date < date ? '已逾期' : '今天'),
    done: Boolean(record.data.done),
    pinned: Boolean(record.data.pinned),
    overdue: !record.data.done && record.data.date < date,
    isVirtual: false,
    date: record.data.date
  }));
  const virtual = derivePlanOccurrences(normalized, addDays(date, -30), date)
    .filter((item) => item.isVirtual && !item.skipped)
    .map((item) => ({
      id: item.id,
      kind: 'plan',
      sourceId: item.sourceId,
      title: item.title,
      subtitle: item.time || (item.date < date ? '已逾期' : '今天'),
      done: item.done,
      pinned: Boolean(item.pinned),
      overdue: !item.done && item.date < date,
      isVirtual: true,
      date: item.date,
      occurrenceId: makeOccurrenceId(item.sourceId, item.date)
    }));
  const newestVirtual = {};
  virtual.forEach((item) => {
    if (!newestVirtual[item.sourceId] || newestVirtual[item.sourceId].date < item.date) newestVirtual[item.sourceId] = item;
  });
  return direct.concat(Object.values(newestVirtual));
}

function todayShoppingItems(records) {
  return valuesOfRecords(records).filter((record) => record.data.name && !record.data.done).map((record) => ({
    id: record.id,
    kind: 'shopping',
    sourceId: record.id,
    title: String(record.data.name),
    subtitle: record.data.price ? '预估 ¥' + Number(record.data.price) : '待买清单',
    done: false,
    pinned: Boolean(record.data.pinned),
    overdue: false
  }));
}

function priority(item) {
  if (item.kind === 'plan' && item.overdue) return 0;
  if (item.kind === 'plan') return 1;
  if (item.kind === 'habit') return 2;
  return 3;
}

function buildTodayQueue(source, date, options) {
  const includeCompleted = Boolean(options && options.includeCompleted);
  const items = todayPlanItems(source && source.plan, date)
    .concat(todayHabitItems(source && source.habit, date), todayShoppingItems(source && source.shopping));
  return items.filter((item) => includeCompleted || !item.done).sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (priority(a) !== priority(b)) return priority(a) - priority(b);
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  }).map((item) => ({ ...item, key: item.kind + '_' + item.id }));
}

function chooseFocusTask(items) {
  return (items || []).find((item) => !item.done) || null;
}

module.exports = { buildTodayQueue, chooseFocusTask };
