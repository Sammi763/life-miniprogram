/*
 * 夜间主题 —— token 键集与其他主题完全一致、导航前景色随主题、settings 可同步。
 * 运行：node tests/theme-night.test.js
 */
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const theme = require(path.join(root, 'miniprogram', 'utils', 'theme'));
const { SETTINGS_THEMES, validateRecordData } = require(path.join(root, 'server', 'validation'));

(async () => {
  const night = theme.THEMES.find((item) => item.id === 'night');
  assert.ok(night, '必须提供 night 主题');

  /* 1. token 键集与其他主题完全一致（CSS 变量覆盖不能有遗漏，否则夜间会漏出浅色底） */
  const referenceKeys = Object.keys(theme.THEMES.find((item) => item.id === 'forest').tokens).sort();
  for (const item of theme.THEMES) {
    assert.deepStrictEqual(Object.keys(item.tokens).sort(), referenceKeys, item.id + ' 的 token 键集必须与 forest 完全一致');
  }

  /* 2. 夜间配色必须是深色底 + 合法颜色值 */
  assert.ok(/^#[0-9A-Fa-f]{6}$/.test(night.tokens['--bg']), 'bg 必须是合法 hex');
  const bg = night.tokens['--bg'];
  const luminance = parseInt(bg.slice(1, 3), 16) + parseInt(bg.slice(3, 5), 16) + parseInt(bg.slice(5, 7), 16);
  assert.ok(luminance < 200, '夜间主题背景必须是深色（实际 ' + bg + '）');
  assert.strictEqual(night.navigationFront, '#ffffff', '夜间导航栏必须白字');
  for (const item of theme.THEMES.filter((t) => t.id !== 'night')) {
    assert.ok(!item.navigationFront || item.navigationFront === '#000000', '浅色主题导航栏必须黑字');
  }

  /* 3. 主题选择与样式注入 */
  assert.strictEqual(theme.normalizeThemeId('night'), 'night');
  const style = theme.getThemeStyle('night');
  assert.ok(style.includes('--bg:#171B1E'), 'themeStyle 必须内联夜间变量');
  assert.strictEqual(theme.getThemeOptions('night').find((item) => item.id === 'night').selected, true, '选择器必须包含夜间且可选中');

  /* 4. settings 同步白名单接受 night */
  assert.ok(SETTINGS_THEMES.includes('night'), 'SETTINGS_THEMES 必须包含 night');
  assert.strictEqual(validateRecordData('settings', { theme: 'night' }), '');
  assert.notStrictEqual(validateRecordData('settings', { theme: 'midnight' }), '', '未注册主题必须被拒');

  /* 5. mine 页主题选择器渲染来自 getThemeOptions（无需单独改 mine.wxml 结构） */
  const mineJs = require('fs').readFileSync(path.join(root, 'miniprogram/pages/mine/mine.js'), 'utf8');
  assert.match(mineJs, /theme\.getThemeOptions/, 'mine 页必须从 theme 模块取主题选项');

  console.log('THEME_NIGHT_TEST_PASSED');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
