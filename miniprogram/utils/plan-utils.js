/* 日程领域计算：原始记录保持不变，重复事项只在展示/统计时展开为虚拟日期。 */
function pad(value) {
  return String(value).padStart(2, '0');
}

function parseDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return formatDate(date) === value ? date : null;
}

function formatDate(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function addDays(value, amount) {
  const date = value instanceof Date ? new Date(value) : parseDate(value);
  if (!date) return '';
  date.setDate(date.getDate() + Number(amount || 0));
  return formatDate(date);
}

function getWeekDates(value) {
  const date = parseDate(value) || new Date();
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return Array.from({ length: 7 }, (_, index) => addDays(date, index));
}

function makeOccurrenceId(seriesId, date) {
  const source = String(seriesId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 53);
  return 'o_' + source + '_' + String(date || '').replace(/-/g, '').slice(0, 8);
}

function normalizeRecord(record, fallbackId) {
  if (!record) return null;
  const source = record.data && typeof record.data === 'object' ? record.data : record;
  if (!source || typeof source !== 'object') return null;
  return {
    id: String(record.id || source.id || fallbackId || ''),
    data: source,
    updatedAt: Number(record.updatedAt || source.updatedAt || 0),
    deletedAt: Number(record.deletedAt || source.deletedAt || 0)
  };
}

function valuesOfRecords(records) {
  const input = Array.isArray(records) ? records : Object.values(records || {});
  return input.map((record, index) => normalizeRecord(record, String(index))).filter((record) => record && !record.deletedAt);
}

function weekday(date) {
  const parsed = parseDate(date);
  return parsed ? (parsed.getDay() || 7) : 0;
}

function collectOverrides(records) {
  const map = {};
  records.forEach((record) => {
    const data = record.data;
    if (data.kind !== 'occurrence' || !data.seriesId || !parseDate(data.date)) return;
    const key = String(data.seriesId) + '|' + data.date;
    const previous = map[key];
    if (!previous || previous.updatedAt <= record.updatedAt) map[key] = record;
  });
  return map;
}

function makeOneOff(record) {
  const data = record.data;
  if (!data.title || !parseDate(data.date)) return null;
  return {
    id: record.id,
    sourceId: record.id,
    seriesId: '',
    isVirtual: false,
    title: String(data.title),
    date: data.date,
    time: String(data.time || ''),
    done: Boolean(data.done),
    skipped: Boolean(data.skipped),
    pinned: Boolean(data.pinned),
    reminder: data.reminder && data.reminder.enabled ? data.reminder : null,
    updatedAt: record.updatedAt
  };
}

function buildSeriesOccurrences(record, rangeStart, rangeEnd, overrides) {
  const data = record.data;
  if (data.kind !== 'series' || !data.title || !parseDate(data.startDate)) return [];
  // repeat 取值：daily 每天 / weekly 每周 / workdays 工作日（周一至周五，不含法定节假日调休）/
  // monthly 每月固定日期（repeatDay 1-31；月份无对应日期则该月跳过，不钳制到月末）
  const repeat = ['daily', 'weekly', 'workdays', 'monthly'].includes(data.repeat) ? data.repeat : '';
  if (!repeat || data.active === false) return [];
  const targetDay = Math.min(31, Math.max(1, Number(data.repeatDay) || parseDate(data.startDate).getDate()));
  const endDate = parseDate(data.endDate) ? data.endDate : rangeEnd;
  const firstDate = data.startDate > rangeStart ? data.startDate : rangeStart;
  const finalDate = endDate < rangeEnd ? endDate : rangeEnd;
  if (firstDate > finalDate) return [];

  const targetWeekday = repeat === 'weekly' ? weekday(data.startDate) : 0;
  const output = [];
  let cursor = firstDate;
  while (cursor && cursor <= finalDate) {
    const matches =
      repeat === 'daily' ? true :
      repeat === 'weekly' ? weekday(cursor) === targetWeekday :
      repeat === 'workdays' ? weekday(cursor) <= 5 :
      parseDate(cursor).getDate() === targetDay;
    if (matches) {
      const override = overrides[record.id + '|' + cursor];
      const overrideData = override && override.data || {};
      output.push({
        id: override ? override.id : makeOccurrenceId(record.id, cursor),
        sourceId: record.id,
        seriesId: record.id,
        isVirtual: true,
        title: String(overrideData.titleSnapshot || data.title),
        date: cursor,
        time: String(overrideData.timeSnapshot || data.time || ''),
        done: Boolean(overrideData.done),
        skipped: Boolean(overrideData.skipped),
        pinned: Boolean(data.pinned),
        reminder: null,
        updatedAt: Math.max(record.updatedAt, override ? override.updatedAt : 0)
      });
    }
    cursor = addDays(cursor, 1);
  }
  return output;
}

function derivePlanOccurrences(records, rangeStart, rangeEnd) {
  if (!parseDate(rangeStart) || !parseDate(rangeEnd) || rangeStart > rangeEnd) return [];
  const normalized = valuesOfRecords(records);
  const overrides = collectOverrides(normalized);
  const output = [];
  normalized.forEach((record) => {
    const data = record.data;
    if (data.kind === 'occurrence') return;
    if (data.kind === 'series') {
      output.push(...buildSeriesOccurrences(record, rangeStart, rangeEnd, overrides));
      return;
    }
    const oneOff = makeOneOff(record);
    if (oneOff && oneOff.date >= rangeStart && oneOff.date <= rangeEnd) output.push(oneOff);
  });
  return output.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if ((a.time || '99:99') !== (b.time || '99:99')) return (a.time || '99:99').localeCompare(b.time || '99:99');
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });
}

function summarizeOccurrences(occurrences) {
  const list = Array.isArray(occurrences) ? occurrences : [];
  const skipped = list.filter((item) => item.skipped).length;
  const relevant = list.filter((item) => !item.skipped);
  const done = relevant.filter((item) => item.done).length;
  return {
    total: relevant.length,
    done,
    skipped,
    rate: relevant.length ? Math.round(done * 1000 / relevant.length) / 10 : 0
  };
}

module.exports = {
  addDays,
  derivePlanOccurrences,
  formatDate,
  getWeekDates,
  makeOccurrenceId,
  parseDate,
  summarizeOccurrences,
  valuesOfRecords
};
