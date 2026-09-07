/* API 集成冒烟：使用文件驱动隔离运行，覆盖鉴权、财务账户、导出和禁用上传端点。 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createApp } = require('../server/server');
const { FileStore } = require('../server/db/file-store');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-workbench-api-'));
  const config = {
    dataDir,
    storageDriver: 'file',
    devMode: true,
    tokenTtlDays: 30
  };
  const store = new FileStore(config);
  await store.init();
  const app = createApp(store, config, new Set());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = (url, options) => fetch(baseUrl + url, options);

  try {
    const unauthenticated = await request('/api/sync?since=0');
    assert.strictEqual(unauthenticated.status, 401, '同步接口必须要求鉴权');

    const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'dev' }) });
    assert.strictEqual(login.status, 200, '开发登录应成功');
    const { token } = await login.json();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const put = await request('/api/records/plan/api-test', { method: 'PUT', headers, body: JSON.stringify({ updatedAt: Date.now(), data: { title: 'API 测试', date: '2026-09-03', done: false } }) });
    assert.strictEqual(put.status, 200, '记录写入应成功');
    const accountPut = await request('/api/records/accounts/account-test', {
      method: 'PUT', headers,
      body: JSON.stringify({ updatedAt: Date.now(), data: { kind: 'asset', name: '支付宝余额', balance: 380.5, category: '支付余额', note: '' } })
    });
    assert.strictEqual(accountPut.status, 200, '财务账户写入应成功');
    const settingsPut = await request('/api/records/settings/app', {
      method: 'PUT', headers,
      body: JSON.stringify({ updatedAt: Date.now(), data: { budget: 3000, aiConsent: true, theme: 'paper' } })
    });
    assert.strictEqual(settingsPut.status, 200, '主题和 AI 同意状态应能通过同步接口保存');
    const memoryPut = await request('/api/records/memories/memory-test', {
      method: 'PUT', headers,
      body: JSON.stringify({ updatedAt: Date.now(), data: { content: '今天完成了同步测试。', occurredAt: '2026-09-03T20:30', mood: 'happy', tags: ['测试', '日常'] } })
    });
    assert.strictEqual(memoryPut.status, 200, '纯文字随记应写入通用同步集合');
    const invalidMemory = await request('/api/records/memories/memory-invalid', {
      method: 'PUT', headers,
      body: JSON.stringify({ updatedAt: Date.now(), data: { content: '不合法', occurredAt: '2026-09-03T20:30', mood: 'unknown', tags: [] } })
    });
    assert.strictEqual(invalidMemory.status, 422, '随记字段必须经过严格白名单校验');
    const exported = await request('/api/export', { headers: { Authorization: headers.Authorization } });
    assert.strictEqual(exported.status, 200, '云端导出应成功');
    const exportBody = await exported.json();
    assert.ok(exportBody.records.plan['api-test'], '导出应包含已写入记录');
    assert.ok(exportBody.records.accounts['account-test'], '导出应包含财务账户');
    assert.ok(exportBody.records.memories['memory-test'], '导出应包含随记');

    const disabledUpload = await request('/api/upload', {
      method: 'POST',
      headers: { Authorization: headers.Authorization }
    });
    assert.strictEqual(disabledUpload.status, 404, '文本优先版本不应暴露上传端点');
    console.log('API_TEST_PASSED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAIL:', error.message);
  process.exit(1);
});
