/*
 * 金额显示一致性护栏 —— 来自 2026-09-24 真机走查：同一屏同时出现
 *   ¥89 / ¥54.5（记账页直接绑定原始数字）
 *   ¥143.50（待买页写死 toFixed(2)）
 *   ¥8356.50（月报「整数原样、否则两位」）
 * 三种写法。这里把「只允许一处实现」固化成断言，防止再分叉。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
function read(relative) { return fs.readFileSync(path.join(root, relative), 'utf8'); }

const { toCents, parseMoneyInput, moneyInputText, amountError } = require('../miniprogram/utils/amount');
const { roundMoney, formatMoney } = require('../miniprogram/utils/finance');

/* ---------- 1. 约定本身：整数不带小数；有小数最多两位且去掉末尾 0 ---------- */
assert.strictEqual(formatMoney(89), '89');
assert.strictEqual(formatMoney(143.5), '143.5');
assert.strictEqual(formatMoney(54.5), '54.5');
assert.strictEqual(formatMoney(143.50), '143.5');
assert.strictEqual(formatMoney(0), '0');
assert.strictEqual(formatMoney('12.30'), '12.3');
assert.strictEqual(formatMoney(0.05), '0.05');
assert.strictEqual(formatMoney(100), '100');
assert.strictEqual(formatMoney(undefined), '0');
assert.strictEqual(formatMoney(NaN), '0');
/* 浮点误差必须在取整到分时被消掉，否则会显示 0.30000000000000004 */
assert.strictEqual(formatMoney(0.1 + 0.2), '0.3');
assert.strictEqual(roundMoney(0.1 + 0.2), 0.3);
/* 十进制半分远离零取整，避开浮点乘法在 1.005 上的误差。 */
assert.strictEqual(formatMoney(1.005), '1.01');
assert.strictEqual(formatMoney(-1.005), '-1.01');
assert.strictEqual(toCents('000.005'), 1);
assert.strictEqual(toCents(1e-7), 0);
assert.strictEqual(toCents(1000000000), 100000000000);
assert.ok(Number.isNaN(toCents('0x10')));
assert.ok(Number.isNaN(toCents('1e1')));
assert.ok(Number.isNaN(parseMoneyInput('-0.004')));
assert.strictEqual(moneyInputText('1.005'), '1.01');
assert.strictEqual(moneyInputText('-1.005', true), '-1.01');
assert.strictEqual(moneyInputText('0.004'), '0.00');
assert.strictEqual(moneyInputText('0.004', false, true), '0.004');
assert.strictEqual(amountError('0.004', parseMoneyInput('0.004')), '金额不足 0.01 元');

/* ---------- 2. 只允许一处金额格式化实现 ---------- */
const utilsDir = path.join(root, 'miniprogram/utils');
const pagesDir = path.join(root, 'miniprogram/pages');
const offenders = [];
function scan(dir, base) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { scan(full, base); continue; }
    if (!/\.js$/.test(name)) continue;
    const relative = path.relative(base, full);
    if (relative === 'utils/finance.js') continue; // 唯一实现所在，注释里允许提到 toFixed(2)
    fs.readFileSync(full, 'utf8').split('\n').forEach((line, index) => {
      if (line.trim().startsWith('*') || line.trim().startsWith('//')) return; // 注释不算
      if (/\.toFixed\(\s*2\s*\)/.test(line)) offenders.push(relative + ':' + (index + 1));
    });
  }
}
scan(utilsDir, path.join(root, 'miniprogram'));
scan(pagesDir, path.join(root, 'miniprogram'));
assert.deepStrictEqual(
  offenders, [],
  '金额格式化只能走 finance.formatMoney，不要再写 toFixed(2)：\n  ' + offenders.join('\n  ')
);

/* ---------- 3. 三处历史分叉必须都已改为共用实现 ---------- */
const financeSource = read('miniprogram/utils/finance.js');
assert.ok(/function formatMoney/.test(financeSource), 'finance.js 必须实现 formatMoney');
const exportBlock = financeSource.slice(financeSource.indexOf('module.exports'));
assert.ok(/\bformatMoney\b/.test(exportBlock), 'finance.js 必须在 module.exports 里导出 formatMoney');
assert.ok(/\broundMoney\b/.test(exportBlock), 'finance.js 必须在 module.exports 里导出 roundMoney');

const reportUtils = read('miniprogram/utils/report-utils.js');
assert.ok(/require\('\.\/finance'\)/.test(reportUtils), '月报必须复用 finance.formatMoney');
assert.ok(!/function formatMoney/.test(reportUtils), '月报不得再自带一份 formatMoney');

const shopping = read('miniprogram/pages/shopping/shopping.js');
assert.ok(/require\('\.\.\/\.\.\/utils\/finance'\)/.test(shopping), '待买页必须复用 finance.formatMoney');
assert.ok(/formatMoney\(record\.data\.price\)/.test(shopping), '待买页价格必须走 formatMoney');

const money = read('miniprogram/pages/money/money.js');
assert.ok(!/function formatBalance/.test(money), '记账页不应再保留自定义 formatBalance');
assert.ok(!/^function roundMoney/m.test(money), '记账页不应再自带 roundMoney，应复用 finance 的实现');
assert.ok(/formatMoney\(account\.balance\)/.test(money), '账户余额必须走 formatMoney');

/* ---------- 4. 百分比也不能一边 0% 一边 0.0% ---------- */
const rateLines = reportUtils.split('\n').filter((line) => /'%/.test(line) && !line.trim().startsWith('*'));
assert.ok(rateLines.length > 0, '月报里应有百分比文案');
rateLines.forEach((line) => {
  assert.ok(!/\.toFixed\(1\)/.test(line), '月报百分比不得用 toFixed(1)，会和页面上直接绑定的 {{rate}}% 不一致：' + line.trim());
});

console.log('money-format.test.js  OK（唯一实现 / 三处分叉已统一 / 浮点取整 / 百分比写法一致）');
