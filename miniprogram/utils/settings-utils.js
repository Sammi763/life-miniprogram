/* 设置记录只允许同步业务设置；清理早期版本可能残留的 serverUrl 等技术字段。
 * customCategories/favoriteCategories/hiddenCategories 是记账分类的用户配置（见 utils/category-utils.js）。 */
const SETTINGS_KEYS = ['budget', 'height', 'targetWeight', 'categoryBudgets', 'aiConsent', 'theme', 'customCategories', 'favoriteCategories', 'hiddenCategories'];

function pickSettings(source) {
  const input = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const result = {};
  SETTINGS_KEYS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(input, key)) return;
    result[key] = key === 'categoryBudgets' && input[key] && typeof input[key] === 'object' && !Array.isArray(input[key])
      ? { ...input[key] }
      : Array.isArray(input[key])
        ? input[key].slice()
        : input[key];
  });
  return result;
}

module.exports = { SETTINGS_KEYS, pickSettings };
