const { formatMoney } = require('./finance');
const { valuesOfRecords, derivePlanOccurrences, editedPlanOccurrences, parseDate } = require('./plan-utils');

const SOURCES = [
  { collection: 'memories', kind: 'memory', title: (data) => data.content, subtitle: (data) => (data.tags || []).join(' · '), date: (data) => String(data.occurredAt || '').slice(0, 10), text: (data) => [data.content, data.mood, ...(data.tags || [])] },
  { collection: 'media', kind: 'media', title: (data) => data.title, subtitle: (data) => data.kind === 'book' ? '书籍' : data.kind === 'movie' ? '电影' : '音乐', date: (data) => data.date, text: (data) => [data.title, data.comment, data.kind] },
  { collection: 'shopping', kind: 'shopping', title: (data) => data.name, subtitle: (data) => data.done ? '已买' : '待买', date: (data) => data.date, text: (data) => [data.name, data.note] },
  { collection: 'money', kind: 'money', title: (data) => data.note || data.category || '账目', subtitle: (data) => (data.type === 'income' ? '收入' : data.type === 'transfer' ? '转账' : '支出') + ' · ¥' + formatMoney(data.amount), date: (data) => data.date, text: (data) => [data.note, data.category, data.type] }
];

/*
 * 习惯打卡与体重（U07 范围补全）：title 依赖定义名称/记录类型，无法用静态 title 表达，
 * 在 searchAll 里按集合特殊构建。范围说明见搜索页「全部」提示文案。
 */
function buildDynamicRecords(collection, records) {
  const output = [];
  if (collection === 'habit') {
    const names = {};
    for (const record of valuesOfRecords(records)) {
      if (record.data && record.data.kind === 'def') names[record.id] = record.data.name || '习惯';
    }
    for (const record of valuesOfRecords(records)) {
      const data = record.data;
      if (!data || data.kind !== 'entry') continue;
      const name = names[data.habitId] || '习惯';
      output.push({
        record,
        title: name + ' ' + (Number(data.value) || 0),
        subtitle: '习惯打卡',
        date: String(data.date || ''),
        text: [name, String(data.value || ''), '习惯']
      });
    }
    return output;
  }
  if (collection === 'fitness') {
    for (const record of valuesOfRecords(records)) {
      const data = record.data;
      if (!data) continue;
      if (data.kind === 'weight') {
        output.push({
          record,
          title: '体重 ' + (Number(data.weight) || 0) + ' kg',
          subtitle: data.bodyfat ? '体脂 ' + data.bodyfat + '%' : '体重记录',
          date: String(data.date || ''),
          text: ['体重', String(data.weight || ''), String(data.bodyfat || '')]
        });
      } else if (data.kind === 'deficit') {
        output.push({
          record,
          title: '热量 ' + (Number(data.intake) || 0) + ' / ' + (Number(data.burned) || 0) + ' kcal',
          subtitle: '饮食与运动',
          date: String(data.date || ''),
          text: ['热量', '饮食', '运动', String(data.intake || ''), String(data.burned || '')]
        });
      }
    }
    return output;
  }
  return null;
}

function planResults(records, start, end) {
  const planMatch = (id, data, date, updatedAt, occurrence) => ({
    id, kind: 'plan', key: 'plan_' + id + (occurrence ? '_' + date : ''),
    ...(occurrence ? { occurrenceDate: date } : {}),
    title: data.title, subtitle: data.skipped ? '已跳过日程' : data.done ? '已完成日程' : '日程',
    date, updatedAt, subtasks: (data.subtasks || []).map((task) => task.title)
  });
  const occurrenceMatch = (item) => planMatch(item.sourceId, item, item.date, item.updatedAt, item.isVirtual);
  if (start && end) return derivePlanOccurrences(records, start, end).map(occurrenceMatch);
  return valuesOfRecords(records)
    .filter((record) => record.data.kind !== 'occurrence' && record.data.title)
    .map((record) => planMatch(record.id, record.data, record.data.date || record.data.startDate, record.updatedAt))
    .concat(editedPlanOccurrences(records).map(occurrenceMatch));
}

function searchAll(source = {}, options = {}) {
  source = source || {};
  options = options || {};
  const keyword = String(options.keyword || '').trim().toLocaleLowerCase();
  const { kind, start, end } = options;
  const byDate = Boolean(start && end);
  const output = [];
  const matchesDate = (date) => !byDate || (date >= start && date <= end && Boolean(parseDate(date)));
  const matchesText = (parts) => !keyword || parts.join(' ').toLocaleLowerCase().includes(keyword);
  for (const config of SOURCES) {
    if (kind && kind !== config.kind) continue;
    for (const record of valuesOfRecords(source[config.collection])) {
      const data = record.data;
      const title = config.title(data);
      const date = String(config.date(data) || '');
      if (!title || !matchesDate(date) || !matchesText(config.text(data))) continue;
      output.push({
        id: record.id, kind: config.kind, key: config.kind + '_' + record.id,
        title: String(title), subtitle: String(config.subtitle(data) || ''), date, updatedAt: record.updatedAt
      });
    }
  }
  if (!kind || kind === 'plan') {
    for (const { subtasks, ...item } of planResults(source.plan, start, end)) {
      if (!matchesText([item.title, ...subtasks])) continue;
      const matchingTask = keyword && subtasks.find((title) => matchesText([title]));
      output.push({ ...item, subtitle: matchingTask ? item.subtitle + ' · ' + matchingTask : item.subtitle });
    }
  }
  for (const collection of ['habit', 'fitness']) {
    if (kind && kind !== collection) continue;
    for (const item of buildDynamicRecords(collection, source[collection])) {
      if (!item.title || !matchesDate(item.date) || !matchesText(item.text)) continue;
      output.push({
        id: item.record.id, kind: collection, key: collection + '_' + item.record.id,
        title: item.title, subtitle: item.subtitle, date: item.date, updatedAt: item.record.updatedAt
      });
    }
  }
  return output;
}

/*
 * 关键词命中分段：把文本切成 [{text, hit}] 供 WXML 分段着色。
 * 大小写不敏感；无关键词时整体作为一段未命中文本。
 */
function splitHighlight(text, keyword) {
  const value = String(text || '');
  const target = String(keyword || '').trim().toLocaleLowerCase();
  if (!value || !target) return [{ text: value, hit: false }];
  const lower = value.toLocaleLowerCase();
  const segments = [];
  let index = 0;
  while (index < value.length) {
    const found = lower.indexOf(target, index);
    if (found < 0) {
      segments.push({ text: value.slice(index), hit: false });
      break;
    }
    if (found > index) segments.push({ text: value.slice(index, found), hit: false });
    segments.push({ text: value.slice(found, found + target.length), hit: true });
    index = found + target.length;
  }
  return segments.filter((segment) => segment.text);
}

module.exports = { searchAll, splitHighlight };
