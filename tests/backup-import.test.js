/*
 * 导入恢复行为 —— 不覆盖现值、幂等、云端并发保护、备份墓碑不复活、容量边界、撤销语义。
 * 直接驱动真实 store/sync/backup，把 api 的 HTTP 方法换成桩（可模拟服务端 createOnly 拒绝）。
 * 运行：node tests/backup-import.test.js
 */
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');

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
const backup = require(path.join(root, 'miniprogram', 'utils', 'backup'));
const { validateRecordData } = require(path.join(root, 'server', 'validation'));

let putBehavior = 'accept'; // accept | existsLive | existsTombstone | transport
let putCalls = [];
api.apiPut = (collection, id, data, updatedAt, createOnly) => {
  putCalls.push({ collection, id, createOnly });
  if (putBehavior === 'transport') {
    const error = new Error('request fail');
    error.category = 'network_refused';
    return Promise.reject(error);
  }
  if (putBehavior === 'existsLive') {
    return Promise.resolve({ applied: false, reason: 'exists', record: { id, data: { type: 'expense', amount: 777, category: '云端值', date: '2026-09-01' }, updatedAt: 100, deletedAt: 0 } });
  }
  if (putBehavior === 'existsTombstone') {
    return Promise.resolve({ applied: false, reason: 'exists', record: { id, data: {}, updatedAt: 50, deletedAt: 50 } });
  }
  return Promise.resolve({ applied: true });
};
api.apiDelete = () => Promise.resolve({ applied: true });

function freshState() {
  for (const coll of store.COLLECTIONS) store.state.records[coll] = {};
  store.state.queue = [];
  store.state.rejectedWrites = [];
  store.state.syncState = 'idle';
}

function makeBackup(records) {
  const full = {};
  for (const coll of store.COLLECTIONS) full[coll] = records[coll] || [];
  return { format: 'life-backup', version: 1, exportedAt: '2026-09-29T00:00:00.000Z', source: 'local', records: full };
}

async function main() {
  store.loadLocal();

  /* ---------- 1. 预览分类 + 应用：新建/跳过现值/跳过墓碑/备份墓碑不复活/无效 ---------- */
  freshState();
  putBehavior = 'accept';
  store.applyLocalUpsert('money', { id: 'm1', data: { type: 'expense', amount: 99, category: '交通', date: '2026-09-01' }, updatedAt: 500, deletedAt: 0 });
  store.applyLocalUpsert('money', { id: 'm2', data: { type: 'expense', amount: 1, category: '交通', date: '2026-09-01' }, updatedAt: 500, deletedAt: 500 });

  const backupPayload = makeBackup({
    money: [
      { id: 'm1', data: { type: 'expense', amount: 12, category: '餐饮', date: '2026-09-01' }, updatedAt: 100 },                    // 同 id 存活 → 跳过
      { id: 'm2', data: { type: 'expense', amount: 5, category: '餐饮', date: '2026-09-02' }, updatedAt: 100 },                    // 本地墓碑 → 保持删除
      { id: 'm3', data: { type: 'expense', amount: 7, category: '餐饮', date: '2026-09-03' }, updatedAt: 100 },                    // 新建
      { id: 'm5', data: { type: 'expense', amount: 8, category: '餐饮', date: '2026-09-04' }, updatedAt: 100, deletedAt: 100 },    // 备份自带墓碑 → 不恢复
      { id: 'bad id!', data: { type: 'expense', amount: 7, category: '餐饮', date: '2026-09-03' }, updatedAt: 100 },               // ID 非法
      { id: 'm4', data: { type: 'expense', amount: -1, category: '餐饮', date: '2026-09-03' }, updatedAt: 100 }                    // 字段非法
    ],
    settings: [{ id: 'app', data: { budget: 5000, aiConsent: true }, updatedAt: 100 }]
  });
  const parsed = backup.parseBackup(JSON.stringify(backupPayload));
  assert.ok(!parsed.error);
  let preview = backup.previewImport(parsed.backup);
  assert.strictEqual(preview.create, 2, 'm3 与 settings/app 新建');
  assert.strictEqual(preview.skipLive, 1, 'm1 必须跳过保留现值');
  assert.strictEqual(preview.skipDeleted, 1, 'm2 必须跳过保持删除');
  assert.strictEqual(preview.skipBackupDeleted, 1, '备份自带 deletedAt 的记录必须单独计为「不恢复」');
  assert.strictEqual(preview.invalidCount, 2, '两条无效记录必须被拦下');
  assert.strictEqual(preview.total, 7);

  const result = await backup.applyImport(preview);
  assert.strictEqual(result.created, 2, '本批两条都应成功创建');
  assert.strictEqual(result.cloudResolved, 0);
  assert.strictEqual(result.applied.length, 2);
  const m3 = store.state.records.money.m3;
  assert.strictEqual(m3.data.amount, 7, '新记录必须按原 ID 落地');
  assert.strictEqual(validateRecordData('money', m3.data), '');
  assert.ok(m3.updatedAt > Date.now() - 60000, '导入记录必须使用新时间戳（保留旧值会破坏其他设备增量拉取）');
  assert.strictEqual(store.state.records.money.m5, undefined, '备份自带墓碑的记录绝不能作为存活记录恢复');
  const app = store.state.records.settings.app;
  assert.strictEqual(app.data.budget, 5000);
  assert.strictEqual(app.data.aiConsent, false, 'AI 同意必须强制重置，需用户重新选择');
  assert.strictEqual(store.state.records.money.m1.data.amount, 99, '已存在的记录绝不能被备份覆盖');
  assert.strictEqual(store.state.records.money.m2.deletedAt, 500, '本地墓碑不能被备份复活');
  assert.ok(putCalls.every((call) => call.createOnly === true), '导入写入必须全部携带 createOnly 并发保护标记');

  /* ---------- 2. 重复导入幂等：再次预览全部跳过 ---------- */
  preview = backup.previewImport(backup.parseBackup(JSON.stringify(backupPayload)).backup);
  assert.strictEqual(preview.create, 0, '重复导入不得重复创建');
  assert.strictEqual(preview.skipLive, 3, 'm1、m3 与 settings/app 现在都存在');
  assert.strictEqual(preview.skipBackupDeleted, 1);

  /* ---------- 3. 云端已有同 ID 记录（含导入期间并发创建）：以云端为准 ---------- */
  freshState();
  putBehavior = 'existsLive';
  const cloudPreview = backup.previewImport(backup.parseBackup(JSON.stringify(makeBackup({
    money: [{ id: 'cx', data: { type: 'expense', amount: 12, category: '餐饮', date: '2026-09-01' }, updatedAt: 1 }]
  }))).backup);
  const cloudResult = await backup.applyImport(cloudPreview);
  assert.strictEqual(cloudResult.created, 0, '云端已有记录时不得计为本次创建');
  assert.strictEqual(cloudResult.cloudResolved, 1, '被云端接管的记录必须单独计数');
  const cx = store.state.records.money.cx;
  assert.strictEqual(cx.data.amount, 777, '本地必须被服务端权威回写覆盖（forceApplyServer）');
  assert.strictEqual(cx.updatedAt, 100, '回写保留云端时间戳');
  assert.strictEqual(cloudResult.applied.length, 0, '云端接管的记录不得进入撤销清单');
  // 幂等：云端接管后再次预览按「已存在」跳过
  const cloudAgain = backup.previewImport(backup.parseBackup(JSON.stringify(makeBackup({
    money: [{ id: 'cx', data: { type: 'expense', amount: 12, category: '餐饮', date: '2026-09-01' }, updatedAt: 1 }]
  }))).backup);
  assert.strictEqual(cloudAgain.skipLive, 1, '云端接管后的本地记录按存活记录跳过');

  /* ---------- 4. 云端已有墓碑：保持删除 ---------- */
  freshState();
  putBehavior = 'existsTombstone';
  const tombPreview = backup.previewImport(backup.parseBackup(JSON.stringify(makeBackup({
    money: [{ id: 'ct', data: { type: 'expense', amount: 9, category: '餐饮', date: '2026-09-01' }, updatedAt: 1 }]
  }))).backup);
  const tombResult = await backup.applyImport(tombPreview);
  assert.strictEqual(tombResult.created, 0);
  assert.strictEqual(store.state.records.money.ct.deletedAt, 50, '云端墓碑必须原样落地，导入不得复活');

  /* ---------- 5. plan 的 reminder 剥离 ---------- */
  freshState();
  putBehavior = 'accept';
  const planPreview = backup.previewImport(backup.parseBackup(JSON.stringify(makeBackup({
    plan: [{ id: 'p1', data: { title: '看牙', date: '2026-09-05', time: '09:00', done: false, reminder: { enabled: true, dueAt: 1790000000000 } }, updatedAt: 1 }]
  }))).backup);
  await backup.applyImport(planPreview);
  assert.strictEqual(store.state.records.plan.p1.data.reminder, undefined, '旧提醒授权不得随备份恢复');
  assert.strictEqual(validateRecordData('plan', store.state.records.plan.p1.data), '');

  /* ---------- 6. 门槛：队列非空或离线不得导入 ---------- */
  const savedQueue = store.state.queue.slice();
  store.enqueue({ type: 'put', collection: 'money', id: 'mx', data: {}, updatedAt: 1 });
  assert.ok(backup.importBlockedReason(), '待同步队列非空必须拦截');
  store.state.queue = savedQueue;
  store.state.syncState = 'offline';
  assert.ok(backup.importBlockedReason(), '离线必须拦截');
  store.state.syncState = 'idle';
  store.state.queue = [];
  assert.strictEqual(backup.importBlockedReason(), '', '同步完成且在线时放行');

  /* ---------- 7. 撤销：只作用于本次实际创建且未被后续修改的记录 ---------- */
  freshState();
  const undoPreview = backup.previewImport(backup.parseBackup(JSON.stringify(makeBackup({
    money: [
      { id: 'u1', data: { type: 'expense', amount: 3, category: '餐饮', date: '2026-09-09' }, updatedAt: 1 },
      { id: 'u2', data: { type: 'expense', amount: 4, category: '餐饮', date: '2026-09-09' }, updatedAt: 1 }
    ]
  }))).backup);
  const undoResult = await backup.applyImport(undoPreview);
  assert.strictEqual(undoResult.created, 2);
  // 用户在撤销前改了 u2 → 撤销必须跳过它
  store.applyLocalUpsert('money', { id: 'u2', data: { type: 'expense', amount: 400, category: '餐饮', date: '2026-09-09' }, updatedAt: Date.now() + 5, deletedAt: 0 });
  const undone = backup.undoImport(undoResult.applied);
  assert.strictEqual(undone, 1, '只有未被修改的 u1 被撤销');
  assert.strictEqual(store.state.records.money.u1.deletedAt > 0, true, 'u1 补发墓碑');
  assert.strictEqual(store.state.records.money.u2.data.amount, 400, 'u2 已被修改，撤销不得碰它');

  /* ---------- 8. 分批冲刷与网络中断：如实报告，不虚报 ---------- */
  freshState();
  putBehavior = 'transport';
  const stopPreview = backup.previewImport(backup.parseBackup(JSON.stringify(makeBackup({
    money: [{ id: 's1', data: { type: 'expense', amount: 1, category: '餐饮', date: '2026-09-01' }, updatedAt: 1 }]
  }))).backup);
  const stopResult = await backup.applyImport(stopPreview);
  assert.strictEqual(stopResult.created, 1, '记录已写入本机并进入撤销清单（只是尚未上送）');
  assert.ok(stopResult.stopped, '必须返回中断原因，绝不静默');
  assert.ok(stopResult.applied.some((item) => item.id === 's1'), '本机已写入的记录必须可撤销');
  assert.ok(store.state.records.money.s1, '本机写入保留（断点续传），不是「数据未变化」');
  assert.ok(store.state.queue.some((item) => item.id === 's1' && item.createOnly), '中断的写入必须留在队列中待重试');

  /* ---------- 9. 容量预检：当前缓存 + 新建估算超边界必须拒收 ---------- */
  freshState();
  const huge = '巨'.repeat(810 * 1024); // 直接注入 store（绕过校验），使当前缓存逼近 82 万字符容量预算
  store.applyLocalUpsert('memories', { id: 'huge', data: { content: huge, occurredAt: '2026-09-01T00:00' }, updatedAt: 1, deletedAt: 0 });
  const capPreview = backup.previewImport(backup.parseBackup(JSON.stringify(makeBackup({
    money: [{ id: 'cap1', data: { type: 'expense', amount: 1, category: '餐饮', date: '2026-09-01', note: 'x'.repeat(20000) }, updatedAt: 1 }]
  }))).backup);
  assert.strictEqual(capPreview.error, 'capacity', '超过容量边界必须在预览期拒收');
  assert.ok(/容量边界/.test(capPreview.message), '拒收文案必须说明容量边界');
  delete store.state.records.memories.huge; // 硬删除：墓碑仍会带着巨数据留在快照里
  const okPreview = backup.previewImport(backup.parseBackup(JSON.stringify(makeBackup({
    money: [{ id: 'cap2', data: { type: 'expense', amount: 1, category: '餐饮', date: '2026-09-01' }, updatedAt: 1 }]
  }))).backup);
  assert.ok(!okPreview.error, '清理后同量级导入必须放行');

  freshState();
  putBehavior = 'accept';
  const legacy = makeBackup({
    money: ['decimal-a', 'decimal-b'].map((id) => ({
      id, data: { type: 'expense', amount: 1.005, category: '餐饮', date: '2026-09-01' }, updatedAt: 1
    }))
  });
  const precision = backup.previewImport(backup.parseBackup(JSON.stringify(legacy)).backup);
  assert.strictEqual(precision.roundedMoneyRecords, 2);
  assert.strictEqual(precision.moneyDifferences[0].expense.differenceCents, 1);
  assert.deepStrictEqual(precision.creates.map((entry) => entry.data.amount), [1.01, 1.01]);
  await backup.applyImport(precision);
  const exported = backup.buildLocalBackup();
  assert.deepStrictEqual(exported.records.money.map((entry) => entry.data.amount), [1.01, 1.01]);
  assert.strictEqual(backup.previewImport(backup.parseBackup(JSON.stringify(legacy)).backup).create, 0);
  assert.strictEqual(legacy.records.money[0].data.amount, 1.005);
  console.log('BACKUP_IMPORT_TEST_PASSED');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  // 传输失败的 15s 重试定时器会挂住事件循环，测试结束必须清掉
  sync.destroy();
});
