/* v1.6 集成测试：提醒状态机、账户删除、记录白名单与禁用文件入口。 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createApp } = require('../server/server');
const { FileStore } = require('../server/db/file-store');
const { createReminderWorker } = require('../server/reminders');

function localDate(offsetDays) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-v16-api-'));
  const config = {
    dataDir,
    storageDriver: 'file',
    devMode: true,
    tokenTtlDays: 30,
    wxAppId: 'test-appid',
    wxSecret: 'test-secret',
    wxReminderTemplateId: 'template-id',
    allowedOrigins: ['https://life.example.com'],
    loginRateLimit: 2
  };
  const store = new FileStore(config);
  await store.init();
  const delivered = [];
  const app = createApp(store, config, new Set(), {
    sendSubscriptionMessage: async (_config, message) => { delivered.push(message); return { errcode: 0 }; }
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (url, options) => fetch(baseUrl + url, options);

  try {
    const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'dev' }) });
    const { token } = await login.json();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    assert.strictEqual((await request('/api/reminders/capabilities')).status, 401, '提醒能力查询必须受登录态保护');
    assert.strictEqual((await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'dev' }) })).status, 200);
    assert.strictEqual((await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'dev' }) })).status, 429, '登录接口必须限流');

    const capabilities = await request('/api/reminders/capabilities', { headers });
    assert.strictEqual(capabilities.status, 200);
    assert.deepStrictEqual(await capabilities.json(), { enabled: true, templateId: 'template-id' });

    const dueAt = Math.ceil((Date.now() + 10 * 60 * 1000) / 60000) * 60000;
    const dueDate = new Date(dueAt);
    const planDate = dueDate.getFullYear() + '-' + String(dueDate.getMonth() + 1).padStart(2, '0') + '-' + String(dueDate.getDate()).padStart(2, '0');
    const planTime = String(dueDate.getHours()).padStart(2, '0') + ':' + String(dueDate.getMinutes()).padStart(2, '0');
    const plan = await request('/api/records/plan/plan-reminder', {
      method: 'PUT', headers,
      body: JSON.stringify({
        updatedAt: Date.now(),
        data: { title: '提醒测试', date: planDate, time: planTime, done: false, reminder: { enabled: true, dueAt } }
      })
    });
    assert.strictEqual(plan.status, 200, '带提醒的一次性日程应能保存');

    const scheduled = await request('/api/reminders/plan-reminder', {
      method: 'PUT', headers,
      body: JSON.stringify({ title: '提醒测试', dueAt })
    });
    assert.strictEqual(scheduled.status, 201, '授权后应能创建单次提醒');
    const firstReminder = await scheduled.json();
    assert.strictEqual(firstReminder.status, 'pending');

    const revisedDueAt = dueAt + 60 * 1000;
    const revisedDue = new Date(revisedDueAt);
    const revisedDate = revisedDue.getFullYear() + '-' + String(revisedDue.getMonth() + 1).padStart(2, '0') + '-' + String(revisedDue.getDate()).padStart(2, '0');
    const revisedTime = String(revisedDue.getHours()).padStart(2, '0') + ':' + String(revisedDue.getMinutes()).padStart(2, '0');
    const editedPlan = await request('/api/records/plan/plan-reminder', {
      method: 'PUT', headers,
      body: JSON.stringify({
        updatedAt: Date.now() + 1,
        data: { title: '提醒测试（已改期）', date: revisedDate, time: revisedTime, done: false, reminder: { enabled: true, dueAt: revisedDueAt } }
      })
    });
    assert.strictEqual(editedPlan.status, 200);
    const rescheduled = await request('/api/reminders/plan-reminder', {
      method: 'PUT', headers,
      body: JSON.stringify({ dueAt: revisedDueAt })
    });
    assert.strictEqual(rescheduled.status, 201, '编辑日程应重排提醒');
    const replacement = await rescheduled.json();
    assert.notStrictEqual(replacement.id, firstReminder.id, '重排应取消旧提醒并创建新提醒');

    const cancelled = await request('/api/reminders/plan-reminder', { method: 'DELETE', headers });
    assert.strictEqual(cancelled.status, 200, '删除或完成日程应取消待发送提醒');
    assert.strictEqual((await cancelled.json()).cancelled, 1);

    const completionPlan = await request('/api/records/plan/plan-complete', {
      method: 'PUT', headers,
      body: JSON.stringify({ updatedAt: Date.now() + 2, data: { title: '完成即取消', date: planDate, time: planTime, done: false, reminder: { enabled: true, dueAt } } })
    });
    assert.strictEqual(completionPlan.status, 200);
    assert.strictEqual((await request('/api/reminders/plan-complete', { method: 'PUT', headers, body: JSON.stringify({ dueAt }) })).status, 201);
    const completion = await request('/api/records/plan/plan-complete', {
      method: 'PUT', headers,
      body: JSON.stringify({ updatedAt: Date.now() + 3, data: { title: '完成即取消', date: planDate, time: planTime, done: true, reminder: { enabled: false } } })
    });
    assert.strictEqual(completion.status, 200);
    assert.strictEqual((await (await request('/api/reminders/plan-complete', { headers })).json()).reminder.status, 'cancelled', '完成日程应通过同步协议取消提醒');

    const deletionPlan = await request('/api/records/plan/plan-delete', {
      method: 'PUT', headers,
      body: JSON.stringify({ updatedAt: Date.now() + 4, data: { title: '删除即取消', date: planDate, time: planTime, done: false, reminder: { enabled: true, dueAt } } })
    });
    assert.strictEqual(deletionPlan.status, 200);
    assert.strictEqual((await request('/api/reminders/plan-delete', { method: 'PUT', headers, body: JSON.stringify({ dueAt }) })).status, 201);
    const deletion = await request('/api/records/plan/plan-delete?updatedAt=' + (Date.now() + 5), { method: 'DELETE', headers });
    assert.strictEqual(deletion.status, 200);
    assert.strictEqual((await (await request('/api/reminders/plan-delete', { headers })).json()).reminder.status, 'cancelled', '删除日程应通过同步协议取消提醒');

    const invalidData = await request('/api/records/money/bad-record', {
      method: 'PUT', headers,
      body: JSON.stringify({ updatedAt: Date.now(), data: { type: 'expense', amount: 1, date: localDate(0), category: '餐饮', injected: true } })
    });
    assert.strictEqual(invalidData.status, 422, '同步记录必须通过字段白名单校验');

    const due = await store.createReminder('dev-user', 'due-plan', { title: '到点提醒', dueAt: Date.now() - 1 });
    const worker = createReminderWorker(store, config, async (_config, message) => { delivered.push(message); return { errcode: 0 }; });
    await worker.runOnce();
    await worker.runOnce();
    assert.strictEqual(delivered.filter((item) => item.touser === 'dev-user' && item.page === 'pages/plan/plan').length, 1, '到期提醒只能发送一次');
    assert.strictEqual((await store.getReminder(due.id)).status, 'sent');

    const failed = await store.createReminder('dev-user', 'failure-plan', { title: '失败提醒', dueAt: Date.now() - 1 });
    const failingWorker = createReminderWorker(store, config, async () => { throw new Error('wechat down'); });
    await failingWorker.runOnce();
    await failingWorker.runOnce();
    assert.strictEqual((await store.getReminder(failed.id)).status, 'failed', '微信接口失败必须终止，不重复发送');

    const disabledUpload = await request('/api/upload', { method: 'POST', headers });
    assert.strictEqual(disabledUpload.status, 404, '生产接口不应继续提供文件上传');
    const disabledFile = await request('/files/' + 'a'.repeat(64) + '.png', { headers });
    assert.strictEqual(disabledFile.status, 404, '生产接口不应继续提供文件读取');

    const missingFreshLogin = await request('/api/account', { method: 'DELETE', headers, body: JSON.stringify({}) });
    assert.strictEqual(missingFreshLogin.status, 422, '账户删除必须要求新的登录凭证');
    const deleted = await request('/api/account', {
      method: 'DELETE', headers,
      body: JSON.stringify({ code: 'dev' })
    });
    assert.strictEqual(deleted.status, 204, '账户删除需要新的微信登录校验后才执行');
    assert.strictEqual((await request('/api/profile', { headers })).status, 401, '删除账户后当前会话必须失效');
    assert.strictEqual(Object.keys(await store.getCollection('dev-user', 'plan')).length, 0, '账户记录必须一并删除');
    assert.strictEqual(await store.getReminder(due.id), null, '账户提醒必须删除');
    console.log('V16_API_TEST_PASSED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAIL:', error.stack || error.message);
  process.exit(1);
});
