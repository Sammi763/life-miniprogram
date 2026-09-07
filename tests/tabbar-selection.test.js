/* 自定义导航选中态测试：每个 Tab 页显示时都必须主动同步自己的索引。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const expected = { today: 0, money: 1, habit: 2, mine: 3 };
const helper = fs.readFileSync(path.join(root, 'miniprogram/utils/tabbar.js'), 'utf8');
assert.match(helper, /getTabBar/, '需要通过页面获取自定义导航组件');
Object.entries(expected).forEach(([page, index]) => {
  const source = fs.readFileSync(path.join(root, 'miniprogram/pages', page, page + '.js'), 'utf8');
  assert.match(source, new RegExp('syncTabBar\\(this,\\s*' + index + '\\)'), page + ' 页面必须同步自己的导航索引');
});
console.log('TABBAR_SELECTION_TEST_PASSED');
