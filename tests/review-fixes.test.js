/*
 * 审查修复回归（2026-10-28 多代理审查发现的数据可信缺陷）。
 * 锁住：rebuild 对旧服务端按 since=0 拉全量（增量换装会截断本机缓存）、
 *       retryRejectedWrites 与进行中冲刷的竞态（重试项不再被盲目 shift 丢弃）、
 *       pull 的三种游标路径（seq/legacy/迁移哨兵收敛）、fullResync 保护被拒写入、
 *       destroy 中止在途冲刷（退出后不上送已放弃的写入）、money 单日超预算仍可加载更多。
 */
const assert = require('assert');

const storage = {};
const originalWx = global.wx;
global.wx = {
  getStorageSync: (key) => storage[key],
  setStorageSync: (key, value) => { storage[key] = value === undefined ? value : JSON.parse(JSON.stringify(value)); },
  removeStorageSync: (key) => { delete storage[key]; },
  getStorageInfoSync: () => ({ keys: Object.keys(storage) }),
  showToast: () => {},
  vibrateShort: () => {}
};

const store = require('../miniprogram/utils/store');
const sync = require('../miniprogram/utils/sync');
const api = require('../miniprogram/utils/api');

function resetAll() {
  for (const key of Object.keys(storage)) delete storage[key];
  store.resetLocal({ keepAuxiliary: true });
}

async function main() {
  const originalApiSync = api.apiSync;
  const originalApiPut = api.apiPut;
  const originalApiDelete = api.apiDelete;

  /* ---------- 1. rebuild 对旧服务端（无 cursor）必须按 since=0 拉全量 ---------- */
  resetAll();
  store.state.records.money = {
    old1: { id: 'old1', data: { amount: 1, date: '2026-10-27' }, updatedAt: 10, deletedAt: 0 },
    old2: { id: 'old2', data: { amount: 2, date: '2026-10-27' }, updatedAt: 11, deletedAt: 0 }
  };
  store.state.since = 10; // 旧快照游标：旧服务端按 since 过滤时只回 updatedAt > 10 的增量
  let legacyRequest = null;
  api.apiSync = (since, sinceSeq) => {
    legacyRequest = { since, sinceSeq };
    // 旧服务端行为：忽略 sinceSeq，按 since 过滤 —— since=0 时返回全部记录
    const all = [
      { id: 'old1', data: { amount: 1, date: '2026-10-27' }, updatedAt: 10, deletedAt: 0 },
      { id: 'old2', data: { amount: 2, date: '2026-10-27' }, updatedAt: 11, deletedAt: 0 }
    ].filter((record) => record.updatedAt > (Number(since) || 0));
    return Promise.resolve({ serverTime: 1, changes: { money: all } });
  };
  await sync.rebuild();
  assert.deepStrictEqual(legacyRequest, { since: 0, sinceSeq: 0 }, '重建必须请求全量（since=0），不能带旧游标');
  assert.ok(store.state.records.money.old1, '旧服务端下重建不得把增量之外的记录从本机截断（审查 Critical）');
  assert.ok(store.state.records.money.old2, '增量部分正常换装');
  api.apiSync = originalApiSync;

  /* ---------- 2. retryRejectedWrites 与进行中冲刷的竞态 ---------- */
  resetAll();
  const sent = [];
  const resolvers = {};
  api.apiPut = (collection, id) => {
    sent.push(id);
    // 仅 A 挂起模拟网络在途；其余（含重试项 R）立即成功
    if (id === 'A') return new Promise((resolve) => { resolvers[id] = resolve; });
    return Promise.resolve({ applied: true });
  };
  api.apiDelete = () => Promise.resolve({ applied: true });
  store.enqueue({ type: 'put', collection: 'money', id: 'A', data: { amount: 1 }, updatedAt: 1 });
  const firstFlush = sync.flush().catch(() => 'rejected');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepStrictEqual(sent, ['A'], '冲刷从队首 A 开始');
  // 冲刷在途时重试被拒写入 R（unshift 到队首）
  store.recordRejectedWrite({ item: { type: 'put', collection: 'money', id: 'R', data: {} }, statusCode: 422, code: '' });
  store.retryRejectedWrites();
  assert.strictEqual(store.state.queue[0].id, 'R', '重试项插入队首');
  // 放行 A 的响应：按身份移除 A（而不是盲目 shift 掉 R），随后 R 被正常补送
  resolvers.A({ applied: true });
  await firstFlush;
  assert.deepStrictEqual(sent, ['A', 'R'], '重试项 R 必须在 A 完成后被补送（修复前会被 shift 误删）');
  assert.strictEqual(store.state.queue.length, 0, '冲刷结束后队列清空，A 不重复上送');
  api.apiPut = originalApiPut;
  api.apiDelete = originalApiDelete;

  /* ---------- 3. pull 三种游标路径 ---------- */
  resetAll();
  // 3a. seq 模式：cursor 推进 sinceSeq
  store.state.since = 100; store.state.sinceSeq = 5;
  let pullRequest = null;
  api.apiSync = (since, sinceSeq) => { pullRequest = { since, sinceSeq }; return Promise.resolve({ serverTime: 1, cursor: 9, changes: {} }); };
  assert.strictEqual(await sync.pull(), true);
  assert.deepStrictEqual(pullRequest, { since: 100, sinceSeq: 5 });
  assert.strictEqual(store.state.sinceSeq, 9, 'seq 模式推进下载游标');
  // 3b. legacy 模式：响应无 cursor，sinceSeq 保持且不推进；since 由服务端写推进
  store.state.since = 100; store.state.sinceSeq = 5;
  api.apiSync = () => Promise.resolve({ serverTime: 1, changes: { money: [{ id: 'x', data: {}, updatedAt: 150, deletedAt: 0 }] } });
  assert.strictEqual(await sync.pull(), true);
  assert.strictEqual(store.state.sinceSeq, 5, 'legacy 模式不推进 sinceSeq');
  assert.strictEqual(store.state.since, 150, 'legacy 模式 since 由服务端来源写入推进');
  // 3c. 迁移哨兵：请求全量，legacy 成功后哨兵归位 0（不再每次全量）
  store.state.since = 0; store.state.sinceSeq = -1;
  api.apiSync = (since, sinceSeq) => { pullRequest = { since, sinceSeq }; return Promise.resolve({ serverTime: 1, changes: {} }); };
  assert.strictEqual(await sync.pull(), true);
  assert.deepStrictEqual(pullRequest, { since: 0, sinceSeq: 0 }, '哨兵迁移必须请求全量');
  assert.strictEqual(store.state.sinceSeq, 0, 'legacy 成功后哨兵归位（审查修复：否则每次拉取都全量）');
  // 3d. 归位后 legacy 拉取改用已校净的 since
  store.state.since = 77;
  api.apiSync = (since, sinceSeq) => { pullRequest = { since, sinceSeq }; return Promise.resolve({ serverTime: 1, changes: {} }); };
  await sync.pull();
  assert.deepStrictEqual(pullRequest, { since: 77, sinceSeq: 0 }, '哨兵归位后按正常 legacy 增量拉取');
  api.apiSync = originalApiSync;

  /* ---------- 4. fullResync 保护被拒写入（唯一副本不被服务端覆盖） ---------- */
  resetAll();
  store.state.records.money = { q1: { id: 'q1', data: { amount: 5 }, updatedAt: 30, deletedAt: 0 } };
  store.state.rejectedWrites = [{ item: { type: 'put', collection: 'money', id: 'q1', data: { amount: 5 } }, statusCode: 422, code: '', at: 1 }];
  sync.applyChanges({ money: [{ id: 'q1', data: { amount: 999 }, updatedAt: 50, deletedAt: 0 }] }, { fullResync: true });
  assert.strictEqual(store.state.records.money.q1.data.amount, 5, '完整补拉不得覆盖被拒写入的本机值（唯一副本）');
  sync.applyChanges({ money: [{ id: 'q1', data: { amount: 999 }, updatedAt: 50, deletedAt: 0 }] }, {});
  assert.strictEqual(store.state.records.money.q1.data.amount, 999, '普通拉取正常应用服务端值');

  /* ---------- 5. destroy 中止在途冲刷：退出后不上送已放弃的写入 ---------- */
  resetAll();
  const uploadedAfterDestroy = [];
  let releaseFlush;
  api.apiPut = (collection, id) => {
    uploadedAfterDestroy.push(id);
    return new Promise((resolve) => { releaseFlush = () => resolve({ applied: true }); });
  };
  api.apiDelete = () => Promise.resolve({ applied: true });
  store.enqueue({ type: 'put', collection: 'money', id: 'gone1', data: {}, updatedAt: 1 });
  store.enqueue({ type: 'put', collection: 'money', id: 'gone2', data: {}, updatedAt: 2 });
  const flushPromise = sync.flush().catch(() => 'rejected');
  await new Promise((resolve) => setTimeout(resolve, 10));
  sync.destroy(); // 用户确认退出：引擎销毁
  releaseFlush(); // 在途响应返回
  await flushPromise;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepStrictEqual(uploadedAfterDestroy, ['gone1'], '退出后第一条在途请求已发出（不可撤回），但后续不得继续');
  assert.strictEqual(store.state.queue.length, 2, '中止后队列不被冲刷推进（交给 resetLocal 处置）');
  api.apiPut = originalApiPut;
  api.apiDelete = originalApiDelete;

  /* ---------- 6. money 单日超过条数预算时仍可加载更多（审查 Critical） ---------- */
  resetAll();
  const moneyRecords = {};
  for (let i = 0; i < 150; i++) {
    moneyRecords['d' + i] = { id: 'd' + i, data: { type: 'expense', amount: i + 1, category: '餐饮', date: '2026-10-28', note: 'n' + i }, updatedAt: 1000 + i, deletedAt: 0 };
  }
  store.state.records.money = moneyRecords;
  store.state.records.accounts = {};
  const originalPage = global.Page;
  let definition;
  global.Page = (page) => { definition = page; };
  delete require.cache[require.resolve('../miniprogram/pages/money/money.js')];
  require('../miniprogram/pages/money/money.js');
  global.Page = originalPage;
  function assignPath(target, key, value) {
    const keys = [];
    for (const part of key.split('.')) {
      const m = part.match(/^(.*?)\[(\d+)\]$/);
      if (m) { if (m[1]) keys.push(m[1]); keys.push(Number(m[2])); } else keys.push(part);
    }
    let cur = target;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = typeof keys[i + 1] === 'number' ? [] : {};
      cur = cur[k];
    }
    cur[keys[keys.length - 1]] = value;
  }
  const moneyPage = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) { for (const key of Object.keys(update)) assignPath(this.data, key, update[key]); }
  };
  moneyPage.setData({ month: '2026-10' });
  moneyPage.visibleGroups = 10;
  moneyPage.visibleItems = 120;
  moneyPage.render.call(moneyPage);
  let shownItems = 0;
  for (const group of moneyPage.data.groups) shownItems += group.items.length;
  assert.strictEqual(shownItems, 120, '单日 150 条首批按条数预算截断到 120');
  assert.strictEqual(moneyPage.data.hasMore, true, '单日超预算时 hasMore 必须为 true（审查修复前恒 false，条目不可达）');
  moneyPage.loadMore.call(moneyPage);
  shownItems = 0;
  for (const group of moneyPage.data.groups) shownItems += group.items.length;
  assert.strictEqual(shownItems, 150, '加载更多后单日全部条目可达');

  console.log('review-fixes.test.js 通过');
}

main().catch((error) => { console.error(error); process.exit(1); }).finally(() => { if (originalWx) global.wx = originalWx; });
