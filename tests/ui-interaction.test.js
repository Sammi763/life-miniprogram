/*
 * 页面交互优化回归（v2.4）。
 * 覆盖两类内容：
 * 1) 运行时行为：utils/ui.js 的重复点击节流与手动重试反馈；
 * 2) 结构契约：离线重试入口、悬浮按钮与可点行的按压反馈、底部弹层高度约束、
 *    以及各处写入型操作的防重复调用（防止后续改动把节流删掉）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const pagesDir = path.join(root, 'miniprogram', 'pages');
const pageFiles = fs.readdirSync(pagesDir);

const events = [];
let behavior = () => {};

global.wx = {
  showLoading: (options) => events.push(['showLoading', options && options.title, !!(options && options.mask)]),
  hideLoading: () => events.push(['hideLoading']),
  showToast: (options) => events.push(['showToast', options && options.title, options && options.icon])
};

const ui = require('../miniprogram/utils/ui');

async function main() {
  // ---- 1. 重复点击节流 ----
  const page = {};
  assert.strictEqual(ui.isRepeatedTap(page, 'save', 400), false, '首次点击不应被忽略');
  assert.strictEqual(ui.isRepeatedTap(page, 'save', 400), true, '节流窗口内的第二次点击应被忽略');
  assert.strictEqual(ui.isRepeatedTap(page, 'other', 400), false, '不同 key 互不影响');
  assert.strictEqual(ui.isRepeatedTap(null, 'save', 400), false, '空页面实例应安全返回 false');
  await new Promise((resolve) => setTimeout(resolve, 420));
  assert.strictEqual(ui.isRepeatedTap(page, 'save', 400), false, '超过节流窗口后应再次放行');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(page, '__lastTapAt'), true, '节流时间戳应存在页面实例上，不进 data');

  // ---- 2. 手动重试反馈 ----
  events.length = 0;
  const okResult = await ui.retryWithFeedback(() => Promise.resolve(true));
  assert.strictEqual(okResult, true);
  assert.deepStrictEqual(events[0], ['showLoading', '正在重试', true], '重试必须带遮罩的加载态');
  assert.deepStrictEqual(events[1], ['hideLoading'], '先关闭加载态');
  assert.deepStrictEqual(events[2], ['showToast', '已同步', 'success'], '成功给明确反馈');

  events.length = 0;
  const offResult = await ui.retryWithFeedback(() => Promise.resolve(false));
  assert.strictEqual(offResult, false, 'sync.pull() 返回 false 表示仍离线');
  assert.deepStrictEqual(events[2], ['showToast', '仍无法连接，改动已暂存本机', 'none'], '离线必须给出说明而不是静默');

  events.length = 0;
  const throwResult = await ui.retryWithFeedback(() => { throw new Error('boom'); });
  assert.strictEqual(throwResult, false, '同步抛错必须收敛为失败而不是抛出');
  assert.deepStrictEqual(events[1], ['hideLoading'], '抛错也不能把加载态留在屏幕上');

  events.length = 0;
  const rejectResult = await ui.retryWithFeedback(() => Promise.reject(new Error('boom')));
  assert.strictEqual(rejectResult, false);
  assert.deepStrictEqual(events[1], ['hideLoading']);
  assert.strictEqual(events.some((event) => event[0] === 'showLoading'), true);
  assert.strictEqual(events.length, 3, '每次重试只产生一次加载态与一次结果提示');

  // ---- 3. 结构契约：离线重试入口 ----
  const bannerPages = pageFiles.filter((name) => {
    const file = path.join(pagesDir, name, name + '.wxml');
    return fs.existsSync(file) && /class="banner"/.test(fs.readFileSync(file, 'utf8'));
  });
  assert.ok(bannerPages.length >= 9, '离线横幅应覆盖各个数据页');
  for (const name of bannerPages) {
    const wxml = read(`miniprogram/pages/${name}/${name}.wxml`);
    const js = read(`miniprogram/pages/${name}/${name}.js`);
    assert.match(wxml, /bindtap="retrySync"/, `${name} 的离线重试应绑定 retrySync`);
    assert.doesNotMatch(wxml, /bindtap="onPullDownRefresh"/, `${name} 不应把生命周期回调当点击事件用`);
    assert.match(wxml, /hover-class="tap-pressed"/, `${name} 的重试入口应有按压反馈`);
    assert.match(js, /retrySync\(\)\s*\{\s*return ui\.retryWithFeedback\(/, `${name} 必须定义带反馈的 retrySync`);
    assert.match(js, /const ui = require\('\.\.\/\.\.\/utils\/ui'\)/, `${name} 必须引入 ui 工具`);
  }

  // ---- 4. 结构契约：悬浮按钮与底部弹层 ----
  const fabPages = [];
  for (const name of pageFiles) {
    const file = path.join(pagesDir, name, name + '.wxml');
    if (!fs.existsSync(file)) continue;
    const wxml = fs.readFileSync(file, 'utf8');
    if (/class="fab"/.test(wxml)) {
      fabPages.push(name);
      assert.match(wxml, /class="fab"[^>]*hover-class="fab-pressed"/, `${name} 的悬浮按钮应有按压反馈`);
    }
  }
  assert.ok(fabPages.length >= 5, `悬浮按钮应覆盖各记录页，实际 ${fabPages.length} 个`);

  const appWxss = read('miniprogram/app.wxss');
  assert.match(appWxss, /\.tap-pressed\s*\{/, '缺少通用按压反馈样式');
  assert.match(appWxss, /\.fab-pressed\s*\{/, '缺少悬浮按钮按压样式');
  assert.match(appWxss, /\.banner-action\s*\{/, '缺少横幅操作样式');
  assert.match(appWxss, /\.sheet\s*\{[^}]*max-height/, '底部弹层必须有高度上限，否则长表单会把保存按钮挤出屏幕');
  assert.match(appWxss, /\.sheet\s*\{[^}]*overflow-y\s*:\s*auto/, '超出高度的弹层内容必须可滚动');

  // ---- 5. 结构契约：写入型操作的防重复 ----
  const throttleMatrix = [
    ['money', ['money-save', 'account-save']],
    ['habit', ['habit-check-', 'habit-save']],
    /* today 队列统一走 queue-tap- 防重；数值录入弹层是 today-value-save */
    ['today', ['queue-tap-', 'today-value-save']],
    ['plan', ['plan-save', 'plan-toggle-']],
    ['shopping', ['shopping-save', 'shopping-toggle-']],
    ['fitness', ['weight-save', 'deficit-save', 'plan-save', 'plan-toggle-', 'fitness-settings-save']],
    ['memory', ['memory-save']],
    ['media', ['media-save']],
    ['mine', ['budget-save']]
  ];
  for (const [name, keys] of throttleMatrix) {
    const js = read(`miniprogram/pages/${name}/${name}.js`);
    for (const key of keys) {
      assert.match(js, new RegExp(`isRepeatedTap\\(this, '${key.replace(/[-]/g, '\\-')}`), `${name} 的 ${key} 缺少防重复调用`);
    }
  }

  // 计数型打卡允许连点累加，不能被节流误伤
  const habitJs = read('miniprogram/pages/habit/habit.js');
  const countBranch = habitJs.slice(habitJs.indexOf("} else if (mode === 'count') {"), habitJs.indexOf('} else {', habitJs.indexOf("} else if (mode === 'count') {")));
  assert.doesNotMatch(countBranch, /isRepeatedTap/, '计数模式必须允许连续点击累加');

  console.log('UI_INTERACTION_TEST_PASSED');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
