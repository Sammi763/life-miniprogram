/* 记录字段白名单校验 —— 服务端同步写入与客户端「导入备份」共用同一套规则（单一事实来源）。
 * server/validation.js 是本文件的薄 re-export；部署时必须保证 miniprogram/utils 随服务器分发
 * （server/ai-insights.js 复用 miniprogram/utils 是同一个跨目录共享模式）。 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const OCCURRED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/;
const MEMORY_MOODS = ['happy', 'calm', 'energized', 'tired', 'low'];
/* 'auto' = 跟随系统深浅（v2.11）；旧客户端读到 auto 会按未知主题回退 forest（可接受降级） */
const SETTINGS_THEMES = ['forest', 'paper', 'sky', 'violet', 'night', 'auto'];

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownKeysOnly(value, keys) {
  return object(value) && Object.keys(value).every((key) => keys.includes(key));
}

function text(value, max, required) {
  if (value === undefined || value === null) return !required;
  return typeof value === 'string' && value.trim().length <= max && (!required || value.trim().length > 0);
}

function number(value, min, max, required) {
  if (value === undefined || value === null || value === '') return !required;
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function boolean(value, required) {
  if (value === undefined || value === null) return !required;
  return typeof value === 'boolean';
}

function date(value, required) {
  if (value === undefined || value === null || value === '') return !required;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00');
  return !Number.isNaN(parsed.getTime()) && parsed.getFullYear() === Number(value.slice(0, 4)) && parsed.getMonth() + 1 === Number(value.slice(5, 7)) && parsed.getDate() === Number(value.slice(8, 10));
}

function time(value) {
  return value === undefined || value === '' || (typeof value === 'string' && TIME_PATTERN.test(value));
}

function integer(value, min, max, required) {
  return number(value, min, max, required) && (value === undefined || value === null || value === '' || Number.isInteger(value));
}

function recordId(value, required) {
  if (value === undefined || value === null || value === '') return !required;
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function occurredAt(value, required) {
  if (value === undefined || value === null || value === '') return !required;
  return typeof value === 'string' && OCCURRED_AT_PATTERN.test(value) && date(value.slice(0, 10), true) && time(value.slice(11));
}

function tags(value) {
  if (value === undefined || value === null) return true;
  if (!Array.isArray(value) || value.length > 3) return false;
  const seen = new Set();
  return value.every((item) => {
    if (!text(item, 12, true) || seen.has(item.trim())) return false;
    seen.add(item.trim());
    return true;
  });
}

function categoryBudgets(value) {
  if (value === undefined || value === null) return true;
  if (!object(value) || Object.keys(value).length > 30) return false;
  return Object.keys(value).every((key) => !['__proto__', 'constructor', 'prototype'].includes(key) && text(key, 32, true) && number(value[key], 0, 1000000, true));
}

/* 记账分类的用户配置：自定义分类、收藏与隐藏均以「方向+名称」条目识别
 * （支出/收入可有同名分类，扁平名字数组会互相误伤；旧扁平格式由客户端读取时迁移） */
const CATEGORY_TYPES = ['expense', 'income'];

function customCategories(value) {
  if (value === undefined || value === null) return true;
  if (!Array.isArray(value) || value.length > 30) return false;
  return categoryEntries(value);
}

function categoryEntries(value) {
  const seen = new Set();
  return value.every((item) => {
    if (!object(item) || !ownKeysOnly(item, ['name', 'type'])) return false;
    if (!text(item.name, 32, true) || !CATEGORY_TYPES.includes(item.type)) return false;
    const key = item.type + '|' + item.name.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// v1.6.1 起客户端不会再写入封面；保留旧同步记录的校验兼容，避免离线旧数据无法上送。
function legacyCover(value, max) {
  return value === undefined || value === '' || (typeof value === 'string' && value.length <= max && (/^https:\/\//.test(value) || /^\/files\/[a-f0-9]{64}\.(jpg|png|webp)$/.test(value)));
}

function reminder(value) {
  if (value === undefined || value === null) return true;
  return ownKeysOnly(value, ['enabled', 'dueAt']) && boolean(value.enabled, true) && (
    value.enabled === false || number(value.dueAt, 1, 4102444800000, true)
  );
}

function validPlan(data) {
  if (data.kind === 'series') {
    return ownKeysOnly(data, ['kind', 'title', 'startDate', 'time', 'repeat', 'repeatDay', 'endDate', 'active', 'pinned']) &&
      text(data.title, 30, true) && date(data.startDate, true) && time(data.time) &&
      ['daily', 'weekly', 'workdays', 'monthly'].includes(data.repeat) && date(data.endDate, false) && boolean(data.active, false) &&
      boolean(data.pinned, false) &&
      // repeatDay 仅 monthly 使用（1-31）；月份无对应日期时由客户端展开逻辑跳过该月
      integer(data.repeatDay, 1, 31, false) &&
      (data.repeat !== 'monthly' || (data.repeatDay !== undefined && Number.isInteger(data.repeatDay))) &&
      (!data.endDate || data.endDate >= data.startDate);
  }
  if (data.kind === 'occurrence') {
    return ownKeysOnly(data, ['kind', 'seriesId', 'date', 'done', 'skipped', 'titleSnapshot', 'timeSnapshot']) &&
      typeof data.seriesId === 'string' && ID_PATTERN.test(data.seriesId) && date(data.date, true) &&
      boolean(data.done, false) && boolean(data.skipped, false) && text(data.titleSnapshot, 30, false) && time(data.timeSnapshot) &&
      !(data.done && data.skipped);
  }
  return ownKeysOnly(data, ['kind', 'title', 'date', 'time', 'done', 'skipped', 'reminder', 'pinned']) &&
    (data.kind === undefined || data.kind === 'one') && text(data.title, 30, true) && date(data.date, true) &&
    time(data.time) && boolean(data.done, false) && boolean(data.skipped, false) && boolean(data.pinned, false) && reminder(data.reminder) &&
    !(data.done && data.skipped);
}

function validateRecordData(collection, data) {
  if (!object(data) || JSON.stringify(data).length > 16384) return 'bad_data';
  if (collection === 'money') {
    const common = ownKeysOnly(data, ['type', 'amount', 'category', 'date', 'note', 'accountId', 'toAccountId']) &&
      ['income', 'expense', 'transfer'].includes(data.type) && number(data.amount, 0.01, 100000000, true) &&
      text(data.category, 32, true) && date(data.date, true) && text(data.note, 500, false);
    if (!common) return 'bad_money';
    if (data.type === 'transfer') {
      return recordId(data.accountId, true) && recordId(data.toAccountId, true) && data.accountId !== data.toAccountId && data.category === '账户转账' ? '' : 'bad_money';
    }
    return recordId(data.accountId, false) && data.toAccountId === undefined ? '' : 'bad_money';
  }
  if (collection === 'accounts') {
    const hasStartingBalance = data.balance !== undefined || data.openingBalance !== undefined;
    return ownKeysOnly(data, ['kind', 'name', 'balance', 'openingBalance', 'manualAdjustment', 'category', 'note', 'statementDay', 'dueDay', 'minimumPayment', 'currentBill']) &&
      ['asset', 'liability'].includes(data.kind) && text(data.name, 32, true) &&
      hasStartingBalance && number(data.balance, 0, 1000000000, false) && number(data.openingBalance, 0, 1000000000, false) &&
      number(data.manualAdjustment, -1000000000, 1000000000, false) && text(data.category, 32, true) &&
      text(data.note, 200, false) && integer(data.statementDay, 1, 31, false) && integer(data.dueDay, 1, 31, false) &&
      number(data.minimumPayment, 0, 1000000000, false) && number(data.currentBill, 0, 1000000000, false) ? '' : 'bad_accounts';
  }
  if (collection === 'habit') {
    if (data.kind === 'def') {
      return ownKeysOnly(data, ['kind', 'name', 'mode', 'target', 'unit', 'color', 'pinned']) && text(data.name, 24, true) &&
        ['check', 'count', 'value'].includes(data.mode) && number(data.target, 0, 1000000, true) && text(data.unit, 12, false) &&
        boolean(data.pinned, false) &&
        (data.color === undefined || (typeof data.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(data.color))) ? '' : 'bad_habit';
    }
    return ownKeysOnly(data, ['kind', 'habitId', 'date', 'value', 'mode', 'target']) && data.kind === 'entry' &&
      typeof data.habitId === 'string' && ID_PATTERN.test(data.habitId) && date(data.date, true) && number(data.value, 0, 1000000, true) &&
      // mode/target 是打卡时的目标快照（可选）；旧记录无快照由客户端按习惯当前目标解读
      (data.mode === undefined || ['check', 'count', 'value'].includes(data.mode)) &&
      number(data.target, 0, 1000000, false) ? '' : 'bad_habit';
  }
  if (collection === 'plan') return validPlan(data) ? '' : 'bad_plan';
  if (collection === 'fitness') {
    if (data.kind === 'weight') return ownKeysOnly(data, ['kind', 'date', 'weight', 'bodyfat']) && date(data.date, true) && number(data.weight, 1, 500, true) && number(data.bodyfat, 0, 99.9, false) ? '' : 'bad_fitness';
    if (data.kind === 'deficit') return ownKeysOnly(data, ['kind', 'date', 'intake', 'burned']) && date(data.date, true) && number(data.intake, 0, 50000, true) && number(data.burned, 0, 50000, true) ? '' : 'bad_fitness';
    return ownKeysOnly(data, ['kind', 'weekday', 'content', 'done', 'date', 'weekStart']) && data.kind === 'plan' &&
      number(data.weekday, 1, 7, true) && Number.isInteger(data.weekday) && text(data.content, 60, true) && boolean(data.done, false) &&
      date(data.date, true) && date(data.weekStart, true) ? '' : 'bad_fitness';
  }
  if (collection === 'shopping') {
    return ownKeysOnly(data, ['name', 'note', 'price', 'link', 'done', 'pinned']) && text(data.name, 40, true) && text(data.note, 500, false) &&
      number(data.price, 0, 100000000, false) && (data.link === undefined || (typeof data.link === 'string' && data.link.length <= 1024)) && boolean(data.done, false) && boolean(data.pinned, false) ? '' : 'bad_shopping';
  }
  if (collection === 'media') {
    return ownKeysOnly(data, ['kind', 'title', 'status', 'rating', 'comment', 'date', 'cover']) &&
      ['book', 'movie', 'music'].includes(data.kind) && text(data.title, 80, true) && ['wishlist', 'doing', 'done'].includes(data.status) &&
      number(data.rating, 0, 5, true) && Number.isInteger(data.rating) && text(data.comment, 500, false) && date(data.date, true) && legacyCover(data.cover, 512) ? '' : 'bad_media';
  }
  if (collection === 'settings') {
    return ownKeysOnly(data, ['budget', 'height', 'targetWeight', 'categoryBudgets', 'aiConsent', 'theme', 'customCategories', 'favoriteCategories', 'hiddenCategories', 'habitReminderEnabled', 'billReminderEnabled', 'habitReminderTime']) &&
      number(data.budget, 0, 1000000, false) && number(data.height, 0, 250, false) && number(data.targetWeight, 0, 300, false) &&
      categoryBudgets(data.categoryBudgets) && boolean(data.aiConsent, false) &&
      customCategories(data.customCategories) &&
      (data.favoriteCategories === undefined || data.favoriteCategories === null || (Array.isArray(data.favoriteCategories) && data.favoriteCategories.length <= 12 && categoryEntries(data.favoriteCategories))) &&
      (data.hiddenCategories === undefined || data.hiddenCategories === null || (Array.isArray(data.hiddenCategories) && data.hiddenCategories.length <= 40 && categoryEntries(data.hiddenCategories))) &&
      (data.theme === undefined || SETTINGS_THEMES.includes(data.theme)) &&
      boolean(data.habitReminderEnabled, false) && boolean(data.billReminderEnabled, false) &&
      // habitReminderTime：'HH:MM' 24 小时制；缺省由服务端按默认时间处理
      (data.habitReminderTime === undefined || data.habitReminderTime === null || data.habitReminderTime === '' || (typeof data.habitReminderTime === 'string' && TIME_PATTERN.test(data.habitReminderTime))) ? '' : 'bad_settings';
  }
  if (collection === 'memories') {
    return ownKeysOnly(data, ['content', 'occurredAt', 'mood', 'tags']) && text(data.content, 1000, true) &&
      occurredAt(data.occurredAt, true) && (data.mood === undefined || data.mood === '' || MEMORY_MOODS.includes(data.mood)) && tags(data.tags) ? '' : 'bad_memories';
  }
  return 'bad_collection';
}

function getOneOffReminderPlan(record) {
  const data = record && record.data;
  if (!data || data.kind === 'series' || data.kind === 'occurrence' || !data.title || !date(data.date, true) || !TIME_PATTERN.test(String(data.time || '')) || data.done || data.skipped) return null;
  const dueAt = new Date(data.date + 'T' + data.time + ':00').getTime();
  if (!Number.isFinite(dueAt)) return null;
  return { title: String(data.title), dueAt, reminder: data.reminder || null };
}

module.exports = { ID_PATTERN, MEMORY_MOODS, OCCURRED_AT_PATTERN, SETTINGS_THEMES, TIME_PATTERN, getOneOffReminderPlan, validateRecordData };
