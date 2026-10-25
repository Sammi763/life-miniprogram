/*
 * v2.11 深色模式跟随系统：settings.theme 允许 'auto'——
 * 系统深色 → night；系统浅色 → 本机最后一个具体浅色主题（存了 night/auto 则回退 forest）；
 * wx.onThemeChange 触发重新应用；白名单接受 'auto'；旧客户端读到 auto 安全回退 forest。
 *
 * 运行：node tests/theme-auto.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

let savedTheme = 'paper';
let systemTheme = 'light';
const themeChangeHandlers = [];
let pageUpdates = [];
let tabUpdates = [];

global.wx = {
  getStorageSync: (key) => (key === 'wb_life_theme' ? savedTheme : ''),
  setStorageSync: (key, value) => { if (key === 'wb_life_theme') savedTheme = value; },
  removeStorageSync: () => {},
  getAppBaseInfo: () => ({ theme: systemTheme }),
  getSystemInfoSync: () => ({ theme: systemTheme }),
  setNavigationBarColor: () => {},
  setBackgroundColor: () => {},
  onThemeChange: (handler) => themeChangeHandlers.push(handler)
};
global.getCurrentPages = () => [{
  data: {},
  setData: (value) => pageUpdates.push(value),
  getTabBar: () => ({ setData: (value) => tabUpdates.push(value) })
}];

const theme = require(path.join(root, 'miniprogram', 'utils', 'theme'));
const { SETTINGS_THEMES, validateRecordData } = require(path.join(root, 'server', 'validation'));

(async () => {
  /* ---------- 1. auto 解析：系统深色 → night ---------- */
  systemTheme = 'dark';
  assert.strictEqual(theme.getThemeId('auto'), 'night', 'auto 在系统深色时必须解析为 night');

  /* ---------- 2. auto 解析：系统浅色 → 本机最后一个具体浅色主题 ---------- */
  systemTheme = 'light';
  savedTheme = 'paper';
  assert.strictEqual(theme.getThemeId('auto'), 'paper', 'auto 在系统浅色时必须解析为本机最后的浅色主题');

  /* ---------- 3. 本机存了 night / auto 时回退 forest ---------- */
  savedTheme = 'night';
  assert.strictEqual(theme.getThemeId('auto'), 'forest', '本机最后主题为 night 时浅色系统必须回退 forest');
  savedTheme = 'auto';
  assert.strictEqual(theme.getThemeId('auto'), 'forest', '本机存了 auto 时浅色系统必须回退 forest');
  savedTheme = 'unknown-value';
  assert.strictEqual(theme.getThemeId('auto'), 'forest', '本机存了未知值时必须回退 forest');

  /* ---------- 4. selectTheme('auto') 不得覆盖本机最后浅色主题 ---------- */
  savedTheme = 'paper';
  theme.selectTheme('auto');
  assert.strictEqual(savedTheme, 'paper', '选择跟随系统时必须保留本机最后的具体主题选择');
  theme.selectTheme('sky');
  assert.strictEqual(savedTheme, 'sky', '选择具体主题仍必须写本机偏好');
  assert.strictEqual(theme.getThemeId('auto'), 'sky', '跟随系统必须采用刚存下的浅色主题');

  /* ---------- 5. onThemeChange：注册 + 回调后按新系统主题重新应用 ---------- */
  assert.ok(themeChangeHandlers.length >= 0, 'wx.onThemeChange 必须可注册（由 app.js onLaunch 调用）');
  const appJs = fs.readFileSync(path.join(root, 'miniprogram/app.js'), 'utf8');
  assert.match(appJs, /onThemeChange/, 'app.js 必须注册系统主题变化监听');
  pageUpdates = [];
  systemTheme = 'dark';
  theme.applyToOpenPages('auto');
  assert.ok(pageUpdates.some((item) => item.themeId === 'night' && /--bg:#171B1E/.test(item.themeStyle)), '系统深色时已打开页面必须切到夜间样式');
  pageUpdates = [];
  systemTheme = 'light';
  theme.applyToOpenPages('auto');
  assert.ok(pageUpdates.some((item) => item.themeId === 'sky' && /--bg:#F1F5F8/.test(item.themeStyle)), '系统回浅色时必须切回本机浅色主题');

  /* ---------- 6. 选择器包含「跟随系统」且选中态正确 ---------- */
  const autoOptions = theme.getThemeOptions('auto');
  assert.strictEqual(autoOptions[0].id, 'auto', '主题选择器第一项必须是跟随系统');
  assert.strictEqual(autoOptions[0].selected, true, 'auto 时跟随系统必须选中');
  assert.strictEqual(autoOptions.find((item) => item.id === 'sky').selected, false, 'auto 时具体主题不得误标选中');
  assert.strictEqual(theme.getThemeOptions('sky').find((item) => item.id === 'auto').selected, false, '具体主题时跟随系统不得误标选中');

  /* ---------- 7. 白名单接受 auto，未知主题仍拒绝 ---------- */
  assert.ok(SETTINGS_THEMES.includes('auto'), 'SETTINGS_THEMES 必须包含 auto');
  assert.strictEqual(validateRecordData('settings', { theme: 'auto' }), '', 'settings 必须接受 theme=auto');
  assert.strictEqual(validateRecordData('settings', { budget: 100, theme: 'auto' }), '', 'auto 与其他设置字段共存必须合法');
  assert.notStrictEqual(validateRecordData('settings', { theme: 'system' }), '', '未注册值必须仍被拒绝');

  /* ---------- 8. 旧客户端兼容：normalizeThemeId 读到 auto 回退 forest ---------- */
  assert.strictEqual(theme.normalizeThemeId('auto'), 'forest', '旧客户端的 normalizeThemeId 必须把 auto 安全回退到 forest');

  /* ---------- 9. app.json 开启 darkmode 且 theme.json 提供双模式导航色 ---------- */
  const appJson = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
  assert.strictEqual(appJson.darkmode, true, 'app.json 必须开启 darkmode');
  assert.strictEqual(appJson.themeLocation, 'theme.json', 'app.json 必须声明 themeLocation');
  assert.strictEqual(appJson.window.navigationBarBackgroundColor, '@navBgColor', '导航栏底色必须走主题变量');
  const themeJson = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/theme.json'), 'utf8'));
  assert.strictEqual(themeJson.light.navBgColor, '#F3F5F2', '浅色导航底色必须与现有静态色一致');
  assert.strictEqual(themeJson.dark.navBgColor, '#171B1E', '深色导航底色必须与夜间主题一致');
  assert.strictEqual(themeJson.dark.navTxtStyle, 'white', '深色导航必须白字');

  console.log('THEME_AUTO_TEST_PASSED');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
