/* AI 洞察与今日主视觉的页面契约。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const readJson = (file) => JSON.parse(read(file));

const today = read('miniprogram/pages/today/today.wxml');
const todayJs = read('miniprogram/pages/today/today.js');
const report = read('miniprogram/pages/report/report.wxml');
const reportJs = read('miniprogram/pages/report/report.js');
const api = read('miniprogram/utils/api.js');
const app = readJson('miniprogram/app.json');

assert.match(today, /today-hero/, '今日页首屏需要明确的主视觉');
assert.match(today, /\{\{aiInsight\}\}/, '今日页需要渲染个性化轻提醒');
assert.match(todayJs, /getInsight\(['"]today['"]\)/, '今日页需要请求轻提醒');
assert.match(report, /aiSummary/, '月报需要渲染个性化一句话');
assert.match(reportJs, /getInsight\(['"]month['"]/, '月报需要请求个性化一句话');
assert.match(api, /\/api\/insights/, '客户端洞察请求必须走受保护的服务端接口');
assert.strictEqual(app.tabBar.custom, true, '底部导航需要使用可突出当前页的自定义导航');
for (const file of ['miniprogram/custom-tab-bar/index.js', 'miniprogram/custom-tab-bar/index.json', 'miniprogram/custom-tab-bar/index.wxml', 'miniprogram/custom-tab-bar/index.wxss']) {
  assert.ok(fs.existsSync(path.join(root, file)), `自定义导航缺少文件：${file}`);
}
assert.match(read('miniprogram/custom-tab-bar/index.wxml'), /is-selected/, '当前 tab 必须有独立选中样式');
console.log('AI_UI_TEST_PASSED');
