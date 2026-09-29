/* 记账分类配置：内置分类来自 finance.js，用户配置（收藏/隐藏/自定义）存放在
 * settings 集合 app 记录的三个数组字段里，与预算/主题同记录同步。
 *
 * 身份口径：分类以「收支方向（type）＋名称（name）」识别 —— 支出与收入可以有同名分类
 * （内置「其他」即两边同名），收藏/隐藏/改名/删除都必须带方向，否则会互相误伤。
 * 历史流水以名字字符串记录（money.data.category），因此隐藏、重命名或删除自定义分类
 * 都不会改写任何已有流水；分类预算按名字匹配，继续可读。
 *
 * 旧数据兼容：早期版本 favoriteCategories/hiddenCategories 是扁平名字数组（无方向）。
 * 读取与迁移时把字符串展开为「该名字实际存在的每一个方向」各一条 —— 例如「其他」会
 * 同时生成 expense/income 两条，行为与旧版一致且不再互误伤；用户可再单独调整。
 * 首版约定：无图标、无二级分类、不批量改写旧流水。 */

const { EXPENSE_CATEGORIES, INCOME_CATEGORIES } = require('./finance');

const MAX_CUSTOM = 30;
const MAX_FAVORITES = 12;
const MAX_HIDDEN = 40;
const CUSTOM_NAME_MAX = 16;
const CATEGORY_TYPES = ['expense', 'income'];

function builtinNames(type) {
  return type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
}

/* 旧扁平字符串 → 方向+名称条目：展开到该名字实际存在的每个方向；
 * 名字已不存在（如自定义分类删除后残留的隐藏项）按 expense 保留一条，
 * 不静默丢弃 —— 用户重建同名自定义分类时，先前的隐藏/收藏意图仍然生效。 */
function migrateNameEntry(name, customNamesByType) {
  const entries = [];
  for (const type of CATEGORY_TYPES) {
    const known = builtinNames(type).includes(name) || (customNamesByType[type] || []).includes(name);
    if (known) entries.push({ name, type });
  }
  if (!entries.length) entries.push({ name, type: 'expense' });
  return entries;
}

/* 读取配置并归一化：兼容字符串数组（旧）与 {name,type} 数组（新） */
function readConfig(settingsRecord) {
  const data = settingsRecord && !settingsRecord.deletedAt && settingsRecord.data ? settingsRecord.data : {};
  const custom = Array.isArray(data.customCategories)
    ? data.customCategories.filter((item) => item && item.name && item.type && CATEGORY_TYPES.includes(item.type))
    : [];
  const customNamesByType = { expense: [], income: [] };
  custom.forEach((item) => customNamesByType[item.type].push(item.name));
  const normalizeList = (value) => {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    value.forEach((item) => {
      const entries = typeof item === 'string' ? migrateNameEntry(item, customNamesByType) : (item && item.name && CATEGORY_TYPES.includes(item.type) ? [{ name: item.name, type: item.type }] : []);
      entries.forEach((entry) => {
        const key = entry.type + '|' + entry.name;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(entry);
      });
    });
    return out;
  };
  return {
    custom,
    favorites: normalizeList(data.favoriteCategories),
    hidden: normalizeList(data.hiddenCategories)
  };
}

/* 供 store.loadLocal / settings-utils 做落盘迁移：返回归一化后的字段（未变化返回 null） */
function migrateSettingsCategories(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const hasLegacy = ['favoriteCategories', 'hiddenCategories'].some((key) => Array.isArray(data[key]) && data[key].some((item) => typeof item === 'string'));
  const config = readConfig({ deletedAt: 0, data });
  const next = {
    customCategories: config.custom,
    favoriteCategories: config.favorites,
    hiddenCategories: config.hidden
  };
  if (!hasLegacy && JSON.stringify(next) === JSON.stringify({ customCategories: data.customCategories || [], favoriteCategories: data.favoriteCategories || [], hiddenCategories: data.hiddenCategories || [] })) return null;
  if (!hasLegacy && !Array.isArray(data.customCategories) && !Array.isArray(data.favoriteCategories) && !Array.isArray(data.hiddenCategories)) return null;
  return next;
}

/* 分类选择器（记一笔/编辑流水）：
 * 排序 = 收藏（该方向）→ 最近使用（排除已隐藏与已不存在的分类）→ 其余内置 → 其余自定义。
 * opts.current：编辑旧流水时原分类始终保留在选择器中（即使已被隐藏）。 */
function buildCategoryList(settingsRecord, moneyRecords, options) {
  const opts = options || {};
  const type = opts.type === 'income' ? 'income' : 'expense';
  const config = readConfig(settingsRecord);
  const hiddenSet = new Set(config.hidden.filter((item) => item.type === type).map((item) => item.name));
  if (opts.current) hiddenSet.delete(opts.current);
  const custom = config.custom
    .filter((item) => item.type === type && !hiddenSet.has(item.name))
    .map((item) => item.name);
  const known = new Set(builtinNames(type).concat(custom));

  const recent = [];
  Object.values(moneyRecords || {})
    .filter((record) => !record.deletedAt && record.data && record.data.type === type && record.data.category)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .forEach((record) => {
      const name = record.data.category;
      if (!recent.includes(name) && known.has(name) && !hiddenSet.has(name)) recent.push(name);
    });

  const favoriteNames = new Set(config.favorites.filter((item) => item.type === type).map((item) => item.name));
  const ordered = [];
  const push = (name) => { if (name && !ordered.includes(name)) ordered.push(name); };
  config.favorites.forEach((item) => { if (item.type === type && !hiddenSet.has(item.name)) push(item.name); });
  recent.forEach(push);
  builtinNames(type).forEach((name) => { if (!hiddenSet.has(name)) push(name); });
  custom.forEach(push);
  if (opts.current && opts.current !== '账户转账') push(opts.current);
  void favoriteNames;
  return ordered;
}

/* 分类管理列表：内置 + 自定义全部列出（含已隐藏），带方向、收藏/隐藏标记与流水引用数 */
function buildCategoryManageList(settingsRecord, moneyRecords) {
  const config = readConfig(settingsRecord);
  const usage = {};
  Object.values(moneyRecords || {}).forEach((record) => {
    if (record.deletedAt || !record.data || !record.data.category || record.data.type === 'transfer') return;
    usage[record.data.category] = (usage[record.data.category] || 0) + 1;
  });
  const isFavorite = (name, type) => config.favorites.some((item) => item.name === name && item.type === type);
  const isHidden = (name, type) => config.hidden.some((item) => item.name === name && item.type === type);
  const rows = (type) => builtinNames(type)
    .map((name) => ({ name, type, custom: false, favorite: isFavorite(name, type), hidden: isHidden(name, type), usage: usage[name] || 0 }))
    .concat(config.custom.filter((item) => item.type === type).map((item) => ({
      name: item.name, type, custom: true,
      favorite: isFavorite(item.name, type), hidden: isHidden(item.name, type), usage: usage[item.name] || 0
    })));
  return { expense: rows('expense'), income: rows('income') };
}

/* ---- 配置变更（纯函数，返回 {config} 或 {error}；页面拿结果合并进 settings.app 保存） ---- */

function toggleFavorite(config, name, type) {
  const favorites = config.favorites.filter((item) => !(item.name === name && item.type === type));
  if (favorites.length === config.favorites.length) {
    if (favorites.length >= MAX_FAVORITES) return { error: '最多收藏 ' + MAX_FAVORITES + ' 个分类' };
    favorites.push({ name, type });
  }
  return { config: { ...config, favorites } };
}

function toggleHidden(config, name, type) {
  const hidden = config.hidden.filter((item) => !(item.name === name && item.type === type));
  if (hidden.length === config.hidden.length) {
    if (hidden.length >= MAX_HIDDEN) return { error: '最多隐藏 ' + MAX_HIDDEN + ' 个分类' };
    hidden.push({ name, type });
  }
  return { config: { ...config, hidden } };
}

function addCustomCategory(config, name, type) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return { error: '请输入分类名称' };
  if (trimmed.length > CUSTOM_NAME_MAX) return { error: '名称最多 ' + CUSTOM_NAME_MAX + ' 个字' };
  if (config.custom.length >= MAX_CUSTOM) return { error: '自定义分类最多 ' + MAX_CUSTOM + ' 个' };
  if (builtinNames(type).includes(trimmed)) return { error: '与内置分类重名' };
  if (config.custom.some((item) => item.type === type && item.name === trimmed)) return { error: '该分类已存在' };
  const custom = config.custom.concat([{ name: trimmed, type }]);
  return { config: { ...config, custom } };
}

/* 重命名只改配置：历史流水保留旧名；同方向条目才改名 —— 另一方向同名分类不受影响 */
function renameCustomCategory(config, oldName, newName, type) {
  const trimmed = String(newName || '').trim();
  if (!trimmed) return { error: '请输入新名称' };
  if (trimmed === oldName) return { config };
  if (trimmed.length > CUSTOM_NAME_MAX) return { error: '名称最多 ' + CUSTOM_NAME_MAX + ' 个字' };
  if (config.custom.some((item) => item.name === trimmed && item.type === type)) return { error: '该分类已存在' };
  if (builtinNames(type).includes(trimmed)) return { error: '与内置分类重名' };
  const same = (item) => item.name === oldName && item.type === type;
  const custom = config.custom.map((item) => (same(item) ? { ...item, name: trimmed } : item));
  const favorites = config.favorites.map((item) => (same(item) ? { ...item, name: trimmed } : item));
  const hidden = config.hidden.map((item) => (same(item) ? { ...item, name: trimmed } : item));
  return { config: { custom, favorites, hidden } };
}

/* 删除自定义分类（按方向+名称）：已有流水引用时拒绝（提示改用隐藏），避免历史流水出现无来源分类 */
function removeCustomCategory(config, name, type, usageCount) {
  if (usageCount > 0) return { error: '已有 ' + usageCount + ' 笔流水使用该分类，建议改为隐藏' };
  const same = (item) => item.name === name && item.type === type;
  return {
    config: {
      custom: config.custom.filter((item) => !same(item)),
      favorites: config.favorites.filter((item) => !same(item)),
      hidden: config.hidden.filter((item) => !same(item))
    }
  };
}

module.exports = {
  MAX_CUSTOM, MAX_FAVORITES, MAX_HIDDEN, CUSTOM_NAME_MAX, CATEGORY_TYPES,
  readConfig, migrateSettingsCategories, buildCategoryList, buildCategoryManageList,
  toggleFavorite, toggleHidden, addCustomCategory, renameCustomCategory, removeCustomCategory
};
