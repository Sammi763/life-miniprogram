/*
 * 账本 CSV 导出 —— 表头、BOM、排序、转义与墓碑排除。
 * 运行：node tests/money-csv.test.js
 */
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { buildMoneyCsv, escapeField, CSV_HEADERS } = require(path.join(root, 'miniprogram', 'utils', 'money-csv'));

(async () => {
  const records = {
    m3: { id: 'm3', data: { type: 'expense', amount: 7.5, category: '餐饮', date: '2026-09-03', note: '' }, updatedAt: 3, deletedAt: 0 },
    m1: { id: 'm1', data: { type: 'income', amount: 8500, category: '工资', date: '2026-09-01', note: '9月工资' }, updatedAt: 1, deletedAt: 0 },
    m2: { id: 'm2', data: { type: 'expense', amount: 12, category: '餐饮', date: '2026-09-01', note: '含,逗号和"引号"' }, updatedAt: 2, deletedAt: 0 },
    m4: { id: 'm4', data: { type: 'transfer', amount: 500, category: '账户转账', date: '2026-09-04', note: '余额→银行卡' }, updatedAt: 4, deletedAt: 0 },
    gone: { id: 'gone', data: { type: 'expense', amount: 999, category: '餐饮', date: '2026-09-05' }, updatedAt: 5, deletedAt: 500 }
  };

  const csv = buildMoneyCsv(records);
  assert.ok(csv.startsWith('\uFEFF'), '必须带 UTF-8 BOM，Excel 打开中文不乱码');
  const lines = csv.slice(1).split('\n');
  assert.strictEqual(lines[0], CSV_HEADERS.join(','), '首行必须是中文表头');
  assert.strictEqual(lines[0], '日期,类型,分类,金额,备注');
  assert.strictEqual(lines.length, 5, '墓碑不导出，共 4 行数据');
  assert.strictEqual(lines[1], '2026-09-01,收入,工资,8500,9月工资', '按日期升序');
  assert.strictEqual(lines[2], '2026-09-01,支出,餐饮,12,"含,逗号和""引号"""', 'RFC4180 转义');
  assert.strictEqual(lines[4], '2026-09-04,转账,账户转账,500,余额→银行卡', '转账行保留且分类固定');

  assert.strictEqual(escapeField('plain'), 'plain');
  assert.strictEqual(escapeField('a,b'), '"a,b"');
  assert.strictEqual(escapeField('say "hi"'), '"say ""hi"""');
  assert.strictEqual(escapeField('line\nbreak'), '"line\nbreak"');

  // 空账本：只有表头
  assert.strictEqual(buildMoneyCsv({}), '\uFEFF' + CSV_HEADERS.join(','));

  console.log('MONEY_CSV_TEST_PASSED');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
