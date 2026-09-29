/*
 * 导入恢复的服务端并发保护 —— PUT createOnly「仅不存在时创建」。
 *
 * 背景：导入恢复此前只检查本机缓存，云端已有同 ID 记录时，客户端带新 updatedAt 的
 * LWW 写入会覆盖云端。现在导入写入携带 createOnly，服务端在「记录已存在（存活或墓碑）」
 * 时拒绝写入并回传现状；仅导入前 pull 不构成并发保护，该检查在存储事务内完成。
 *
 * 运行：node tests/import-create-only.test.js（本机 file 驱动 + 真实 server，无需 MySQL/真机）
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const repoRoot = path.resolve(__dirname, '..');
const { FileStore } = require(path.join(repoRoot, 'server', 'db', 'file-store'));

function request(port, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch (error) { json = { raw: text }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function main() {
  const appModule = require(path.join(repoRoot, 'server', 'server'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-miniprogram-import-test-'));
  const store = new FileStore({ dataDir });
  await store.init();
  const app = appModule.createApp(store, {
    devMode: false,
    dataDir,
    storageDriver: 'file',
    wxAppId: '',
    wxSecret: '',
    tokenTtlDays: 30,
    loginRateLimit: 100,
    reminderRateLimit: 100
  }, new Set(), {
    exchangeLoginCode: async (_config, code) => {
      const owners = { 'code-a': 'openid-a' };
      if (!owners[code]) throw new Error('invalid_code');
      return owners[code];
    }
  });
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const login = await request(port, 'POST', '/api/login', { code: 'code-a' });
    assert.strictEqual(login.status, 200);
    const token = login.body.token;
    const put = (collection, id, body) => request(port, 'PUT', '/api/records/' + collection + '/' + id, body, token);

    /* ---------- 1. 无 createOnly：LWW 行为不变（新时间戳覆盖旧值） ---------- */
    const first = await put('money', 'm1', { data: { type: 'expense', amount: 10, category: '餐饮', date: '2026-09-01' }, updatedAt: 1000 });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.body.applied, true);
    const lww = await put('money', 'm1', { data: { type: 'expense', amount: 99, category: '交通', date: '2026-09-01' }, updatedAt: 2000 });
    assert.strictEqual(lww.body.applied, true, '普通写入仍走 LWW');
    assert.strictEqual(lww.body.record.data.amount, 99);

    /* ---------- 2. createOnly：云端已有存活记录 → 拒绝写入、回传云端现状 ---------- */
    const existsLive = await put('money', 'm1', { data: { type: 'expense', amount: 1, category: '餐饮', date: '2026-09-02' }, updatedAt: 9999, createOnly: true });
    assert.strictEqual(existsLive.status, 200, 'createOnly 冲突不是错误，是明确的「未应用」结果');
    assert.strictEqual(existsLive.body.applied, false);
    assert.strictEqual(existsLive.body.reason, 'exists');
    assert.strictEqual(existsLive.body.record.data.amount, 99, '回传的是云端现状');
    const afterLive = await request(port, 'GET', '/api/records/money', undefined, token);
    assert.strictEqual(afterLive.body.records.m1.data.amount, 99, '云端记录必须保持不变（旧实现会被 updatedAt=9999 覆盖）');

    /* ---------- 3. createOnly：云端已有墓碑 → 同样拒绝（删除状态不复活） ---------- */
    const del = await request(port, 'DELETE', '/api/records/money/m2?updatedAt=5000', undefined, token);
    assert.strictEqual(del.status, 200);
    const existsTombstone = await put('money', 'm2', { data: { type: 'expense', amount: 5, category: '餐饮', date: '2026-09-03' }, updatedAt: 9999, createOnly: true });
    assert.strictEqual(existsTombstone.body.applied, false);
    assert.strictEqual(existsTombstone.body.reason, 'exists');
    assert.strictEqual(existsTombstone.body.record.deletedAt, 5000, '回传墓碑现状');
    const afterTombstone = await request(port, 'GET', '/api/records/money', undefined, token);
    assert.strictEqual(afterTombstone.body.records.m2.deletedAt, 5000, '墓碑不得被导入复活');

    /* ---------- 4. createOnly：不存在 → 正常创建（幂等重复导入） ---------- */
    const create = await put('habit', 'e_abc123_20260929', { data: { kind: 'entry', habitId: 'h1', date: '2026-09-29', value: 3, mode: 'count', target: 8 }, updatedAt: 7000, createOnly: true });
    assert.strictEqual(create.body.applied, true);
    const again = await put('habit', 'e_abc123_20260929', { data: { kind: 'entry', habitId: 'h1', date: '2026-09-29', value: 3, mode: 'count', target: 8 }, updatedAt: 8000, createOnly: true });
    assert.strictEqual(again.body.applied, false);
    assert.strictEqual(again.body.reason, 'exists');
    assert.strictEqual(again.body.record.updatedAt, 7000, '重复导入幂等：云端保留首次创建');
    const afterCreate = await request(port, 'GET', '/api/records/habit', undefined, token);
    assert.strictEqual(afterCreate.body.records.e_abc123_20260929.data.value, 3);

    /* ---------- 5. createOnly 不绕过字段校验 ---------- */
    const bad = await put('money', 'mX', { data: { type: 'expense', amount: -1, category: '餐饮', date: '2026-09-01' }, updatedAt: 1, createOnly: true });
    assert.strictEqual(bad.status, 422);

    console.log('IMPORT_CREATE_ONLY_TEST_PASSED');
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
