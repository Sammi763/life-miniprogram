const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
for (const page of ['pages/memory/memory', 'pages/review/review', 'pages/search/search']) {
  assert.ok(config.pages.includes(page), page + ' 应注册为非 Tab 页面');
  assert.ok(fs.existsSync(path.join(root, 'miniprogram', page + '.js')), page + '.js 应存在');
  assert.ok(fs.existsSync(path.join(root, 'miniprogram', page + '.wxml')), page + '.wxml 应存在');
}
assert.strictEqual(config.tabBar.list.length, 4, '随记不应新增 Tab');
assert.ok(fs.existsSync(path.join(root, '.github/workflows/ci.yml')), '应提供 CI 工作流');
console.log('V17_STRUCTURE_TEST_PASSED');
