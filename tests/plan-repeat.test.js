/*
 * 日程重复规则扩展 —— workdays（周一至周五）与 monthly（每月固定日期）。
 * 口径：workdays 不含法定节假日调休（应用内文案已注明）；
 * monthly 当月无对应日期（如 31 号遇 30 天月）则该月跳过；停止重复沿用 endDate 截断。
 * 运行：node tests/plan-repeat.test.js
 */
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const planUtils = require(path.join(root, 'miniprogram', 'utils', 'plan-utils'));
const { validateRecordData } = require(path.join(root, 'server', 'validation'));

function series(repeat, extra, startDate) {
  return { id: 's1', data: { kind: 'series', title: '站会', startDate: startDate || '2026-09-01', time: '09:00', repeat, ...(extra || {}) }, updatedAt: 1, deletedAt: 0 };
}

(async () => {
  /* ---------- 1. workdays：只展开周一至周五 ---------- */
  // 2026-09-28 周一 ～ 2026-10-04 周日
  const workdays = planUtils.derivePlanOccurrences([series('workdays')], '2026-09-28', '2026-10-04')
    .map((item) => item.date);
  assert.deepStrictEqual(workdays, ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'], '周末（10-03/10-04）必须跳过');

  /* ---------- 2. monthly：固定日期；当月无该日期则跳过；跨月正确 ---------- */
  const monthly31 = planUtils.derivePlanOccurrences([series('monthly', { repeatDay: 31 }, '2026-01-01')], '2026-01-01', '2026-04-30')
    .map((item) => item.date);
  assert.deepStrictEqual(monthly31, ['2026-01-31', '2026-03-31'], '2 月（无 31 号）必须整月跳过，不钳制到月末');

  const monthly15 = planUtils.derivePlanOccurrences([series('monthly', { repeatDay: 15 }, '2026-08-01')], '2026-08-01', '2026-10-31')
    .map((item) => item.date);
  assert.deepStrictEqual(monthly15, ['2026-08-15', '2026-09-15', '2026-10-15'], '常规跨月展开');

  // repeatDay 缺省回退 startDate 的日期
  const fallbackDay = planUtils.derivePlanOccurrences([series('monthly')], '2026-09-01', '2026-09-30')
    .map((item) => item.date);
  assert.deepStrictEqual(fallbackDay, ['2026-09-01'], 'repeatDay 缺省必须用 startDate 的日期');

  /* ---------- 3. 停止重复与旧规则回归 ---------- */
  const stopped = planUtils.derivePlanOccurrences([series('workdays', { endDate: '2026-09-29' })], '2026-09-28', '2026-10-04')
    .map((item) => item.date);
  assert.deepStrictEqual(stopped, ['2026-09-28', '2026-09-29'], 'endDate 截断对 workdays 生效');
  const daily = planUtils.derivePlanOccurrences([series('daily')], '2026-09-28', '2026-09-30').map((item) => item.date);
  assert.deepStrictEqual(daily, ['2026-09-28', '2026-09-29', '2026-09-30'], 'daily 行为不变');
  const weekly = planUtils.derivePlanOccurrences([series('weekly')], '2026-09-01', '2026-09-30').map((item) => item.date);
  assert.deepStrictEqual(weekly.filter((d) => d.endsWith('-01') || d.endsWith('-08') || d.endsWith('-15')).length >= 2, true, 'weekly 行为不变');

  /* ---------- 4. occurrence 覆盖照常生效 ---------- */
  const records = [
    series('workdays'),
    { id: 'o_s1_20260929', data: { kind: 'occurrence', seriesId: 's1', date: '2026-09-29', done: true, skipped: false }, updatedAt: 9, deletedAt: 0 }
  ];
  const withOverride = planUtils.derivePlanOccurrences(records, '2026-09-28', '2026-09-30');
  const overridden = withOverride.find((item) => item.date === '2026-09-29');
  assert.strictEqual(overridden.done, true, '单日完成覆盖必须生效');

  /* ---------- 5. 服务端白名单：四种 repeat、repeatDay 仅 monthly 必填 ---------- */
  assert.strictEqual(validateRecordData('plan', { kind: 'series', title: 'x', startDate: '2026-09-01', time: '', repeat: 'workdays' }), '');
  assert.strictEqual(validateRecordData('plan', { kind: 'series', title: 'x', startDate: '2026-09-01', time: '', repeat: 'monthly', repeatDay: 31 }), '');
  assert.strictEqual(validateRecordData('plan', { kind: 'series', title: 'x', startDate: '2026-09-01', time: '', repeat: 'daily' }), '', '旧格式继续可同步');
  assert.notStrictEqual(validateRecordData('plan', { kind: 'series', title: 'x', startDate: '2026-09-01', time: '', repeat: 'monthly' }), '', 'monthly 缺 repeatDay 必须被拒');
  assert.notStrictEqual(validateRecordData('plan', { kind: 'series', title: 'x', startDate: '2026-09-01', time: '', repeat: 'monthly', repeatDay: 32 }), '', 'repeatDay 越界必须被拒');
  assert.notStrictEqual(validateRecordData('plan', { kind: 'series', title: 'x', startDate: '2026-09-01', time: '', repeat: 'yearly' }), '', '未支持的 repeat 必须被拒');

  console.log('PLAN_REPEAT_TEST_PASSED');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
