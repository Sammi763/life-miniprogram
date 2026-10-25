/*
 * 「我的 → 数据与隐私」信息架构护栏 —— 来自 2026-09-24 用户提问「这些设置是不是应该收纳隐藏起来？」。
 *
 * 实测（iPhone 12/13 模拟器，windowHeight=753）：
 *   「我的」整页高 2624px（3.5 屏），其中「数据与隐私」单卡 635px = 视口的 84%、整页的 24%，
 *   10 行全部同一视觉权重、没有任何分组。
 *
 * 折叠不是正解 —— 这 10 行里有两件事恰恰不能藏：
 *   1) 「个性化 AI 文案」是全 App 唯一决定「数据出不出本机」的开关，藏进二级页反而抬高隐私风险；
 *   2) 「永久删除账户与数据」与「用户服务协议」同权重相邻，是真实的误触风险，需要的是隔离不是隐藏。
 *
 * 因此固化为：一级三行（AI 开关 / 隐私与合规 / 数据管理）+ 独立「账号」卡（删除 + 退出），
 * 四项低频运维收进弹层。本用例同时钉住「删除与普通设置不得同卡」这条隔离不变量。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
function read(relative) { return fs.readFileSync(path.join(root, relative), 'utf8'); }

const mineWxml = read('miniprogram/pages/mine/mine.wxml');
const mineJs = read('miniprogram/pages/mine/mine.js');

function sliceBetween(source, fromMarker, toMarker) {
  const start = source.indexOf(fromMarker);
  assert.ok(start >= 0, '未找到 ' + fromMarker);
  const end = source.indexOf(toMarker, start);
  assert.ok(end > start, '未找到 ' + toMarker + '（它应出现在 ' + fromMarker + ' 之后）');
  return source.slice(start, end);
}

const settingsBlock = sliceBetween(mineWxml, 'class="card settings-card"', 'class="card account-card"');
const accountBlock = sliceBetween(mineWxml, 'class="card account-card"', 'class="mask"');
const sheetBlock = mineWxml.slice(mineWxml.indexOf('class="mask"'));
assert.ok(sheetBlock.length > 0, '应能定位到数据管理弹层');

/* ---------- 1. 一级行数收口：v2.10 三行 + v2.11 提醒设置（弹层入口，不新增页面） ---------- */

const settingsRowCount = (settingsBlock.match(/class="setting-row/g) || []).length;
assert.strictEqual(settingsRowCount, 4, '「数据与隐私」一级只应有 4 行（AI / 合规 / 数据管理 / 提醒设置），实际 ' + settingsRowCount + ' 行');

assert.ok(/<switch[^>]*bindchange="onAiConsentChange"/.test(settingsBlock), '「个性化 AI 文案」开关必须留在一级（它是唯一决定数据是否离开本机的开关）');
assert.ok(/class="setting-row[^"]*"[^>]*bindtap="goLegal"/.test(settingsBlock), '合规入口必须留在一级');
assert.ok(/class="setting-row[^"]*"[^>]*bindtap="openDataSheet"/.test(settingsBlock), '数据管理入口必须留在一级');
/* v2.11 提醒矩阵：入口是本页弹层（reminderSheetShow），不得新增页面路由 */
assert.ok(/class="setting-row[^"]*"[^>]*bindtap="openReminderSheet"/.test(settingsBlock), '提醒设置入口必须留在一级');
assert.ok(/bindtap="onReminderRenew" data-kind="habit"/.test(mineWxml), '提醒弹层必须提供习惯提醒续订按钮');
assert.ok(/bindtap="onReminderRenew" data-kind="bill"/.test(mineWxml), '提醒弹层必须提供账单提醒续订按钮');
assert.ok(!/navigateTo[^>]*reminder/.test(mineWxml), '提醒设置必须是弹层而不是新页面');

/* 合规三份文档合并成一行：复用 pages/legal/legal 自带的三个 tab，不新增页面。
   因此 mine 页一级不应再出现另外两份法律文档的入口。 */
assert.ok(!/data-doc="service"/.test(mineWxml), '用户服务协议应合并进「隐私与合规」，不在「我的」页一级单独成行');
assert.ok(!/data-doc="sharing"/.test(mineWxml), '第三方处理说明应合并进「隐私与合规」，不在「我的」页一级单独成行');

/* ---------- 2. 隔离不变量：不可逆操作不得与普通设置同卡 ---------- */

assert.ok(/bindtap="deleteAccount"/.test(accountBlock), '「永久删除账户与数据」必须落在独立的「账号」卡里');
assert.ok(/bindtap="logout"/.test(accountBlock), '「退出当前账号」必须落在独立的「账号」卡里');
assert.ok(!/deleteAccount/.test(settingsBlock), '「永久删除账户与数据」不得与普通设置同卡（实测相邻排列有误触风险）');
assert.ok(!/bindtap="logout"/.test(settingsBlock), '「退出当前账号」不得与普通设置同卡');
assert.ok(/class="section-title">账号</.test(accountBlock), '「账号」卡应有自己的标题，让它与数据设置视觉分离');

/* ---------- 3. 四项低频运维收进弹层，一个都不能丢 ---------- */

for (const handler of ['exportFromServer', 'copyBackup', 'rebuildLocalCache', 'clearDemo']) {
  assert.ok(
    new RegExp('bindtap="' + handler + '"').test(sheetBlock),
    handler + ' 必须保留在「数据管理」弹层里'
  );
  assert.ok(!new RegExp('bindtap="' + handler + '"').test(settingsBlock), handler + ' 不应再占用一级行位');
}

/* 弹层结构：遮罩 + 内容层吞掉冒泡，且开关字段名必须含 Sheet
   （utils/tabbar.js 的 attachOverlayWatcher 按 /Sheet/ 识别所有弹层开关） */
assert.ok(/class="mask"[^>]*bindtap="closeDataSheet"/.test(sheetBlock), '弹层必须有可点击关闭的遮罩');
assert.ok(/class="sheet"[^>]*catchtap="noop"/.test(sheetBlock), '弹层内容层必须用 catchtap 吞掉冒泡，否则点内容会关掉弹层');
assert.ok(/dataSheetShow/.test(mineWxml), '弹层开关字段名必须含 Sheet，否则导航显隐不会联动');
assert.ok(/dataSheetShow/.test(mineJs), '弹层开关必须在 mine.js 里定义');

/* ---------- 4. 每个运维动作执行后必须收起弹层 ---------- */

for (const handler of ['exportFromServer', 'copyBackup', 'rebuildLocalCache', 'clearDemo']) {
  assert.ok(
    new RegExp(handler + '\\(\\)\\s*\\{\\s*this\\.closeDataSheet\\(\\);').test(mineJs),
    handler + ' 必须先收起弹层再执行，否则弹层会一直压在 loading/toast 上面'
  );
}
assert.ok(/closeDataSheet\(\)\s*\{\s*if\s*\(this\.data\.dataSheetShow\)/.test(mineJs), 'closeDataSheet 应在已收起时直接返回，避免无谓渲染');

/* ---------- 5. Tab 页加弹层必须接入导航隐藏（否则弹层底部被悬浮导航压住） ---------- */

assert.ok(/attachOverlayWatcher\(this\)/.test(mineJs), 'mine 是 Tab 页，加弹层后必须在 onLoad 接入 attachOverlayWatcher');

console.log('mine-settings.test.js  OK（一级四行含 v2.11 提醒设置弹层 / 合规三份合并 / 删除与退出独立成卡 / 运维进弹层且执行后收起）');
