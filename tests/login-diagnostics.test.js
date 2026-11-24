/*
 * 登录失败后的「网络自检」与传输错误分类回归。
 * 覆盖：自检只读（不带 token / 不写存储）、6 秒预算、分类语义（-101 reset / -102 refused / -118 timeout）、
 * 登录页自检按钮的行为（成功、失败、进行中不重复探测、登录失败不自动探测）。
 */
const assert = require('assert');
const { BUILD_VERSION } = require('../miniprogram/config/build');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const apiPath = path.join(root, 'miniprogram', 'utils', 'api.js');
const loginPagePath = path.join(root, 'miniprogram', 'pages', 'login', 'login.js');
const loginWxml = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'login', 'login.wxml'), 'utf8');
const loginWxss = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'login', 'login.wxss'), 'utf8');

const api = require(apiPath);

let requests = [];
let behaviors = [];
let storageWrites = [];

global.wx = {
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'trial' } }),
  getStorageSync: () => '',
  setStorageSync: (key, value) => storageWrites.push([key, value]),
  removeStorageSync: () => {},
  showLoading: () => {},
  hideLoading: () => {},
  showToast: () => {},
  request: (options) => {
    requests.push(options);
    const behavior = behaviors.shift();
    assert.ok(behavior, '每个探测请求都必须有预设响应');
    behavior(options);
  }
};

function probe(behavior) {
  requests = [];
  behaviors = [behavior];
  storageWrites = [];
  return api.checkHealth();
}

async function main() {
  // 1. 自检成功：只读、6 秒预算、不携带登录态
  const ok = await probe((options) => options.success({ statusCode: 200, data: { ok: true } }));
  assert.deepStrictEqual(ok, { statusCode: 200, ok: true });
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].url.endsWith('/api/health'), true, '自检只允许请求 /api/health');
  assert.strictEqual(requests[0].method, 'GET');
  assert.strictEqual(requests[0].timeout, 6000, '自检必须在 6 秒内结束，不占用登录的 10 秒预算');
  assert.strictEqual(requests[0].header.Authorization, undefined, '自检不得携带登录令牌');
  assert.match(BUILD_VERSION, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, '发布版本应采用语义化版本号');
  assert.strictEqual(requests[0].header['X-Client-Build'], BUILD_VERSION, '自检应带上构建版本便于对日志');
  assert.deepStrictEqual(storageWrites, [], '自检不得写入本地存储');

  // 2. 传输失败分类：符号名优先，数字码兜底
  const classificationCases = [
    ['request:fail errcode:-101 cronet_error_code:-101 error_msg:net::ERR_CONNECTION_RESET', 'network_reset'],
    ['request:fail -102', 'network_refused'],
    ['request:fail errcode:-102 cronet_error_code:-102 error_msg:net::ERR_CONNECTION_REFUSED', 'network_refused'],
    ['request:fail -118', 'network_timeout'],
    ['request:fail timeout', 'network_timeout'],
    ['request:fail certificate verify failed', 'network_error']
  ];
  for (const [errMsg, expected] of classificationCases) {
    await assert.rejects(
      probe((options) => options.fail({ errMsg })),
      (error) => error.category === expected && error.phase === 'health_probe',
      `${errMsg} 应归类为 ${expected}`
    );
  }

  // 3. 服务端有响应时不按传输错误处理
  await assert.rejects(
    probe((options) => options.success({ statusCode: 503, data: { ok: false } })),
    (error) => error.category === 'http_503' && error.statusCode === 503
  );

  // 4. 登录页自检按钮
  const originalCheckHealth = api.checkHealth;
  const originalLogin = api.login;
  const originalPage = global.Page;
  let pageDefinition;
  try {
    global.Page = (definition) => { pageDefinition = definition; };
    delete require.cache[require.resolve(loginPagePath)];
    require(loginPagePath);

    const page = {
      ...pageDefinition,
      data: { ...pageDefinition.data },
      setData(update) { this.data = { ...this.data, ...update }; }
    };

    assert.strictEqual(typeof page.onDiagnose, 'function', '登录页必须提供自检入口');
    assert.match(loginWxml, /bindtap="onDiagnose"/, '自检入口必须绑定 onDiagnose');
    assert.match(loginWxml, /wx:if="\{\{loginFailed\}\}"/, '自检入口只在登录失败后出现');
    assert.match(loginWxml, /网络自检/);
    assert.match(loginWxml, /\{\{buildVersion\}\}/, '失败态应展示构建版本便于报障');
    assert.match(loginWxss, /\.diagnose-btn/, '自检按钮需要样式');
    assert.strictEqual(pageDefinition.data.buildVersion, BUILD_VERSION);

    api.checkHealth = () => Promise.resolve({ statusCode: 200, ok: true });
    page.onDiagnose.call(page);
    assert.strictEqual(page.data.diagnosing, true, '探测期间必须置为进行中');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(page.data.diagnosing, false);
    assert.strictEqual(page.data.diagnosticFailed, false);
    assert.match(page.data.diagnostic, /服务器可达/);

    api.checkHealth = () => Promise.reject(Object.assign(new Error('reset'), { category: 'network_reset' }));
    page.onDiagnose.call(page);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(page.data.diagnosticFailed, true);
    assert.match(page.data.diagnostic, /切换/, '连接不通时必须给出可执行的下一步');

    let probeCalls = 0;
    api.checkHealth = () => { probeCalls++; return new Promise(() => {}); };
    page.setData({ diagnosing: false });
    page.onDiagnose.call(page);
    page.onDiagnose.call(page);
    assert.strictEqual(probeCalls, 1, '自检进行中重复点击不得重复探测');

    // 登录失败不得自动发起探测：保持「加载态关闭 → 提示 → 用户决定是否自检」的顺序
    api.login = () => Promise.reject(Object.assign(new Error('reset'), { category: 'network_reset' }));
    requests = [];
    storageWrites = [];
    page.setData({ termsAccepted: true, loggingIn: false, loginFailed: false });
    page.onLogin.call(page);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(requests.length, 0, '登录失败后不得自动探测，避免额外网络开销');
    assert.strictEqual(page.data.loginFailed, true);
    assert.strictEqual(page.data.loggingIn, false);
    assert.match(page.data.serverError, /切换/, '登录失败文案应给出可执行的下一步');
    assert.strictEqual(page.data.diagnostic, '', '登录失败时自检结论应清空');
  } finally {
    api.checkHealth = originalCheckHealth;
    api.login = originalLogin;
    global.Page = originalPage;
    delete require.cache[require.resolve(loginPagePath)];
  }

  console.log('LOGIN_DIAGNOSTICS_TEST_PASSED');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
