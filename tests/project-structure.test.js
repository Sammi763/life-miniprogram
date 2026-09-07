/* 微信开发者工具运行契约：根目录导入时，配置必须能定位到小程序源码。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
const exists = (relativePath) => fs.existsSync(path.join(ROOT, relativePath));

const projectConfig = readJson('project.config.json');

assert.strictEqual(projectConfig.compileType, 'miniprogram', '根配置必须是小程序项目');
assert.ok(projectConfig.miniprogramRoot, '根配置必须声明 miniprogramRoot');
assert.ok(exists(projectConfig.miniprogramRoot), 'miniprogramRoot 目录必须存在');

const appConfig = readJson(path.join(projectConfig.miniprogramRoot, 'app.json'));
assert.ok(Array.isArray(appConfig.pages) && appConfig.pages.length > 0, 'app.json 必须注册至少一个页面');

for (const page of appConfig.pages) {
  for (const extension of ['.js', '.json', '.wxml', '.wxss']) {
    assert.ok(exists(path.join(projectConfig.miniprogramRoot, page + extension)), `页面缺少文件：${page + extension}`);
  }
}

assert.ok(exists(path.join(projectConfig.miniprogramRoot, appConfig.sitemapLocation || 'sitemap.json')), 'sitemap 文件必须存在');
console.log('PROJECT_STRUCTURE_TEST_PASSED');
