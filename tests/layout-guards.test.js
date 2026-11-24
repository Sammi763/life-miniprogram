/*
 * 布局回归护栏 —— 来自 2026-09-24 微信开发者工具真机走查（iPhone 12/13 模拟器）实测发现的三处缺陷。
 * 三处均为「存量问题」（HEAD 里就存在），此处固化为断言，防止再次漂移。
 *
 * 实测证据（windowHeight=753、safeArea-inset-bottom=34px）：
 *   1. .tabbar-shell 实测 top=653 / height=100 → 悬浮导航占底部 100px；
 *      旧 .tabbar-spacer 写死 190rpx≈98px，末卡片被压 2.3px。
 *   2. .habit-btn=[315,361]×[68,103]，.habit-edit=[327,363]×[58,82] → 重叠 34×14px。
 *   3. .trend-day 绑定含半角空格且宽度 54rpx → 实测渲染高 32px（两行「23 / 日」）。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
function read(relative) { return fs.readFileSync(path.join(root, relative), 'utf8'); }

/* 取某个选择器规则块的内容 */
function block(source, selector) {
  const index = source.indexOf(selector + ' {');
  assert.ok(index >= 0, '未找到样式规则 ' + selector);
  const end = source.indexOf('}', index);
  assert.ok(end > index, selector + ' 规则块未闭合');
  return source.slice(index, end);
}

/* ---------- 1. 悬浮导航留白必须 ≥ 导航条自身高度（含安全区） ---------- */

const appWxss = read('miniprogram/app.wxss');
const tabbarWxss = read('miniprogram/custom-tab-bar/index.wxss');

const spacerBlock = block(appWxss, '.tabbar-spacer');
const shellBlock = block(tabbarWxss, '.tabbar-shell');
const tabbarBlock = block(tabbarWxss, '.tabbar');

const spacerRpx = Number((spacerBlock.match(/(\d+)rpx/) || [])[1]);
const tabbarHeightRpx = Number((tabbarBlock.match(/height:\s*(\d+)rpx/) || [])[1]);
const shellPaddingRpx = Number((shellBlock.match(/calc\((\d+)rpx/) || [])[1]);

assert.ok(Number.isFinite(spacerRpx), '.tabbar-spacer 高度应使用 rpx');
assert.ok(Number.isFinite(tabbarHeightRpx), '.tabbar 应有 rpx 高度');
assert.ok(Number.isFinite(shellPaddingRpx), '.tabbar-shell 下边距应使用 calc(Nrpx + env(...))');

/* 核心不变式：留白 rpx ≥ 胶囊高度 + 下边距 + 16rpx 呼吸位。
   注意旧值 190rpx 其实 ≥ 128rpx，单看这条仍然通过；
   真正把旧实现挡住的是紧随其后的「必须计入底部安全区」断言。 */
const MIN_GAP_RPX = 16;
assert.ok(
  spacerRpx >= tabbarHeightRpx + shellPaddingRpx + MIN_GAP_RPX,
  `底部留白 ${spacerRpx}rpx 必须 ≥ 悬浮导航 ${tabbarHeightRpx}rpx + ${shellPaddingRpx}rpx + ${MIN_GAP_RPX}rpx 呼吸位`
);

/* 两侧都必须感知底部安全区，否则非刘海/刘海机型必有一端错位 */
assert.ok(/env\(safe-area-inset-bottom\)/.test(spacerBlock), '.tabbar-spacer 必须计入底部安全区');
assert.ok(/env\(safe-area-inset-bottom\)/.test(shellBlock), '.tabbar-shell 必须计入底部安全区');

/* 四个 Tab 页都必须保留留白占位 */
['today', 'money', 'habit', 'mine'].forEach((page) => {
  const wxml = read(`miniprogram/pages/${page}/${page}.wxml`);
  assert.ok(wxml.includes('tabbar-spacer'), `${page} 页缺少 .tabbar-spacer 底部留白`);
});

/* ---------- 2. 习惯卡片「管理」不得与打卡按钮重叠 ---------- */

const habitWxss = read('miniprogram/pages/habit/habit.wxss');
const habitWxml = read('miniprogram/pages/habit/habit.wxml');

const habitCardBlock = block(habitWxss, '.habit-card');
const habitEditBlock = block(habitWxss, '.habit-edit');

assert.ok(
  /display:\s*flex/.test(habitCardBlock) && /flex-direction:\s*column/.test(habitCardBlock),
  '.habit-card 应为纵向 flex，让「管理」按 WXML 顺序自然排在打卡按钮之外'
);
assert.ok(
  !/position:\s*absolute/.test(habitEditBlock),
  '.habit-edit 不得绝对定位到右上角，否则与右侧打卡胶囊重叠并吞掉打卡点击'
);
assert.ok(
  /align-self:\s*flex-end/.test(habitEditBlock),
  '.habit-edit 应靠右对齐'
);

/* DOM 顺序不变式：「管理」必须排在进度条之后，纵向 flex 才会把它放到打卡按钮下方 */
const barIndex = habitWxml.indexOf('class="habit-bar"');
const editIndex = habitWxml.indexOf('class="habit-edit');
assert.ok(editIndex > 0, 'habit-card 内应有「管理」入口');
assert.ok(barIndex > 0 && editIndex > barIndex, '「管理」应排在进度条之后（卡片最后一段内容）');

/* 「管理」用 catchtap 吞事件，必须保证它不覆盖打卡热区（此断言即上一条的动机） */
assert.ok(/catchtap="editHabit"/.test(habitWxml), '「管理」应使用 catchtap 避免触发打卡');

/* ---------- 3. 月度报告趋势日期必须单行 ---------- */

const reportWxml = read('miniprogram/pages/report/report.wxml');
const reportWxss = read('miniprogram/pages/report/report.wxss');

assert.ok(
  reportWxml.includes('class="trend-day">{{item.day}}日<'),
  '.trend-day 绑定不得在数字与「日」之间留半角空格（会成为换行点）'
);
assert.ok(
  /white-space:\s*nowrap/.test(block(reportWxss, '.trend-day')),
  '.trend-day 必须声明 white-space: nowrap，避免被挤成两行'
);

/* ---------- 4. 弹层不得被悬浮导航/悬浮按钮压住（否则「保存」按钮点不到） ---------- */

/*
 * 实测（iPhone 12/13 模拟器，真机走查 + 截图取证）：
 *   · 「记一笔」的「保存」按钮落在 [655,699]，tabbar 是 [653,753] —— 按钮 100% 被盖住，
 *     用户能打开弹层、能输入，却看不到也点不到保存。
 *   · 曾被误判为「抬高 z-index 即可」。实测把 .sheet 提到 z-index:200、.mask 提到 199，
 *     页面内的 .fab(101) 被正确遮住了，但截图里 .tabbar-shell(100) 依然画在弹层之上 ——
 *     自定义 tabBar 与页面内容不在同一层叠上下文，页面内任何 z-index 都盖不住它。
 *   · 因此正确做法是：.mask/.sheet 抬到 100+ 只用于盖住页面内的 .fab，
 *     悬浮导航改为「弹层打开期间整体隐藏」。
 */
function zIndexOf(source, selector) {
  const match = block(source, selector).match(/z-index:\s*(\d+)/);
  assert.ok(match, selector + ' 应有 z-index');
  return Number(match[1]);
}

const sheetZ = zIndexOf(appWxss, '.sheet');
const maskZ = zIndexOf(appWxss, '.mask');
const habitFabZ = zIndexOf(read('miniprogram/pages/habit/habit.wxss'), '.fab');

assert.ok(sheetZ > habitFabZ, `.sheet(${sheetZ}) 必须在 .fab(${habitFabZ}) 之上`);
assert.ok(maskZ > habitFabZ, `.mask(${maskZ}) 必须盖住 .fab`);
assert.ok(maskZ < sheetZ, `.mask(${maskZ}) 必须在 .sheet(${sheetZ}) 之下，不能盖住弹层本身`);

/* 悬浮导航：必须有隐藏态，且隐藏后不能再接收点击 */
const tabbarWxml = read('miniprogram/custom-tab-bar/index.wxml');
const tabbarJs = read('miniprogram/custom-tab-bar/index.js');
assert.ok(/\bhidden\b/.test(tabbarJs), '悬浮导航组件必须有 hidden 状态');
assert.ok(/tabbar-hidden/.test(tabbarWxml), '悬浮导航 WXML 必须按 hidden 切换 tabbar-hidden 类');
assert.ok(
  /\.tabbar-shell\.tabbar-hidden\s*\{[^}]*opacity:\s*0/s.test(tabbarWxss),
  '.tabbar-hidden 必须把导航透明化'
);
assert.ok(
  /\.tabbar-shell\.tabbar-hidden\s+\.tabbar\s*\{[^}]*pointer-events:\s*none/s.test(tabbarWxss),
  '导航隐藏后必须关掉 .tabbar 的 pointer-events，否则透明区域仍能被点到'
);

/* 带弹层的 Tab 页必须接入「弹层开关 → 导航显隐」的驱动（mine 的数据管理弹层是 2026-09-24 新增） */
['money', 'habit', 'mine'].forEach((page) => {
  const source = read(`miniprogram/pages/${page}/${page}.js`);
  assert.ok(
    /attachOverlayWatcher\(this\)/.test(source),
    `${page} 页必须在 onLoad 里接入 attachOverlayWatcher，否则弹层打开时导航不会隐藏`
  );
});

/* 驱动逻辑本身：必须按「data 里含 Sheet 的布尔字段」判断，且能自愈 */
const tabbarHelper = read('miniprogram/utils/tabbar.js');
assert.ok(/[Ss]heet/.test(tabbarHelper), '导航显隐必须依据页面 data 里含 Sheet 的字段判断');
assert.ok(/getTabBar\(\)/.test(tabbarHelper), '必须通过页面 getTabBar() 拿到导航组件');
assert.ok(
  /function attachOverlayWatcher/.test(tabbarHelper) && /page\.setData\s*=/.test(tabbarHelper),
  '必须包装 setData 覆盖所有弹层开关路径，而不是逐个开关手动通知'
);

console.log('layout-guards.test.js  OK（悬浮导航留白 / 习惯卡片重叠 / 报告日期换行 / 弹层遮挡与导航隐藏 四处护栏）');
