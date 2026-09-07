const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const login = read('miniprogram/pages/login/login.wxml');
const mine = read('miniprogram/pages/mine/mine.wxml');
const sync = read('miniprogram/utils/sync.js');
const globalStyle = read('miniprogram/app.wxss');
const app = JSON.parse(read('miniprogram/app.json'));
const theme = read('miniprogram/utils/theme.js');
const tabbar = read('miniprogram/custom-tab-bar/index.wxml');

assert.doesNotMatch(login, /服务器地址|baseInput|showServerSettings|127\.0\.0\.1/, '登录页不应向用户暴露服务端地址或可编辑入口');
assert.doesNotMatch(mine, /服务器地址|baseInput|showServerSettings|127\.0\.0\.1/, '“我的”页不应向用户暴露服务端地址或可编辑入口');
assert.match(mine, /profile-hero/, '“我的”页应使用简洁的资料首屏布局');
assert.match(mine, /data-status/, '“我的”页应提供非技术化的数据状态反馈');
assert.match(globalStyle, /--accent:/, '全局视觉系统应定义统一强调色');
assert.match(theme, /id: 'forest'/, '应保留默认主题');
assert.match(theme, /id: 'paper'/, '应提供暖纸主题');
assert.match(theme, /id: 'sky'/, '应提供月白主题');
assert.match(theme, /id: 'violet'/, '应提供暮紫主题');
assert.match(mine, /onThemeSelect/, '“我的”页应提供主题切换入口');
assert.match(tabbar, /themeStyle/, '自定义导航应随页面主题同步');
assert.strictEqual(app.window.navigationBarBackgroundColor, '#F3F5F2', '导航栏应使用新的低饱和中性色');
assert.match(sync, /function shouldUseRealtime/, '本地调试不应无条件尝试 WebSocket 连接');

console.log('UI_SECURITY_DESIGN_TEST_PASSED');
