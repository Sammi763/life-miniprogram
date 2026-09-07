const assert = require('assert');

const storage = { wb_life_token: 'test-token' };
const originalWx = global.wx;
global.wx = {
  getStorageSync: (key) => storage[key] || '',
  setStorageSync: (key, value) => { storage[key] = value; },
  connectSocket: () => ({ onOpen() {}, onMessage() {}, onClose() {}, onError() {}, close() {} })
};

const api = require('../miniprogram/utils/api');
const sync = require('../miniprogram/utils/sync');
const store = require('../miniprogram/utils/store');

async function main() {
  const original = {
    getRuntimeConfig: api.getRuntimeConfig,
    getBaseUrl: api.getBaseUrl,
    apiSync: api.apiSync,
    connectSocket: global.wx.connectSocket
  };
  let socketCount = 0;

  try {
    global.wx.connectSocket = () => {
      socketCount++;
      return { onOpen() {}, onMessage() {}, onClose() {}, onError() {}, close() {} };
    };
    api.getRuntimeConfig = () => ({ isProduction: false, apiConfigured: true });
    sync.connectWS();
    assert.strictEqual(socketCount, 0, '本地开发不应尝试 WebSocket，避免服务未启动时产生额外控制台错误');

    api.apiSync = () => Promise.reject(new Error('connection refused'));
    assert.strictEqual(await sync.pull(), false, '同步连接失败应进入可恢复离线状态而非抛出未处理异常');
    assert.strictEqual(store.state.syncState, 'offline');

    api.getRuntimeConfig = () => ({ isProduction: true, apiConfigured: true });
    api.getBaseUrl = () => 'https://api.example.com';
    sync.connectWS();
    assert.strictEqual(socketCount, 1, '正式受控域名才启用实时通知');
  } finally {
    sync.destroy();
    api.getRuntimeConfig = original.getRuntimeConfig;
    api.getBaseUrl = original.getBaseUrl;
    api.apiSync = original.apiSync;
    global.wx.connectSocket = original.connectSocket;
    global.wx = originalWx;
  }
}

main().then(() => console.log('REALTIME_FALLBACK_TEST_PASSED')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
