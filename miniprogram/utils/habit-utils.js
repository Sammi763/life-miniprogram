/* 习惯领域纯计算：完成判定、entry 写入构造、12 周历史网格。
 * habit/today 页、今日队列（daily-utils）与复盘/月报（review/report-utils）共用同一口径，避免分叉。
 *
 * 目标快照口径：entry 写入时把「当时的 mode/target」随记录定格（entryWrite）；
 * 存量旧 entry 没有快照字段，按 def 当前值解读（展示口径回退），不追溯改写历史 ——
 * 因此修改目标后，旧记录按新目标判定，新记录按写入时的目标判定。 */

const MODES = ['check', 'count', 'value'];
const HISTORY_WEEKS = 12;
const EVERY_DAY = 127;

function scheduledWeekdays(def, date) {
  const schedule = unwrap(def).schedule;
  if (!schedule) return EVERY_DAY;
  if (schedule.startDate && date < schedule.startDate) return 0;
  const changes = schedule.changes;
  for (let i = changes.length - 1; i >= 0; i--) {
    if (changes[i].date <= date) return changes[i].days;
  }
  return EVERY_DAY;
}

function isScheduled(def, date) {
  const weekday = new Date(date + 'T00:00:00').getDay();
  return Number.isFinite(weekday) && Boolean(scheduledWeekdays(def, date) & (1 << ((weekday + 6) % 7)));
}

function updateSchedule(def, date, days, updatedAt = Date.now()) {
  const previous = unwrap(def).schedule;
  if (previous && previous.startDate > date) date = previous.startDate;
  if (def && scheduledWeekdays(def, date) === days) return previous;
  const changes = previous ? previous.changes.filter((change) => change.date !== date) : [];
  if (days !== EVERY_DAY || changes.length || previous) changes.push({ date, days, updatedAt });
  changes.sort((a, b) => a.date.localeCompare(b.date));
  return { ...(def ? previous : { startDate: date }), changes };
}

function preserveHabitSchedule(previous, next) {
  if (previous.kind !== 'def' || next.kind !== 'def' || !previous.schedule) return next;
  if (!next.schedule) return { ...next, schedule: previous.schedule };
  const startDate = previous.schedule.startDate || next.schedule.startDate;
  const changes = new Map(previous.schedule.changes.map((change) => [change.date, change]));
  for (const change of next.schedule.changes) {
    if (startDate && change.date < startDate) continue;
    const current = changes.get(change.date);
    // An edit from another device can carry an older copy of an unrelated revision.
    if (!current || (current.updatedAt || 0) <= (change.updatedAt || 0)) changes.set(change.date, change);
  }
  return { ...next, schedule: {
    ...(startDate ? { startDate } : {}),
    changes: Array.from(changes.values()).sort((a, b) => a.date.localeCompare(b.date))
  } };
}

function normalizeMode(mode, fallback) {
  if (MODES.indexOf(mode) >= 0) return mode;
  if (MODES.indexOf(fallback) >= 0) return fallback;
  return 'check';
}

/* entry/def 两个参数同时兼容完整记录 {id,data,...} 与裸 data 对象（report-utils 传的就是 data）。 */
function unwrap(recordOrData) {
  return recordOrData && recordOrData.data ? recordOrData.data : (recordOrData || {});
}

function entryMode(entry, def) {
  const ed = unwrap(entry);
  if (ed.mode) return normalizeMode(ed.mode);
  return normalizeMode(unwrap(def).mode);
}

function entryTarget(entry, def) {
  const ed = unwrap(entry);
  if (ed.mode) return Number(ed.target) || 1;
  return Number(unwrap(def).target) || 1;
}

function isEntryDone(entry, def) {
  const value = Number(unwrap(entry).value) || 0;
  return entryMode(entry, def) === 'check' ? value >= 1 : value >= entryTarget(entry, def);
}

/* 同一习惯同一日期只有一条生效记录：确定性 ID 让同步层 LWW 天然合并重复补录
 * （与 plan occurrence 的 o_ 前缀同一模式）；存量随机 ID 记录由 findEntry 复用兼容。
 * 服务端 ID 上限 64 字符，而 habit ID 本身可达 64 字符——直接拼接（e_<habitId>_<date>）
 * 会生成 75 字符 ID 被服务端拒收。故统一对 habitId 做 FNV-1a 双种子指纹（base36，≤14 字符），
 * 总长 ≤ 25，对服务端允许的全部 habit ID（1–64 字符 [A-Za-z0-9_-]）稳定、合法且无实际碰撞；
 * 早期直接拼接版本已落库的记录不受影响（仍由 findEntry 按 habitId+date 复用）。 */
function fnv1a(text, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function makeEntryId(habitId, date) {
  const key = String(habitId || '');
  const high = fnv1a(key, 0x811c9dc5).toString(36);
  const low = fnv1a(key, 0x1b873593).toString(36);
  return 'e_' + high + low + '_' + String(date || '').replace(/-/g, '');
}

function findEntry(records, habitId, date) {
  for (const record of Object.values(records || {})) {
    if (record.deletedAt || !record.data || record.data.kind !== 'entry') continue;
    if (record.data.habitId === habitId && record.data.date === date) return record;
  }
  return null;
}

/* 构造一次 entry 写入：同日已有记录复用其 ID（含存量随机 ID），否则用确定性 ID。
 * mode/target 快照取自 def 当前值。页面拿到返回值后调 sync.upsert('habit', w.data, w.id)。 */
function entryWrite(records, def, date, value) {
  const dd = unwrap(def);
  const data = {
    kind: 'entry',
    habitId: def && def.id,
    date,
    value: Number(value) || 0,
    mode: normalizeMode(dd.mode),
    target: Number(dd.target) || 1
  };
  const existing = findEntry(records, data.habitId, date);
  return { id: existing ? existing.id : makeEntryId(data.habitId, date), data, existed: Boolean(existing) };
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

/* 近 N 周（默认 12）历史网格：周一起始、末格为本周日；今天之后的日期标 future 供置灰。
 * level 0-3 供热力图配色：0 未打卡、1/2 有进度未达标、3 达标。 */
function buildHabitHistory(records, def, todayText, weeks) {
  const total = (Number(weeks) || HISTORY_WEEKS) * 7;
  const today = todayText || fmtDate(new Date());
  const byDate = {};
  for (const record of Object.values(records || {})) {
    if (record.deletedAt || !record.data || record.data.kind !== 'entry') continue;
    if (record.data.habitId !== (def && def.id)) continue;
    byDate[record.data.date] = record;
  }
  const base = new Date(today + 'T00:00:00');
  const offset = (base.getDay() + 6) % 7; // 周一=0，与 plan 周历同一周起点
  const sunday = new Date(base);
  sunday.setDate(sunday.getDate() + (6 - offset));
  const start = new Date(sunday);
  start.setDate(start.getDate() - (total - 1));
  const grid = [];
  let week = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const date = fmtDate(d);
    const entry = byDate[date];
    const value = entry ? Number(entry.data.value) || 0 : 0;
    const target = entryTarget(entry, def);
    const done = isEntryDone(entry, def);
    let level = 0;
    if (done) level = 3;
    else if (value > 0) level = value * 3 >= target ? 2 : 1;
    week.push({ date, value, done, recorded: Boolean(entry), future: date > today, scheduled: isScheduled(def, date), level });
    if (week.length === 7) { grid.push(week); week = []; }
  }
  return { grid, start: fmtDate(start), today };
}

module.exports = {
  MODES, HISTORY_WEEKS, EVERY_DAY, scheduledWeekdays, isScheduled, updateSchedule, preserveHabitSchedule,
  normalizeMode, entryMode, entryTarget, isEntryDone,
  makeEntryId, findEntry, entryWrite, buildHabitHistory, fmtDate
};
