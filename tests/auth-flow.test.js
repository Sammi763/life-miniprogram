const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const repoRoot = path.resolve(__dirname, '..');
const { FileStore } = require(path.join(repoRoot, 'server', 'db', 'file-store'));

function request(port, method, pathname, body, token, extraHeaders) {
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
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(extraHeaders || {})
      }
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch (error) {
          json = { raw: text };
        }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function loadApp() {
  return require(path.join(repoRoot, 'server', 'server'));
}

async function main() {
  const appModule = loadApp();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-miniprogram-auth-test-'));
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
      const owners = { 'code-a': 'openid-a', 'code-a-again': 'openid-a', 'code-b': 'openid-b' };
      if (!owners[code]) throw new Error('invalid_code');
      return owners[code];
    }
  });
  const server = app.listen(0);
  const port = server.address().port;
  const serverLogs = [];
  const originalConsoleLog = console.log;
  console.log = (message) => serverLogs.push(String(message));

  try {
    const login = await request(port, 'POST', '/api/login', { code: 'code-a' }, undefined, { 'x-client-build': '20260923.1' });
    assert.strictEqual(login.status, 200);
    assert.strictEqual(login.body.openid, 'openid-a');
    assert.ok(login.body.token, 'login should issue a token');
    const invalidLogin = await request(port, 'POST', '/api/login', { code: 'sensitive-invalid-code' }, undefined, { 'x-client-build': '20260923.1' });
    assert.strictEqual(invalidLogin.status, 401);
    assert.strictEqual(invalidLogin.body.phase, 'wechat_code2session');
    const loginLogText = serverLogs.join('\n');
    assert.match(loginLogText, /"buildVersion":"20260923\.1"/);
    assert.match(loginLogText, /"phase":"wechat_code2session"/);
    assert.match(loginLogText, /"durationMs":\d+/);
    assert.doesNotMatch(loginLogText, /sensitive-invalid-code|code-a|openid-a|"token"/);
    assert.strictEqual(store.db.sessions[login.body.token], undefined, '原始会话令牌不得写入文件存储');
    assert.ok(Object.keys(store.db.sessions).some((value) => /^[a-f0-9]{64}$/.test(value)), '会话必须以哈希指纹持久化');

    const profileBefore = await request(port, 'GET', '/api/profile', undefined, login.body.token);
    assert.strictEqual(profileBefore.status, 200);
    assert.strictEqual(profileBefore.body.profile.phone, '', 'new profile should not have a phone');
    assert.strictEqual(profileBefore.body.profile.hasPhone, false, 'profile response shape keeps the historical phone status field');

    const profileUpdate = await request(port, 'PUT', '/api/profile', {
      nickname: '生活记录者'
    }, login.body.token);
    assert.strictEqual(profileUpdate.status, 200);
    assert.strictEqual(profileUpdate.body.profile.nickname, '生活记录者');
    assert.strictEqual(profileUpdate.body.profile.avatarUrl, undefined, '资料接口不应返回图片地址');

    const avatarOnly = await request(port, 'PUT', '/api/profile', {
      avatarUrl: '/files/' + 'a'.repeat(64) + '.png'
    }, login.body.token);
    assert.strictEqual(avatarOnly.status, 422, '文本优先版本不应接收头像地址');

    const directPhone = await request(port, 'PUT', '/api/profile', { phone: '13800138000' }, login.body.token);
    assert.strictEqual(directPhone.status, 422, 'profile endpoint must not trust a raw phone number');

    await store.updateProfile('openid-a', { phone: '138****8000' });
    const phoneUpdate = await request(port, 'PUT', '/api/profile', {
      nickname: '此昵称不应写入', phoneCode: 'new-phone-code'
    }, login.body.token);
    assert.strictEqual(phoneUpdate.status, 422, 'new phone binding requests must be explicitly rejected');
    assert.strictEqual(phoneUpdate.body.error, 'phone_binding_disabled');

    const legacyProfile = await request(port, 'GET', '/api/profile', undefined, login.body.token);
    assert.strictEqual(legacyProfile.body.profile.phone, '138****8000', 'existing masked phone data remains intact');
    assert.strictEqual(legacyProfile.body.profile.hasPhone, true, 'historical profile response fields stay compatible');
    assert.strictEqual(legacyProfile.body.profile.nickname, '生活记录者', 'rejected phone requests must not apply other profile changes');

    const ownedRecord = { updatedAt: Date.now(), data: { title: '账号 A 私有记录', date: '2026-09-23', done: false } };
    const savedA = await request(port, 'PUT', '/api/records/plan/private-a', ownedRecord, login.body.token);
    assert.strictEqual(savedA.status, 200);
    const sameAccountLogin = await request(port, 'POST', '/api/login', { code: 'code-a-again' });
    assert.strictEqual(sameAccountLogin.status, 200);
    assert.strictEqual(sameAccountLogin.body.openid, login.body.openid, 'same WeChat identity returns to the same owner id');
    const sameAccountRead = await request(port, 'GET', '/api/records/plan', undefined, sameAccountLogin.body.token);
    assert.ok(sameAccountRead.body.records['private-a'], 'same owner can read their existing record after login again');

    const loginB = await request(port, 'POST', '/api/login', { code: 'code-b' });
    assert.strictEqual(loginB.status, 200);
    assert.notStrictEqual(loginB.body.openid, login.body.openid);
    const readAsB = await request(port, 'GET', '/api/records/plan', undefined, loginB.body.token);
    assert.strictEqual(readAsB.body.records['private-a'], undefined, 'a different owner cannot read account A records');
    await request(port, 'PUT', '/api/records/plan/private-b', {
      updatedAt: Date.now(), data: { title: '账号 B 私有记录', date: '2026-09-23', done: false }
    }, loginB.body.token);
    const readAsA = await request(port, 'GET', '/api/records/plan', undefined, sameAccountLogin.body.token);
    assert.strictEqual(readAsA.body.records['private-b'], undefined, 'account A cannot read account B records');

    const unauthorized = await request(port, 'GET', '/api/profile');
    assert.strictEqual(unauthorized.status, 401);

    assert.match(fs.readFileSync(path.join(repoRoot, 'server', 'db', 'schema.sql'), 'utf8'), /CREATE TABLE IF NOT EXISTS users/i);
    assert.doesNotMatch(fs.readFileSync(path.join(repoRoot, 'miniprogram', 'pages', 'login', 'login.wxml'), 'utf8'), /chooseAvatar/);
    assert.match(fs.readFileSync(path.join(repoRoot, 'miniprogram', 'pages', 'login', 'login.wxml'), 'utf8'), /text-avatar/);
    assert.doesNotMatch(fs.readFileSync(path.join(repoRoot, 'miniprogram', 'pages', 'login', 'login.wxml'), 'utf8'), /getPhoneNumber|手机号|phoneCode/);
    assert.match(fs.readFileSync(path.join(repoRoot, 'miniprogram', 'pages', 'login', 'login.wxml'), 'utf8'), /重新登录/);
    assert.match(fs.readFileSync(path.join(repoRoot, 'miniprogram', 'pages', 'login', 'login.wxml'), 'utf8'), /\/assets\/logo\.png/);

    console.log = originalConsoleLog;
    console.log('AUTH_FLOW_TEST_PASSED');
  } finally {
    console.log = originalConsoleLog;
    await new Promise((resolve) => server.close(resolve));
    await store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
