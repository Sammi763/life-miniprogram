/*
 * 习惯补录与目标快照 —— 「同一习惯同一日期只有一条生效记录」与「修改目标后历史兼容」两条口径的回归。
 *
 * 设计要点（详见 miniprogram/utils/habit-utils.js 头注释）：
 * 1. 新 entry 用确定性 ID `e_<habitId>_<yyyymmdd>`，同步层 LWW 天然合并重复补录；
 *    存量随机 ID 记录由「保存前按 habitId+date 查找复用」兼容。
 * 2. entry 写入时快照当时的 mode/target；旧记录无快照按习惯当前目标解读，不追溯改写。
 *
 * 运行：node tests/habit-backfill.test.js
 */
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const habitUtils = require(path.join(root, 'miniprogram', 'utils', 'habit-utils'));
const { validateRecordData, ID_PATTERN } = require(path.join(root, 'server', 'validation'));

const DEF = { id: 'habit-u1', data: { kind: 'def', name: '喝水', mode: 'count', target: 8, unit: '杯' } };

(async () => {
  /* ---------- 1. 确定性 ID：同习惯同日期重复构造写入，永远得到同一条记录 ---------- */
  const records = {};
  const first = habitUtils.entryWrite(records, DEF, '2026-09-29', 3);
  assert.ok(/^e_[0-9a-z]+_[0-9]{8}$/.test(first.id), '新 entry 必须用确定性 ID（e_<指纹>_<日期>）');
  assert.strictEqual(habitUtils.makeEntryId(DEF.id, '2026-09-29'), first.id, 'makeEntryId 必须与 entryWrite 一致');
  assert.strictEqual(first.id, habitUtils.makeEntryId(DEF.id, '2026-09-29'), '同输入两次调用必须得到同一 ID');
  assert.ok(first.id.length <= 64 && ID_PATTERN.test(first.id), 'entry ID 必须满足服务端 ID 规则且 ≤64 字符');
  assert.strictEqual(first.existed, false);
  assert.deepStrictEqual(first.data, { kind: 'entry', habitId: 'habit-u1', date: '2026-09-29', value: 3, mode: 'count', target: 8 }, 'entry 必须快照当时的 mode/target');

  records[first.id] = { id: first.id, data: first.data, updatedAt: 1, deletedAt: 0 };
  const second = habitUtils.entryWrite(records, DEF, '2026-09-29', 5);
  assert.strictEqual(second.id, first.id, '同习惯同日期重复补录必须复用同一条记录');
  assert.strictEqual(second.existed, true);

  /* 存量随机 ID（u 前缀）的旧记录也要被复用，不能另建第二条 */
  const legacy = { id: 'uabc123', data: { kind: 'entry', habitId: 'habit-u1', date: '2026-09-28', value: 2 }, updatedAt: 1, deletedAt: 0 };
  records.legacy = legacy;
  const patched = habitUtils.entryWrite(records, DEF, '2026-09-28', 4);
  assert.strictEqual(patched.id, 'uabc123', '存量随机 ID 记录必须原地复用');

  /* ---------- 1b. 服务端允许的全部 habit ID（1–64 字符）都必须生成合法、稳定、无碰撞的 entry ID ---------- */
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const longIds = [];
  for (let len = 54; len <= 64; len++) {
    longIds.push(Array.from({ length: len }, (_, i) => alphabet[(i * 7 + len) % alphabet.length]).join(''));
  }
  for (const habitId of longIds) {
    const entryId = habitUtils.makeEntryId(habitId, '2026-09-29');
    assert.ok(entryId.length <= 64, '长 habitId 的 entry ID 不得超过 64 字符（实际 ' + entryId.length + '）');
    assert.ok(ID_PATTERN.test(entryId), '长 habitId 的 entry ID 必须满足服务端 ID 规则: ' + habitId);
    assert.strictEqual(habitUtils.makeEntryId(habitId, '2026-09-29'), entryId, '长 habitId 的 entry ID 必须稳定');
  }
  const seenIds = new Set();
  const seenHabitIds = new Set();
  for (let i = 0; i < 500; i++) {
    const len = 1 + (i % 64);
    let habitId = '';
    for (let j = 0; j < len; j++) habitId += alphabet[(i + j * 17) % alphabet.length];
    if (seenHabitIds.has(habitId)) continue; // 生成器去重：只验证「不同 habitId 不碰撞」
    seenHabitIds.add(habitId);
    const id = habitUtils.makeEntryId(habitId, '2026-09-29');
    assert.ok(ID_PATTERN.test(id) && id.length <= 64, '随机 habitId 必须生成合法 entry ID');
    assert.ok(!seenIds.has(id), '不同 habitId 不得碰撞：' + habitId);
    seenIds.add(id);
  }
  // 不同的两个 54+ 字符 habitId 必须得到不同 ID（边界抽查）
  assert.notStrictEqual(habitUtils.makeEntryId(longIds[0], '2026-09-29'), habitUtils.makeEntryId(longIds[1], '2026-09-29'));

  /* 服务端字段白名单接受快照字段、拒绝非法值 */
  assert.strictEqual(validateRecordData('habit', { kind: 'entry', habitId: 'habit-u1', date: '2026-09-29', value: 3, mode: 'count', target: 8 }), '');
  assert.strictEqual(validateRecordData('habit', { kind: 'entry', habitId: 'habit-u1', date: '2026-09-29', value: 3 }), '', '旧格式（无快照）必须继续可同步');
  assert.notStrictEqual(validateRecordData('habit', { kind: 'entry', habitId: 'habit-u1', date: '2026-09-29', value: 3, mode: 'weekly' }), '', '非法 mode 必须被拒');
  assert.notStrictEqual(validateRecordData('habit', { kind: 'entry', habitId: 'habit-u1', date: '2026-09-29', value: 3, target: 'eight' }), '', '非数字 target 必须被拒');

  /* ---------- 2. 完成判定：快照优先，缺省回退当前目标 ---------- */
  const entryOldTarget = { data: { kind: 'entry', habitId: 'habit-u1', date: '2026-09-01', value: 5, mode: 'count', target: 5 } };
  const defRaised = { id: 'habit-u1', data: { kind: 'def', name: '喝水', mode: 'count', target: 10, unit: '杯' } };
  assert.strictEqual(habitUtils.isEntryDone(entryOldTarget, defRaised), true, '有快照的旧记录按写入时的目标判定，改目标不追溯改写历史');

  const entryNoSnapshot = { data: { kind: 'entry', habitId: 'habit-u1', date: '2026-08-01', value: 5 } };
  assert.strictEqual(habitUtils.isEntryDone(entryNoSnapshot, defRaised), false, '无快照的旧记录按当前目标解读');

  const checkDef = { id: 'h2', data: { kind: 'def', name: '阅读', mode: 'check', target: 1 } };
  assert.strictEqual(habitUtils.isEntryDone({ data: { value: 1 } }, checkDef), true);
  assert.strictEqual(habitUtils.isEntryDone({ data: { value: 0 } }, checkDef), false);
  assert.strictEqual(habitUtils.isEntryDone(null, checkDef), false, '没有 entry 视为未完成');

  /* ---------- 3. 12 周历史网格：12×7、周一起始、未来置灰、level 分档 ---------- */
  const records2 = {};
  records2['a'] = { id: 'a', data: { kind: 'entry', habitId: 'habit-u1', date: '2026-09-29', value: 8, mode: 'count', target: 8 }, updatedAt: 1, deletedAt: 0 };
  records2['b'] = { id: 'b', data: { kind: 'entry', habitId: 'habit-u1', date: '2026-09-28', value: 2, mode: 'count', target: 8 }, updatedAt: 2, deletedAt: 0 };
  const history = habitUtils.buildHabitHistory(records2, DEF, '2026-09-29');
  assert.strictEqual(history.grid.length, 12, '默认 12 周');
  assert.ok(history.grid.every((week) => week.length === 7), '每周 7 天');
  const flat = history.grid.flat();
  assert.strictEqual(flat.length, 84);
  assert.strictEqual(flat[flat.length - 1].date, '2026-10-04', '末格是今天所在周的周日（2026-09-29 为周二）');
  const monday = flat.find((cell) => cell.date === history.start);
  assert.ok(monday, 'start 必须出现在网格中');
  assert.strictEqual(new Date(history.start + 'T00:00:00').getDay(), 1, '网格从周一开始');
  const doneCell = flat.find((cell) => cell.date === '2026-09-29');
  assert.strictEqual(doneCell.level, 3, '达标日记 level 3');
  const partial = flat.find((cell) => cell.date === '2026-09-28');
  assert.strictEqual(partial.level, 1, '有进度未达标记 level 1');
  assert.ok(flat.filter((cell) => cell.future).length > 0 && flat.filter((cell) => cell.future).every((cell) => cell.level === 0), '未来日期必须置灰且无值');
  assert.ok(flat.every((cell) => cell.date <= '2026-09-29' || cell.future), '不允许出现超过本周日的日期');
  /* 边界：12 周前的日期不得出现在网格里 */
  const earliest = flat[0].date;
  assert.ok(history.start === earliest, 'start 与首格一致');
  const beforeWindow = new Date(history.start + 'T00:00:00');
  beforeWindow.setDate(beforeWindow.getDate() - 1);
  assert.ok(!flat.some((cell) => cell.date === habitUtils.fmtDate(beforeWindow)), '窗口外日期不得出现');

  /* ---------- 4. sync.upsert 显式 updatedAt（导入恢复的前置能力） ---------- */
  const mem = {};
  global.wx = {
    getStorageSync: (k) => (k in mem ? mem[k] : ''),
    setStorageSync: (k, v) => { mem[k] = v; },
    removeStorageSync: (k) => { delete mem[k]; },
    onNetworkStatusChange() {},
    connectSocket: () => ({ onOpen() {}, onMessage() {}, onClose() {}, onError() {}, close() {}, send() {} })
  };
  const store = require(path.join(root, 'miniprogram', 'utils', 'store'));
  const sync = require(path.join(root, 'miniprogram', 'utils', 'sync'));
  const api = require(path.join(root, 'miniprogram', 'utils', 'api'));
  // 桩掉 HTTP：本测试只验证本地写入路径，flush 成功后事件循环才能自然退出
  api.apiPut = () => Promise.resolve({ applied: true });
  store.loadLocal();
  const rid = sync.upsert('habit', { kind: 'entry', habitId: 'habit-u1', date: '2026-09-01', value: 1 }, 'e_habit-u1_20260901', { updatedAt: 12345 });
  assert.strictEqual(rid, 'e_habit-u1_20260901');
  assert.strictEqual(store.state.records.habit[rid].updatedAt, 12345, 'options.updatedAt 必须生效');
  const rid2 = sync.upsert('habit', { kind: 'entry', habitId: 'habit-u1', date: '2026-09-02', value: 1 });
  assert.strictEqual(store.state.records.habit[rid2].updatedAt > 12345, true, '不传 options 时仍取当前时钟');

  /* ---------- 5. 页面级：补录弹层切日期必须重读该日记录；保存受 12 周窗口终检 ---------- */
  function loadPage() {
    const absolutePath = path.join(root, 'miniprogram/pages/habit/habit.js');
    const originalPage = global.Page;
    let definition = null;
    global.Page = (page) => { definition = page; };
    delete require.cache[require.resolve(absolutePath)];
    require(absolutePath);
    global.Page = originalPage;
    return definition;
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function assignPath(target, key, value) {
    const parts = key.split('.');
    let current = target;
    for (const part of parts.slice(0, -1)) {
      if (!current[part] || typeof current[part] !== 'object') current[part] = {};
      current = current[part];
    }
    current[parts[parts.length - 1]] = value;
  }
  function makePage(definition) {
    return {
      ...definition,
      data: clone(definition.data),
      setData(update) { Object.keys(update).forEach((key) => assignPath(this.data, key, update[key])); }
    };
  }
  const memStore = {};
  const toasts = [];
  global.wx = {
    getStorageSync: (k) => (k in memStore ? memStore[k] : ''),
    setStorageSync: (k, v) => { memStore[k] = v; },
    removeStorageSync: (k) => { delete memStore[k]; },
    onNetworkStatusChange() {},
    connectSocket: () => ({ onOpen() {}, onMessage() {}, onClose() {}, onError() {}, close() {}, send() {} }),
    showToast: (options) => toasts.push(options.title),
    vibrateShort: () => {},
    showActionSheet: () => {},
    setNavigationBarColor: () => {},
    setBackgroundColor: () => {}
  };
  const store2 = require(path.join(root, 'miniprogram', 'utils', 'store'));
  const sync2 = require(path.join(root, 'miniprogram', 'utils', 'sync'));
  const api2 = require(path.join(root, 'miniprogram', 'utils', 'api'));
  api2.apiPut = () => Promise.resolve({ applied: true });
  store2.loadLocal();
  for (const coll of store2.COLLECTIONS) store2.state.records[coll] = {};
  const today5 = sync2.fmtDate(new Date());
  const yesterday2 = new Date(); yesterday2.setDate(yesterday2.getDate() - 1);
  const yText = sync2.fmtDate(yesterday2);
  store2.applyLocalUpsert('habit', { id: 'defH', data: { kind: 'def', name: '喝水', mode: 'count', target: 8, unit: '杯' }, updatedAt: 1, deletedAt: 0 });
  store2.applyLocalUpsert('habit', { id: 'e_a_5cup', data: { kind: 'entry', habitId: 'defH', date: today5, value: 5, mode: 'count', target: 8 }, updatedAt: 2, deletedAt: 0 });
  store2.applyLocalUpsert('habit', { id: 'e_b_2cup', data: { kind: 'entry', habitId: 'defH', date: yText, value: 2, mode: 'count', target: 8 }, updatedAt: 3, deletedAt: 0 });

  const page = makePage(loadPage());
  page.render.call(page);
  page.openBackfill.call(page, { currentTarget: { dataset: { id: 'defH', date: today5 } } });
  assert.strictEqual(page.data.backfillForm.value, '5', '打开 5 杯日必须预填 5');
  assert.strictEqual(page.data.backfillForm.hadEntry, true);
  // 切到 2 杯日：数值、hadEntry 必须跟着重读，保存不得把 2 误写成 5
  page.onBackfillDate.call(page, { detail: { value: yText } });
  assert.strictEqual(page.data.backfillForm.date, yText);
  assert.strictEqual(page.data.backfillForm.value, '2', '切日期后必须重读该日数值');
  assert.strictEqual(page.data.backfillForm.hadEntry, true, '切日期后删除入口状态必须跟随该日');
  const upserts = [];
  const originalUpsert = sync2.upsert;
  sync2.upsert = (...args) => { upserts.push(args); return args[2]; };
  page.saveBackfill.call(page);
  sync2.upsert = originalUpsert;
  assert.strictEqual(upserts.length, 1, '保存必须恰好写一次');
  assert.strictEqual(upserts[0][1].value, 2, '保存必须用切日期后重读的值 2，不得沿用 5');
  assert.strictEqual(upserts[0][2], 'e_b_2cup', '必须复用 2 杯日的既有记录 ID');
  // 窗口终检：把表单日期篡改为 13 周前再保存必须被拒
  const stale = new Date(); stale.setDate(stale.getDate() - 91);
  toasts.length = 0;
  page.data.backfillForm.date = sync2.fmtDate(stale);
  upserts.length = 0;
  const originalUpsert2 = sync2.upsert;
  sync2.upsert = (...args) => { upserts.push(args); return args[2]; };
  page.saveBackfill.call(page);
  sync2.upsert = originalUpsert2;
  assert.strictEqual(upserts.length, 0, '窗口外的保存不得写入');
  assert.ok(toasts.some((title) => /12 周/.test(String(title))), '必须提示只能补录近 12 周');

  console.log('HABIT_BACKFILL_TEST_PASSED');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
