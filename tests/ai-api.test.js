/* AI 洞察 API 测试：鉴权、范围校验与服务端服务注入。 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createApp } = require('../server/server');
const { FileStore } = require('../server/db/file-store');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-ai-api-'));
  const store = new FileStore({ dataDir });
  await store.init();
  const calls = [];
  const app = createApp(store, { storageDriver: 'file', devMode: true, tokenTtlDays: 30, aiInsightRateLimit: 10 }, new Set(), {
    aiService: {
      getInsight: async (ownerId, scope, period) => {
        calls.push({ ownerId, scope, period });
        return { content: scope === 'today' ? '今天先做一件重要的事。' : '这个月的节奏比上个月更稳。', source: 'ai', generatedAt: 123 }
      }
    }
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (url, options) => fetch(baseUrl + url, options);

  try {
    assert.strictEqual((await request('/api/insights?scope=today')).status, 401, '洞察接口必须要求登录');
    const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'dev' }) });
    const { token } = await login.json();
    const headers = { Authorization: `Bearer ${token}` };
    assert.strictEqual((await request('/api/insights?scope=other', { headers })).status, 400, '洞察范围必须白名单校验');
    assert.strictEqual((await request('/api/insights?scope=month&month=2026-13', { headers })).status, 400, '月份必须校验');

    const today = await request('/api/insights?scope=today', { headers });
    assert.strictEqual(today.status, 200);
    assert.deepStrictEqual(await today.json(), { scope: 'today', period: calls[0].period, content: '今天先做一件重要的事。', source: 'ai', generatedAt: 123 });
    const month = await request('/api/insights?scope=month&month=2026-08', { headers });
    assert.strictEqual(month.status, 200);
    assert.strictEqual((await month.json()).content, '这个月的节奏比上个月更稳。');
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].ownerId, 'dev-user');
    assert.strictEqual(calls[1].period, '2026-08');
    console.log('AI_API_TEST_PASSED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAIL:', error.stack || error.message);
  process.exit(1);
});
