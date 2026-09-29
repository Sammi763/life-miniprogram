const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const share = require('../miniprogram/utils/share');

function read(relative) { return fs.readFileSync(path.join(root, relative), 'utf8'); }

/* ---------- 1. 卡片文案与路径：全部来自静态表 ---------- */

const KEYS = Object.keys(share.TARGETS);
assert.ok(KEYS.length >= 12, '分享目标应覆盖主要页面');

KEYS.forEach((key) => {
  const target = share.TARGETS[key];
  assert.strictEqual(share.onShareAppMessage(key)().title, target.title, key + ' 转发标题应取自静态表');
  assert.strictEqual(share.onShareTimeline(key)().title, target.title, key + ' 朋友圈标题应取自静态表');
  /* 隐私红线：卡片文案里不得出现金额符号或数字，避免把个人数据带出应用 */
  assert.ok(!/¥|\d/.test(target.title), key + ' 的分享文案不应包含金额符号或数字');
  assert.match(target.path, /^\/pages\/[a-z]+\/[a-z]+$/, key + ' 的分享路径必须是包内页面路径');
});

const message = share.onShareAppMessage('memory')();
assert.deepStrictEqual(Object.keys(message).sort(), ['imageUrl', 'path', 'title'], '转发卡片只应包含 title/path/imageUrl');
assert.strictEqual(message.imageUrl, share.SHARE_IMAGE, '转发应显式指定分享图，避免默认使用页面截图');

/* 未知 key 回退到今天，不能返回 undefined 让微信展示空卡片 */
const unknown = share.onShareAppMessage('not-a-page')();
assert.strictEqual(unknown.title, share.TARGETS.today.title);
assert.strictEqual(unknown.path, share.TARGETS.today.path);

const timeline = share.onShareTimeline('money')();
assert.strictEqual(timeline.query, '', '朋友圈卡片不应携带任何本机参数');
assert.ok(!('path' in timeline), '朋友圈卡片不支持 path，必须只用 query');
assert.strictEqual(timeline.imageUrl, share.SHARE_IMAGE);

/* ---------- 2. 隐私：分享模块不得接触任何用户数据 ---------- */

const source = read('miniprogram/utils/share.js');
assert.doesNotMatch(source, /require\([^)]*\bstore\b[^)]*\)/, '分享模块不得依赖 store，否则可能把记录写进卡片');
assert.doesNotMatch(source, /require\([^)]*\bsync\b[^)]*\)/, '分享模块不得依赖 sync');
assert.doesNotMatch(source, /getStorageSync|getStorageInfoSync|getAccountInfoSync/, '分享模块不得读取本机存储或账号信息');

/* ---------- 3. 菜单开关：宿主缺失或抛错都不能影响页面 ---------- */

const originalWx = global.wx;
try {
  let received = null;
  global.wx = { showShareMenu: (options) => { received = options; } };
  assert.strictEqual(share.enableShareMenu(), true, '正常宿主应返回 true');
  assert.deepStrictEqual(received.menus, ['shareAppMessage', 'shareTimeline'], '必须同时打开转发与朋友圈菜单项');
  assert.strictEqual(received.withShareTicket, false);

  global.wx = {};
  assert.strictEqual(share.enableShareMenu(), false, '不支持 showShareMenu 的宿主应静默返回 false');

  global.wx = { showShareMenu: () => { throw new Error('host rejected'); } };
  assert.strictEqual(share.enableShareMenu(), false, '宿主抛错时不得把异常抛给页面');

  global.wx = undefined;
  assert.strictEqual(share.enableShareMenu(), false, '无宿主环境应静默返回 false');
} finally {
  global.wx = originalWx;
}

/* ---------- 4. 结构契约：页面接线与有意排除 ---------- */

const WIRED_PAGES = ['login', 'today', 'money', 'habit', 'mine', 'plan', 'shopping', 'media', 'fitness', 'report', 'memory', 'review'];
WIRED_PAGES.forEach((page) => {
  assert.ok(share.TARGETS[page], page + ' 应在分享目标表里有条目');
  const js = read('miniprogram/pages/' + page + '/' + page + '.js');
  assert.match(js, /const share = require\('\.\.\/\.\.\/utils\/share'\);/, page + ' 需引入分享模块');
  assert.match(js, new RegExp("onShareAppMessage: share\\.onShareAppMessage\\('" + page + "'\\)"), page + ' 需挂载转发处理函数');
  assert.match(js, new RegExp("onShareTimeline: share\\.onShareTimeline\\('" + page + "'\\)"), page + ' 需挂载朋友圈处理函数');
  assert.match(js, /share\.enableShareMenu\(\)/, page + ' 需在页面可见时打开朋友圈菜单项');
});

/* 搜索页是瞬时筛选状态、协议页需要文档参数，都不适合作为分享落点 */
['search', 'legal'].forEach((page) => {
  const js = read('miniprogram/pages/' + page + '/' + page + '.js');
  assert.doesNotMatch(js, /utils\/share/, page + ' 不应接入分享');
});

const mineWxml = read('miniprogram/pages/mine/mine.wxml');
assert.match(mineWxml, /open-type="share"/, '「我的」页需要可见的转发入口，否则功能不可发现');
/* 纯文字约束（text-only-mode）不可被此次改动破坏 */
assert.doesNotMatch(mineWxml, /<image/, '「我的」页必须保持纯文字，不引入图片');

console.log('SHARE_TEST_PASSED');
