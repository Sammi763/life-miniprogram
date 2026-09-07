const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const apiPath = path.join(root, 'miniprogram', 'utils', 'api.js');
const loginPagePath = path.join(root, 'miniprogram', 'pages', 'login', 'login.js');
const api = require(apiPath);

async function main() {
  const originalLogin = api.login;
  const originalSetBaseUrl = api.setBaseUrl;
  const originalPage = global.Page;
  const originalWx = global.wx;
  const events = [];
  let pageDefinition;

  try {
    api.setBaseUrl = () => true;
    api.login = () => Promise.reject(new Error('ERR_CONNECTION_REFUSED'));
    global.Page = (definition) => { pageDefinition = definition; };
    global.wx = {
      showLoading: () => events.push('showLoading'),
      hideLoading: () => events.push('hideLoading'),
      showToast: () => events.push('showToast')
    };
    delete require.cache[require.resolve(loginPagePath)];
    require(loginPagePath);

    const page = {
      ...pageDefinition,
      data: { ...pageDefinition.data, termsAccepted: true },
      setData(update) { this.data = { ...this.data, ...update }; }
    };
    page.onLogin.call(page);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(
      events,
      ['showLoading', 'hideLoading', 'showToast'],
      '登录失败时必须先关闭加载框，再展示错误提示'
    );
    console.log('LOGIN_LOADING_TEST_PASSED');
  } finally {
    api.login = originalLogin;
    api.setBaseUrl = originalSetBaseUrl;
    global.Page = originalPage;
    global.wx = originalWx;
    delete require.cache[require.resolve(loginPagePath)];
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
