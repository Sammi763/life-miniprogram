/* 随记领域计算：只处理文字、心情和标签，不包含任何附件或第三方内容。 */
const MOODS = ['happy', 'calm', 'energized', 'tired', 'low'];
const OCCURRED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/;

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  const output = [];
  value.forEach((item) => {
    const tag = String(item || '').trim();
    if (!tag || tag.length > 12 || output.includes(tag) || output.length >= 3) return;
    output.push(tag);
  });
  return output;
}

function normalizeMemory(value) {
  const source = value && typeof value === 'object' ? value : {};
  const occurredAt = OCCURRED_AT_PATTERN.test(String(source.occurredAt || '')) ? source.occurredAt : '';
  return {
    content: String(source.content || '').trim().slice(0, 1000),
    occurredAt,
    mood: MOODS.includes(source.mood) ? source.mood : '',
    tags: normalizeTags(source.tags)
  };
}

function recordItems(records) {
  const input = Array.isArray(records) ? records : Object.values(records || {});
  return input.map((record, index) => {
    const data = record && record.data && typeof record.data === 'object' ? record.data : record;
    if (!record || record.deletedAt || !data || typeof data !== 'object') return null;
    const memory = normalizeMemory(data);
    if (!memory.content || !memory.occurredAt) return null;
    return {
      id: String(record.id || data.id || index),
      ...memory,
      date: memory.occurredAt.slice(0, 10),
      updatedAt: Number(record.updatedAt || data.updatedAt || 0)
    };
  }).filter(Boolean).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
}

function contains(value, keyword) {
  return String(value || '').toLocaleLowerCase().includes(keyword);
}

function filterMemories(records, options) {
  const filter = options || {};
  const keyword = String(filter.keyword || '').trim().toLocaleLowerCase();
  const mood = String(filter.mood || '');
  const tag = String(filter.tag || '');
  const date = String(filter.date || '');
  return recordItems(records).filter((item) => {
    if (keyword && !contains(item.content, keyword) && !item.tags.some((value) => contains(value, keyword))) return false;
    if (mood && item.mood !== mood) return false;
    if (tag && !item.tags.includes(tag)) return false;
    return !date || item.date === date;
  });
}

function groupMemoriesByDate(records, options) {
  const groups = {};
  filterMemories(records, options).forEach((item) => {
    (groups[item.date] || (groups[item.date] = [])).push(item);
  });
  return Object.keys(groups).sort((a, b) => b.localeCompare(a)).map((date) => ({ date, items: groups[date] }));
}

function rankedCounts(values, key) {
  const counts = {};
  const first = {};
  values.forEach((value, index) => {
    if (!value) return;
    counts[value] = (counts[value] || 0) + 1;
    if (first[value] === undefined) first[value] = index;
  });
  return Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a] || first[a] - first[b] || a.localeCompare(b, 'zh-Hans-CN'))
    .map((value) => ({ [key]: value, count: counts[value] }));
}

function buildMemorySummary(records, month) {
  const input = Array.isArray(records) ? records : Object.values(records || {});
  const items = input.map((record, index) => {
    const data = record && record.data && typeof record.data === 'object' ? record.data : record;
    if (!record || record.deletedAt || !data || typeof data !== 'object') return null;
    const memory = normalizeMemory(data);
    if (!memory.content || !memory.occurredAt || (month && memory.occurredAt.slice(0, 7) !== month)) return null;
    return { id: String(record.id || data.id || index), ...memory, date: memory.occurredAt.slice(0, 10) };
  }).filter(Boolean);
  return {
    count: items.length,
    days: new Set(items.map((item) => item.date)).size,
    topTags: rankedCounts(items.flatMap((item) => item.tags), 'tag').slice(0, 3),
    moods: rankedCounts(items.map((item) => item.mood), 'mood')
  };
}

function recentTags(records, limit) {
  return buildMemorySummary(records).topTags.slice(0, Number(limit) || 5).map((item) => item.tag);
}

function makeDraftKey(id) {
  return 'wb_life_memory_draft_' + String(id || 'new').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

module.exports = {
  MOODS,
  OCCURRED_AT_PATTERN,
  buildMemorySummary,
  filterMemories,
  groupMemoriesByDate,
  makeDraftKey,
  normalizeMemory,
  normalizeTags,
  recentTags,
  recordItems
};
