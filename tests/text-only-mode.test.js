/* 文本优先产品契约：不再采集、上传或展示用户图片，记录卡片仍具备明确的点击反馈。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const api = read('miniprogram/utils/api.js');
const login = read('miniprogram/pages/login/login.wxml');
const mediaJs = read('miniprogram/pages/media/media.js');
const media = read('miniprogram/pages/media/media.wxml');
const mine = read('miniprogram/pages/mine/mine.wxml');
const appCss = read('miniprogram/app.wxss');
const server = read('server/server.js');
const schema = read('server/db/schema.sql');
const privacy = read('docs/PRIVACY.md');
const caddy = read('server/deploy/Caddyfile.example');
const env = read('server/.env.example');

assert.doesNotMatch(api, /\buploadFile\b|\bresolveFileUrl\b|access_token=/, '客户端不应再保留文件上传或私有图片 URL 拼接');
assert.doesNotMatch(server, /\bmulter\b|\/api\/upload|\/files\/:fileName/, '服务端不应再暴露上传或私有文件接口');
assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS uploads/i, '新建数据库不应再创建上传文件表');
assert.doesNotMatch(caddy, /handle \/files/, '生产代理不应再转发文件下载路径');
assert.doesNotMatch(env, /^UPLOAD_/m, '生产配置不应保留上传限额');

assert.doesNotMatch(login, /chooseAvatar|open-type="chooseAvatar"/, '登录资料页不应请求微信头像');
assert.doesNotMatch(mine, /<image/, '我的页面应使用文字头像，不读取远程图片');
assert.match(login, /text-avatar/, '登录资料页应展示生成的文字头像');
assert.doesNotMatch(mediaJs, /chooseMedia|chooseImage|chooseCover|coverPath|coverUrl|uploadFile/, '书影音不应再选择或上传封面');
assert.doesNotMatch(media, /<image|cover-upload/, '书影音应为纯文字卡片');
assert.match(media, /media-monogram/, '书影音卡片应有文字化的类型标识');
assert.doesNotMatch(privacy, /相册\s*\/\s*相机|头像/, '隐私指引只能声明实际使用的能力');

for (const relative of [
  'miniprogram/pages/money/money.wxml',
  'miniprogram/pages/plan/plan.wxml',
  'miniprogram/pages/shopping/shopping.wxml',
  'miniprogram/pages/media/media.wxml'
]) {
  assert.match(read(relative), /hover-class="record-card-pressed"/, `${relative} 的文字记录卡片应有按压反馈`);
}
assert.match(appCss, /\.record-card-pressed/, '全局应定义轻量按压反馈样式');

console.log('TEXT_ONLY_MODE_TEST_PASSED');
