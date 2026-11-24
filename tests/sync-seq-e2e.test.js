/*
 * /api/sync sinceSeq 下载游标契约的端到端回归（复核补充：此前只有 file-store 单元级覆盖，
 * 「客户端↔服务端」的 HTTP 契约从未组装过）。
 * 锁住：seq 模式响应形状（cursor + changes）、增量水位、LWW 拒绝不消耗序号、
 *       删除墓碑下发、非法 sinceSeq 兜底、注销账号清除变更序号头。
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createApp } = require('../server/server');
const { FileStore } = require('../server/db/file-store');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-sync-seq-'));
  const config = { dataDir, storageDriver: 'file', devMode: true, tokenTtlDays: 30 };
  const store = new FileStore(config);
  await store.init();
  const app = createApp(store, config, new Set());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (url, options) => fetch(baseUrl + url, options);

  try {
    const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'dev' }) });
    assert.strictEqual(login.status, 200);
    const { token } = await login.json();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    /* 1. 首次写入 → sinceSeq=0 全量返回且带 cursor */
    const put1 = await request('/api/records/money/seq-m1', {
      method: 'PUT', headers,
      body: JSON.stringify({ updatedAt: 1000, data: { type: 'expense', amount: 12, category: '餐饮', date: '2026-10-28', note: '早餐' } })
    });
    assert.strictEqual(put1.status, 200);
    const firstPull = await (await request('/api/sync?since=0&sinceSeq=0', { headers })).json();
    assert.strictEqual(typeof firstPull.cursor, 'number', 'seq 模式必须回传数字 cursor');
    assert.ok(firstPull.cursor >= 1, '新写入必须推进游标');
    assert.ok(firstPull.changes.money.some((r) => r.id === 'seq-m1'), '全量拉取包含已写入记录');
    assert.strictEqual(typeof firstPull.serverTime, 'number');
    const cursor1 = firstPull.cursor;

    /* 2. 按水位线增量：无新写入时返回空 changes 且游标不回退 */
    const idlePull = await (await request('/api/sync?since=0&sinceSeq=' + cursor1, { headers })).json();
    assert.deepStrictEqual(idlePull.changes, {});
    assert.ok(idlePull.cursor >= cursor1, '游标单调不回退');

    /* 3. LWW 拒绝（更旧的时间戳）不消耗序号 */
    const older = await request('/api/records/money/seq-m1', {
      method: 'PUT', headers,
      body: JSON.stringify({ updatedAt: 500, data: { type: 'expense', amount: 1, category: '餐饮', date: '2026-10-28', note: '旧写入' } })
    });
    assert.strictEqual(older.status, 200);
    const olderBody = await older.json();
    assert.strictEqual(olderBody.applied, false, '旧写入必须被 LWW 拒绝');
    const afterReject = await (await request('/api/sync?since=0&sinceSeq=' + cursor1, { headers })).json();
    assert.deepStrictEqual(afterReject.changes, {}, '被拒绝的写入不得产生变更序号（其他设备不会白拉）');
    assert.strictEqual(afterReject.cursor, cursor1, '游标不得因拒绝而推进');

    /* 4. 另一条记录写入 → 增量只含新记录 */
    await request('/api/records/money/seq-m2', {
      method: 'PUT', headers,
      body: JSON.stringify({ updatedAt: 2000, data: { type: 'expense', amount: 30, category: '交通', date: '2026-10-28', note: '地铁' } })
    });
    const incPull = await (await request('/api/sync?since=0&sinceSeq=' + cursor1, { headers })).json();
    assert.ok(incPull.changes.money && incPull.changes.money.some((r) => r.id === 'seq-m2'), '增量包含新记录');
    assert.ok(!incPull.changes.money.some((r) => r.id === 'seq-m1'), '增量不重复下发已消费记录');
    assert.ok(incPull.cursor > cursor1, '新写入推进游标');
    const cursor2 = incPull.cursor;

    /* 5. 删除 → 墓碑下发（data 为 null） */
    const del = await request('/api/records/money/seq-m1?updatedAt=3000', { method: 'DELETE', headers });
    assert.strictEqual(del.status, 200);
    const tombPull = await (await request('/api/sync?since=0&sinceSeq=' + cursor2, { headers })).json();
    const tomb = tombPull.changes.money && tombPull.changes.money.find((r) => r.id === 'seq-m1');
    assert.ok(tomb, '删除必须下发墓碑');
    assert.strictEqual(tomb.deletedAt > 0, true, '墓碑带删除标记');
    assert.strictEqual(tomb.data, null, '墓碑不下发原数据');

    /* 6. 非法 sinceSeq 兜底为 0（全量），不 500 */
    const garbage = await (await request('/api/sync?since=0&sinceSeq=abc', { headers })).json();
    assert.strictEqual(typeof garbage.cursor, 'number');
    assert.ok(garbage.changes.money.some((r) => r.id === 'seq-m2'), '非法参数按全量兜底');

    /* 7. 注销账号清除变更序号头（复核修复：owner_id 与序号不得残留） */
    await request('/api/account', { method: 'DELETE', headers, body: JSON.stringify({ code: 'dev' }) });
    assert.deepStrictEqual(store.db.ownerSeqs, {}, '注销后 owner_seq 头必须清除（file 驱动）');
    const afterDelete = await request('/api/sync?since=0&sinceSeq=0', { headers });
    assert.strictEqual(afterDelete.status, 401, '注销后会话失效');

    console.log('sync-seq-e2e.test.js 通过');
  } finally {
    await store.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
