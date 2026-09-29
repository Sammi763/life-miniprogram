/*
 * 夜间主题跨页导航 —— 原生导航栏颜色是「页面级」的：微信每次页面切换都会回到
 * app.json 的默认配色，因此每次进入页面（applyToPage / applyToOpenPages）都必须
 * 重新调用 wx.setNavigationBarColor，不能因为模块级「主题没变」缓存而跳过。
 * 运行：node tests/theme-navigation.test.js
 */
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');

let navigationCalls = [];
let backgroundCalls = [];
global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  setNavigationBarColor: (payload) => navigationCalls.push(payload),
  setBackgroundColor: (payload) => backgroundCalls.push(payload)
};

const theme = require(path.join(root, 'miniprogram', 'utils', 'theme'));

(async () => {
  /* ---------- 1. 同一主题下两次「进入页面」都必须设置导航栏 ---------- */
  theme.applyToPage({ data: {}, setData: () => {} });   // 页面 A（如 today）首次进入
  const firstCount = navigationCalls.length;
  assert.ok(firstCount >= 1, '首次进入页面必须设置原生导航栏颜色');
  theme.applyToPage({ data: {}, setData: () => {} });   // 页面 B（如 plan）进入：原生导航栏已回到默认配色
  assert.ok(navigationCalls.length > firstCount, '主题未变也不能跳过：页面切换后原生导航栏会回到默认配色，必须重设');

  /* ---------- 2. 夜间主题：前景白字、背景深色 ---------- */
  navigationCalls = [];
  backgroundCalls = [];
  theme.applyToPage({ data: {}, setData: () => {} }, 'night');
  const night = navigationCalls[navigationCalls.length - 1];
  assert.strictEqual(night.frontColor, '#ffffff', '夜间主题导航栏必须白字');
  assert.strictEqual(night.backgroundColor, '#171B1E', '夜间主题导航栏背景必须深色');

  /* ---------- 3. 浅色主题：黑字 ---------- */
  navigationCalls = [];
  theme.applyToPage({ data: {}, setData: () => {} }, 'sky');
  assert.strictEqual(navigationCalls[navigationCalls.length - 1].frontColor, '#000000', '浅色主题导航栏必须黑字');

  /* ---------- 4. applyToOpenPages（主题切换路径）同样每次都设置 ---------- */
  navigationCalls = [];
  global.getCurrentPages = () => [{ data: {}, setData: () => {}, getTabBar: () => ({ setData: () => {} }) }];
  theme.applyToOpenPages('night');
  theme.applyToOpenPages('night');
  assert.ok(navigationCalls.length >= 2, 'applyToOpenPages 也不能因缓存跳过导航栏设置');

  console.log('THEME_NAVIGATION_TEST_PASSED');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
