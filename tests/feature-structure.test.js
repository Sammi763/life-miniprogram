/* 功能路线契约：待开发模块必须具备可被小程序导航的页面文件。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
const exists = (relativePath) => fs.existsSync(path.join(ROOT, relativePath));

const app = readJson('miniprogram/app.json');
const featurePages = [
  'pages/login/login',
  'pages/plan/plan',
  'pages/shopping/shopping',
  'pages/media/media',
  'pages/fitness/fitness',
  'pages/report/report',
  'pages/memory/memory',
  'pages/review/review',
  'pages/search/search'
];

for (const page of featurePages) {
  assert.ok(app.pages.includes(page), `app.json 未注册功能页：${page}`);
  for (const extension of ['.js', '.json', '.wxml', '.wxss']) {
    assert.ok(exists(path.join('miniprogram', page + extension)), `功能页缺少文件：${page + extension}`);
  }
}

assert.strictEqual(app.tabBar.list.length, 4, '主 Tab 仍保持四项');
assert.strictEqual(app.window.navigationBarTitleText, '生活记忆 life', '小程序名称应统一');
assert.ok(exists('server/db/schema.sql'), '数据库 schema 文件必须存在');
assert.ok(exists('server/db/migrate.js'), '数据库迁移脚本必须存在');
assert.ok(exists('miniprogram/assets/logo.png'), '品牌 logo 必须放在小程序源码目录');
console.log('FEATURE_STRUCTURE_TEST_PASSED');
