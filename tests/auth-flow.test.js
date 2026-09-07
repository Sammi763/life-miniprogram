const assert = require('assert');
const fs = require('fs');
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
  const store = new FileStore({ dataDir: path.join('/tmp', 'life-miniprogram-auth-test') });
  await store.init();
  const app = appModule.createApp(store, {
    devMode: true,
    dataDir: path.join('/tmp', 'life-miniprogram-auth-test'),
    storageDriver: 'file',
    devPhoneNumber: '13800138000',
    wxAppId: '',
    wxSecret: '',
    loginRateLimit: 100,
    reminderRateLimit: 100
  });
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const login = await request(port, 'POST', '/api/login', { code: 'dev' });
    assert.strictEqual(login.status, 200);
    assert.ok(login.body.token, 'login should issue a token');
    assert.strictEqual(store.db.sessions[login.body.token], undefined, '原始会话令牌不得写入文件存储');
    assert.ok(Object.keys(store.db.sessions).some((value) => /^[a-f0-9]{64}$/.test(value)), '会话必须以哈希指纹持久化');

    const profileBefore = await request(port, 'GET', '/api/profile', undefined, login.body.token);
    assert.strictEqual(profileBefore.status, 200);
    assert.strictEqual(profileBefore.body.profile.phone, '', 'new profile should not have a phone');

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

    const phoneUpdate = await request(port, 'PUT', '/api/profile', { phoneCode: 'dev-phone' }, login.body.token);
    assert.strictEqual(phoneUpdate.status, 200);
    assert.strictEqual(phoneUpdate.body.profile.phone, '138****8000');
    assert.strictEqual(phoneUpdate.body.profile.hasPhone, true);

    const unauthorized = await request(port, 'GET', '/api/profile');
    assert.strictEqual(unauthorized.status, 401);

    assert.match(fs.readFileSync(path.join(repoRoot, 'server', 'db', 'schema.sql'), 'utf8'), /CREATE TABLE IF NOT EXISTS users/i);
    assert.doesNotMatch(fs.readFileSync(path.join(repoRoot, 'miniprogram', 'pages', 'login', 'login.wxml'), 'utf8'), /chooseAvatar/);
    assert.match(fs.readFileSync(path.join(repoRoot, 'miniprogram', 'pages', 'login', 'login.wxml'), 'utf8'), /text-avatar/);
    assert.match(fs.readFileSync(path.join(repoRoot, 'miniprogram', 'pages', 'login', 'login.wxml'), 'utf8'), /open-type="getPhoneNumber"/);
    assert.match(fs.readFileSync(path.join(repoRoot, 'miniprogram', 'pages', 'login', 'login.wxml'), 'utf8'), /\/assets\/logo\.png/);

    console.log('AUTH_FLOW_TEST_PASSED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
