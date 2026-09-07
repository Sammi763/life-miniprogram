const assert = require('assert');
const fs = require('fs');
const path = require('path');

let savedTheme = 'paper';
const navigationCalls = [];
let pageUpdates = [];
let tabUpdates = [];

global.wx = {
  getStorageSync: () => savedTheme,
  setStorageSync: (key, value) => { if (key === 'wb_life_theme') savedTheme = value; },
  setNavigationBarColor: (payload) => navigationCalls.push(payload),
  setBackgroundColor: () => {}
};
global.getCurrentPages = () => [{
  data: {},
  setData: (value) => pageUpdates.push(value),
  getTabBar: () => ({ setData: (value) => tabUpdates.push(value) })
}];

const theme = require('../miniprogram/utils/theme');

assert.strictEqual(theme.THEMES.length, 4, '应提供四套可选主题');
assert.strictEqual(theme.getThemeId(), 'paper', '应优先恢复本机主题选择');
assert.strictEqual(theme.getThemeId('sky'), 'sky', '已知主题应可被显式选择');
assert.strictEqual(theme.getThemeId('unknown'), 'forest', '未知主题必须安全回退到默认主题');
assert.match(theme.getThemeStyle('violet'), /--accent:#6C557C/, '主题样式必须提供受控强调色变量');

const result = theme.selectTheme('sky');
assert.strictEqual(savedTheme, 'sky', '选择后应写入本机偏好');
assert.strictEqual(result.themeId, 'sky', '选择结果应返回当前主题数据');
assert.ok(pageUpdates.some((item) => item.themeId === 'sky' && /--bg:#F1F5F8/.test(item.themeStyle)), '已打开页面应立即拿到新主题样式');
assert.ok(tabUpdates.some((item) => /--accent:#2E637D/.test(item.themeStyle)), '自定义导航应同步主题样式');
assert.ok(navigationCalls.some((item) => item.backgroundColor === '#F1F5F8'), '系统导航栏应同步更新');

const pageRoot = path.resolve(__dirname, '../miniprogram/pages');
for (const pageName of fs.readdirSync(pageRoot)) {
  const file = path.join(pageRoot, pageName, pageName + '.wxml');
  if (!fs.existsSync(file)) continue;
  const markup = fs.readFileSync(file, 'utf8');
  assert.match(markup, /theme-page[\s\S]*themeStyle|themeStyle[\s\S]*theme-page/, pageName + ' 页面应承接当前主题变量');
}

console.log('THEME_UTILS_TEST_PASSED');
