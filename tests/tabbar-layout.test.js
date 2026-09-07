/* 自定义导航布局测试：内容和主要操作不能被悬浮导航遮挡。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const tabPages = ['today', 'money', 'habit', 'mine'];
tabPages.forEach((page) => {
  const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages', page, page + '.wxml'), 'utf8');
  assert.match(wxml, /class="tabbar-spacer"/, page + ' 需要为悬浮导航预留底部空间');
});

const appWxss = fs.readFileSync(path.join(root, 'miniprogram/app.wxss'), 'utf8');
assert.match(appWxss, /\.tabbar-spacer\s*\{[^}]*height:/s, '需要统一的导航底部留白');
const moneyWxss = fs.readFileSync(path.join(root, 'miniprogram/pages/money/money.wxss'), 'utf8');
const habitWxss = fs.readFileSync(path.join(root, 'miniprogram/pages/habit/habit.wxss'), 'utf8');
assert.match(moneyWxss, /\.fab\s*\{[^}]*bottom:\s*calc\(1[5-9]\drpx/s, '记账新增按钮需要避开导航');
assert.match(habitWxss, /\.fab\s*\{[^}]*bottom:\s*calc\(1[5-9]\drpx/s, '习惯新增按钮需要避开导航');
console.log('TABBAR_LAYOUT_TEST_PASSED');
