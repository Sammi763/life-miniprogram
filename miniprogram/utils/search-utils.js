const { valuesOfRecords } = require('./plan-utils');

const SOURCES = [
  { collection: 'memories', kind: 'memory', title: (data) => data.content, subtitle: (data) => (data.tags || []).join(' · '), date: (data) => String(data.occurredAt || '').slice(0, 10), text: (data) => [data.content, data.mood, ...(data.tags || [])] },
  { collection: 'media', kind: 'media', title: (data) => data.title, subtitle: (data) => data.kind === 'book' ? '书籍' : data.kind === 'movie' ? '电影' : '音乐', date: (data) => data.date, text: (data) => [data.title, data.comment, data.kind] },
  { collection: 'shopping', kind: 'shopping', title: (data) => data.name, subtitle: (data) => data.done ? '已买' : '待买', date: (data) => data.date, text: (data) => [data.name, data.note] },
  { collection: 'money', kind: 'money', title: (data) => data.note || data.category || '账目', subtitle: (data) => (data.type === 'income' ? '收入' : data.type === 'transfer' ? '转账' : '支出') + ' · ¥' + Number(data.amount || 0), date: (data) => data.date, text: (data) => [data.note, data.category, data.type] },
  { collection: 'plan', kind: 'plan', title: (data) => data.title, subtitle: (data) => data.done ? '已完成日程' : '日程', date: (data) => data.date || data.startDate, text: (data) => [data.title] }
];

function searchAll(source, options) {
  const query = options || {};
  const keyword = String(query.keyword || '').trim().toLocaleLowerCase();
  const onlyKind = String(query.kind || '');
  const output = [];
  SOURCES.forEach((sourceConfig) => {
    if (onlyKind && onlyKind !== sourceConfig.kind) return;
    valuesOfRecords(source && source[sourceConfig.collection]).forEach((record) => {
      const data = record.data;
      if (!sourceConfig.title(data)) return;
      const haystack = sourceConfig.text(data).join(' ').toLocaleLowerCase();
      if (keyword && !haystack.includes(keyword)) return;
      output.push({
        id: record.id,
        kind: sourceConfig.kind,
        key: sourceConfig.kind + '_' + record.id,
        title: String(sourceConfig.title(data)),
        subtitle: String(sourceConfig.subtitle(data) || ''),
        date: String(sourceConfig.date(data) || ''),
        updatedAt: Number(record.updatedAt || 0)
      });
    });
  });
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
