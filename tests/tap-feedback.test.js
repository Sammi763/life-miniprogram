/*
 * 按压反馈覆盖护栏 —— 来自 2026-09-24 用户反馈「我点击有点不跟手」「页面反应迟钝」的实测结论。
 *
 * 先量后判（iPhone 12/13 模拟器 + 开发者工具 automation）：
 *   - 页面自己的 onShow 只占 6ms，setData 往返 5~10ms，本地快照 8.7KB / 落盘 1ms；
 *   - 但 switchTab 从发起到 complete 是 222ms，其中我们自己的代码只占约 16ms。
 *   → 结论：「迟钝」不在业务逻辑，而在「点下去有没有立刻看见反应」。
 *
 * 覆盖面的实测缺口：
 *   - 157 个可点元素里 106 个没有 hover-class（微信 view 的默认值是 hover-class="none"）；
 *   - text 组件只支持 selectable / user-select / space / decode，**完全不支持 hover-class**；
 *   - button 的默认 button-hover 会被我们自己的渐变背景盖住，等于没有反馈；
 *   - 微信 hover-stay-time 默认 400ms，叠加 140~150ms 过渡后，一次瞬时点击的按压态
 *     会持续约 550ms，视觉明显落后于手指。
 *
 * 因此固化四条规则：
 *   1. 除「事件吞噬层 catchtap="noop"」「遮罩 .mask」「text」外，所有可点元素必须有 hover-class；
 *   2. 有 hover-class 就必须显式声明 hover-start-time 与 hover-stay-time（且松手延迟 ≤ 150ms）；
 *   3. 按压过渡时长不得超过 100ms（超过就明显落后于手指）；
 *   4. 剩余无反馈的 text 元素只允许白名单里的这些，新增一个就失败。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
function read(relative) { return fs.readFileSync(path.join(root, relative), 'utf8'); }

function walkWxml(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walkWxml(full, out);
    else if (name.endsWith('.wxml')) out.push(full);
  }
  return out;
}

const wxmlFiles = walkWxml(path.join(root, 'miniprogram'), []).sort();

/* ---------- 1. 扫描所有可点元素 ---------- */

const missingHoverClass = [];
const missingTiming = [];
const overlongStay = [];
const tappableText = [];

for (const file of wxmlFiles) {
  const relative = path.relative(root, file);
  /* 断言里的路径以 miniprogram/ 为根，读起来更短 */
  const label = path.relative(path.join(root, 'miniprogram'), file);
  const tags = read(relative).match(/<[a-zA-Z-]+(?:\s[^<>]*?)?\/?>/g) || [];
  for (const tag of tags) {
    if (!/(bindtap|catchtap)\s*=/.test(tag)) continue;
    // 事件吞噬层与遮罩不是「按钮」：给它们加反馈会让整个弹层或整屏闪一下
    if (/catchtap\s*=\s*"noop"/.test(tag)) continue;
    if (/class\s*=\s*"[^"]*\bmask\b/.test(tag)) continue;

    const name = (tag.match(/^<([a-zA-Z-]+)/) || [])[1];
    if (name === 'text') {
      const binding = tag.match(/(bindtap|catchtap)\s*=\s*"([A-Za-z0-9_]+)"/);
      tappableText.push(label + ':' + (binding ? binding[1] + '=' + binding[2] : 'unknown'));
      continue;
    }

    if (!/hover-class\s*=/.test(tag)) { missingHoverClass.push(label + ' ' + tag.slice(0, 80)); continue; }
    if (!/hover-start-time\s*=/.test(tag) || !/hover-stay-time\s*=/.test(tag)) {
      missingTiming.push(label + ' ' + tag.slice(0, 80));
      continue;
    }
    const stay = Number((tag.match(/hover-stay-time\s*=\s*"(\d+)"/) || [])[1]);
    if (Number.isFinite(stay) && stay > 150) overlongStay.push(label + ' hover-stay-time=' + stay);
  }
}

assert.ok(wxmlFiles.length > 10, '应扫描到全部页面模板，实际 ' + wxmlFiles.length + ' 个');
assert.deepStrictEqual(missingHoverClass, [], '以下可点元素缺少 hover-class（点击不会有任何反馈）：\n  ' + missingHoverClass.join('\n  '));
assert.deepStrictEqual(missingTiming, [], '以下元素有 hover-class 但未声明按压时长，会退回微信默认的松手延迟 400ms：\n  ' + missingTiming.join('\n  '));
assert.deepStrictEqual(overlongStay, [], 'hover-stay-time 不得超过 150ms（松手后按压态挂太久就是「不跟手」）：\n  ' + overlongStay.join('\n  '));

/* ---------- 2. 剩余 text 白名单：它们要么落在 `> text:nth-child` 类型选择器下，
              要么处在行内文本流里，换标签会直接改坏布局，故有意保留 ---------- */

const ALLOWED_TAP_TEXT = [
  'pages/login/login.wxml:catchtap=openLegal',           // 《用户服务协议》行内文本
  'pages/login/login.wxml:catchtap=openLegal',           // 《隐私政策》行内文本
  'pages/memory/memory.wxml:bindtap=addTag'              // .recent-tags 是 nowrap 行内流
];

assert.deepStrictEqual(
  tappableText.slice().sort(),
  ALLOWED_TAP_TEXT.slice().sort(),
  '可点 text 元素集合发生了变化。text 不支持 hover-class，新增/改动请先确认父容器是 flex '
  + '且其下没有 `> text` / `text:nth-child` 类型选择器，再换成 view 并更新本白名单。'
);

/* ---------- 3. 按压缩短：过渡不得超过 100ms ---------- */

const appWxss = read('miniprogram/app.wxss');
const tabbarWxss = read('miniprogram/custom-tab-bar/index.wxss');

function block(source, selector) {
  const start = source.indexOf(selector + ' {');
  assert.ok(start >= 0, '未找到样式规则 ' + selector);
  const end = source.indexOf('}', start);
  assert.ok(end > start, selector + ' 规则块未闭合');
  return source.slice(start, end);
}

function maxTransitionMs(selector, source) {
  const text = block(source, selector);
  const declaration = (text.match(/transition\s*:[^;}]*/) || [])[0] || '';
  const values = (declaration.match(/([\d.]+)ms/g) || []).map((v) => parseFloat(v));
  return values.reduce((max, v) => Math.max(max, v), 0);
}

const PRESS_SELECTORS = [
  ['.record-card', appWxss],
  ['.tap-row', appWxss],
  ['.fab', appWxss],
  ['.btn', appWxss],
  ['.tab-item', tabbarWxss]
];
for (const [selector, source] of PRESS_SELECTORS) {
  const ms = maxTransitionMs(selector, source);
  assert.ok(ms > 0, selector + ' 应有按压过渡');
  assert.ok(ms <= 100, selector + ' 的按压过渡为 ' + ms + 'ms，超过 100ms 会明显落后于手指');
}

/* 反馈类本身必须是「一眼可见」的变化，不能是几乎看不出的微调 */
assert.ok(/\.tap-pressed\s*\{[^}]*opacity/.test(appWxss), '.tap-pressed 应通过 opacity 产生明显反馈');
assert.ok(/\.tab-item-pressed\s*\{[^}]*transform/.test(tabbarWxss), '.tab-item-pressed 应有缩放反馈');

/* ---------- 4. 6000100「unbind download url」：数据预拉取必须关闭 ----------
 * 该项目全仓没有任何预拉取 API 调用（无 preloadRule、无 getBackgroundFetchData），
 * 而开发者工具在 preloadBackgroundData=true 时每次编译都会弹 6000100 模态框，
 * 模态框会盖住模拟器、直接吞掉点击。该开关写在 .gitignore 的个人配置里，可能不存在于 CI。 */

const privateConfigPath = path.join(root, 'project.private.config.json');
if (fs.existsSync(privateConfigPath)) {
  const config = JSON.parse(fs.readFileSync(privateConfigPath, 'utf8'));
  const preload = config.setting && config.setting.preloadBackgroundData;
  assert.notStrictEqual(preload, true, 'project.private.config.json 的 preloadBackgroundData 必须为 false，否则编译时弹 6000100 并挡住模拟器点击');
}

const appJson = read('miniprogram/app.json');
assert.ok(!/"preloadRule"/.test(appJson), 'app.json 不得引入 preloadRule —— 本项目没有预拉取下载地址，开了就会报 6000100');

console.log('tap-feedback.test.js  OK（可点元素按压反馈全覆盖 / 按压时长收口 / 过渡 ≤100ms / 数据预拉取已关闭）');
