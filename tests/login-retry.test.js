const assert = require('assert');

const storage = {};
let loginCodes = [];
let requestBehaviors = [];
let loginCalls = 0;
let requestOptions = [];
const logs = [];
const originalInfo = console.info;

global.wx = {
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'trial' } }),
  getStorageSync: (key) => storage[key],
  setStorageSync: (key, value) => { storage[key] = value; },
  removeStorageSync: (key) => { delete storage[key]; },
  login: (options) => {
    loginCalls++;
    const code = loginCodes.shift();
    if (code) options.success({ code });
    else options.fail({ errMsg: 'login:fail' });
  },
  request: (options) => {
    requestOptions.push(options);
    const behavior = requestBehaviors.shift();
    assert.ok(behavior, 'test must provide a response for every request');
    behavior(options);
  }
};

const api = require('../miniprogram/utils/api');

function scenario(codes, behaviors) {
  api.clearLogin();
  loginCodes = codes.slice();
  requestBehaviors = behaviors.slice();
  loginCalls = 0;
  requestOptions = [];
}

function success(token) {
  return (options) => options.success({
    statusCode: 200,
    data: { token, profile: { nickname: '' } }
  });
}

async function main() {
  console.info = (...args) => logs.push(args.join(' '));
  try {
    scenario(
      ['code-reset-first', 'code-reset-second', 'code-reset-third'],
      [
        (options) => options.fail({ errMsg: 'request:fail -102:net::ERR_CONNECTION_RESET' }),
        (options) => options.fail({ errMsg: 'request:fail -102:net::ERR_CONNECTION_RESET' }),
        success('token-reset-success')
      ]
    );
    const retryEvents = [];
    const before = Date.now();
    const profile = await api.login({ onRetry: (event) => retryEvents.push(event) });
    const elapsed = Date.now() - before;
    assert.deepStrictEqual(profile, { nickname: '' });
    assert.strictEqual(storage.wb_life_token, 'token-reset-success');
    assert.strictEqual(loginCalls, 3, 'each retry must call wx.login again');
    assert.deepStrictEqual(requestOptions.map((item) => item.data.code), ['code-reset-first', 'code-reset-second', 'code-reset-third']);
    assert.strictEqual(requestOptions[0].timeout, 10000, 'POST /api/login must time out at ten seconds');
    assert.strictEqual(requestOptions[0].url.endsWith('/api/login'), true);
    assert.strictEqual(requestOptions[0].header['X-Client-Build'], '20260924.8');
    assert.ok(elapsed >= 1700 && elapsed < 4000, 'two retries should use the first two bounded backoff steps');
    assert.deepStrictEqual(retryEvents.map((event) => [event.retry, event.maxRetries, event.category]), [
      [1, 4, 'network_reset'],
      [2, 4, 'network_reset']
    ]);

    scenario(
      ['code-timeout-first', 'code-timeout-second'],
      [
        (options) => options.fail({ errMsg: 'request:fail timeout' }),
        success('token-timeout-success')
      ]
    );
    assert.deepStrictEqual(await api.login(), { nickname: '' });
    assert.strictEqual(storage.wb_life_token, 'token-timeout-success');
    assert.strictEqual(loginCalls, 2, 'network timeout should get one fresh-code retry');

    // -102 只出现数字码时按 cronet 语义归为「连接被拒绝」，不能被当成 reset
    scenario(
      ['code-refused-only', 'code-refused-second'],
      [
        (options) => options.fail({ errMsg: 'request:fail -102' }),
        success('token-refused-success')
      ]
    );
    const refusedEvents = [];
    assert.deepStrictEqual(await api.login({ onRetry: (event) => refusedEvents.push(event) }), { nickname: '' });
    assert.deepStrictEqual(refusedEvents.map((event) => event.category), ['network_refused'], '-102 数字码应归类为 network_refused');
    assert.strictEqual(loginCalls, 2, '连接被拒绝同样应重试并重新获取 code');

    // 只有 -101 数字码时才归为 reset
    scenario(
      ['code-reset-only', 'code-reset-only-2'],
      [
        (options) => options.fail({ errMsg: 'request:fail cronet_error_code:-101' }),
        success('token-reset-only-success')
      ]
    );
    const resetOnlyEvents = [];
    await api.login({ onRetry: (event) => resetOnlyEvents.push(event) });
    assert.deepStrictEqual(resetOnlyEvents.map((event) => event.category), ['network_reset'], '-101 数字码应归类为 network_reset');

    // 重试预算耗尽：共 5 次尝试后失败，且不写登录态
    scenario(
      ['code-exhaust-1', 'code-exhaust-2', 'code-exhaust-3', 'code-exhaust-4', 'code-exhaust-5'],
      [1, 2, 3, 4, 5].map(() => (options) => options.fail({ errMsg: 'request:fail errcode:-101 cronet_error_code:-101 error_msg:net::ERR_CONNECTION_RESET' }))
    );
    const exhaustStart = Date.now();
    const exhaustedEvents = [];
    await assert.rejects(
      api.login({ onRetry: (event) => exhaustedEvents.push(event) }),
      (error) => error.category === 'network_reset' && error.phase === 'request_transport'
    );
    const exhaustElapsed = Date.now() - exhaustStart;
    assert.strictEqual(loginCalls, 5, '登录失败时共尝试 5 次（首次 + 4 次重试）');
    assert.strictEqual(requestOptions.length, 5, '每次重试都必须重新发起登录请求');
    assert.strictEqual(storage.wb_life_token, undefined, '全部失败后不得写入登录态');
    assert.deepStrictEqual(exhaustedEvents.map((event) => event.retry), [1, 2, 3, 4], '应上报 4 次重试事件');
    assert.ok(exhaustElapsed >= 8200 && exhaustElapsed < 12000, '退避总时长应约为 8.2 秒');

    scenario(['code-401'], [
      (options) => options.success({
        statusCode: 401,
        data: { error: 'code2session_failed', phase: 'wechat_code2session' }
      })
    ]);
    await assert.rejects(api.login(), (error) => error.category === 'http_401' && error.serverPhase === 'wechat_code2session');
    assert.strictEqual(loginCalls, 1, 'HTTP 401 must not retry');
    assert.strictEqual(requestOptions.length, 1, 'HTTP response must not retry');

    scenario(['code-unknown-network'], [
      (options) => options.fail({ errMsg: 'request:fail certificate verify failed' })
    ]);
    await assert.rejects(api.login(), (error) => error.category === 'network_error');
    assert.strictEqual(loginCalls, 1, 'unclassified transport errors must not retry');

    scenario([], [
      (options) => options.fail({ errMsg: 'request:fail -102:net::ERR_CONNECTION_RESET' }),
      (options) => options.success({ statusCode: 200, data: { profile: { nickname: '本地模拟昵称' } } })
    ]);
    storage.wb_life_token = 'profile-retry-token';
    assert.deepStrictEqual(await api.updateProfile({ nickname: '本地模拟昵称' }), { nickname: '本地模拟昵称' });
    assert.strictEqual(requestOptions.length, 2, 'profile save should retry one transient reset');
    assert.match(logs.join('\n'), /"operation":"profile_update"/);

    const logText = logs.join('\n');
    for (const secret of [
      'code-reset-first', 'code-reset-second', 'code-reset-third', 'code-timeout-first', 'code-timeout-second',
      'code-refused-only', 'code-refused-second', 'code-reset-only', 'code-reset-only-2',
      'code-exhaust-1', 'code-exhaust-2', 'code-exhaust-3', 'code-exhaust-4', 'code-exhaust-5',
      'code-401', 'code-unknown-network', 'token-reset-success', 'token-timeout-success',
      'token-refused-success', 'token-reset-only-success', 'profile-retry-token', '本地模拟昵称'
    ]) assert.strictEqual(logText.includes(secret), false, 'login logs must not contain codes or tokens');
    assert.match(logText, /"buildVersion":"20260924\.8"/);
    assert.match(logText, /"serverPhase":"wechat_code2session"/);
    assert.match(logText, /"durationMs":\d+/);

    console.log('LOGIN_RETRY_TEST_PASSED');
  } finally {
    console.info = originalInfo;
  }
}

main().catch((error) => {
  console.info = originalInfo;
  console.error(error);
  process.exitCode = 1;
});
