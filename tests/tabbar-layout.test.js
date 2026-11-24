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
const moneyWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/money/money.wxml'), 'utf8');
const moneyAdd = moneyWxml.indexOf('class="btn btn-primary money-add"');
assert.match(moneyWxml, /<button class="btn btn-primary money-add" bindtap="openAdd"[^>]*>＋ 记一笔<\/button>/);
assert.ok(moneyAdd >= 0 && moneyAdd < moneyWxml.indexOf('class="report-entry'), '在账本顶部提供记一笔');
assert.doesNotMatch(moneyWxml, /\bfab\b/, '记账入口进入文档流，避免遮挡列表和账户控件');
assert.doesNotMatch(moneyWxss, /\.money-add\s*\{[^}]*position:\s*(fixed|absolute|sticky)/);
assert.match(habitWxss, /\.fab\s*\{[^}]*bottom:\s*calc\(1[5-9]\drpx/s, '习惯新增按钮需要避开导航');
console.log('TABBAR_LAYOUT_TEST_PASSED');
