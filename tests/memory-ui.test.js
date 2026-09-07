/* 生活时间线视觉契约：单一入口、时间轴阅读流和不重复的空状态。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/memory/memory.wxml'), 'utf8');
const wxss = fs.readFileSync(path.join(root, 'miniprogram/pages/memory/memory.wxss'), 'utf8');
const js = fs.readFileSync(path.join(root, 'miniprogram/pages/memory/memory.js'), 'utf8');
const money = fs.readFileSync(path.join(root, 'miniprogram/pages/money/money.wxml'), 'utf8');

assert.match(wxml, /class="memory-hero"/, '时间线需要有单一的主入口');
assert.match(wxml, /class="memory-timeline"/, '有记录时需要使用时间轴阅读流');
assert.match(wxml, /class="memory-day-head"/, '时间轴需要按日期建立节点');
assert.match(wxml, /class="memory-empty"/, '空状态需要单独设计');
assert.doesNotMatch(wxml, /class="fab memory-fab"[^>]*>/, '空状态不应再同时出现固定加号');
assert.match(wxss, /\.memory-day-items\s*\{[^}]*border-left:/s, '日期记录需要有连续的时间轴线');
assert.match(js, /dayCount/, '时间线标题需要展示记录覆盖天数');
assert.match(money, /class="money-in"/);
assert.match(money, /class="money-out"/);
assert.match(money, /class="money-color-note(?:\s|")/, '记账页需要解释收支颜色语义');
console.log('MEMORY_UI_TEST_PASSED');
