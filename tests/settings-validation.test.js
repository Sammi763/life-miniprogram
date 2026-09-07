const assert = require('assert');
const { SETTINGS_THEMES, validateRecordData } = require('../server/validation');
const { pickSettings } = require('../miniprogram/utils/settings-utils');

assert.deepStrictEqual(SETTINGS_THEMES, ['forest', 'paper', 'sky', 'violet'], '服务端主题白名单应与小程序保持一致');
assert.strictEqual(validateRecordData('settings', { budget: 3000 }), '', '旧版设置记录必须继续兼容');
assert.strictEqual(validateRecordData('settings', { budget: 3000, aiConsent: true, theme: 'paper' }), '', 'AI 同意状态和主题应可同步');
assert.strictEqual(validateRecordData('settings', { aiConsent: false, theme: 'violet' }), '', '关闭 AI 和暮紫主题应可保存');
assert.strictEqual(validateRecordData('settings', { theme: 'unknown' }), 'bad_settings', '未知主题必须拒绝');
assert.strictEqual(validateRecordData('settings', { theme: 'paper', serverUrl: 'http://127.0.0.1:8787' }), 'bad_settings', '设置记录不能写入白名单外字段');
assert.strictEqual(validateRecordData('settings', { aiConsent: 'true' }), 'bad_settings', 'AI 同意状态必须是布尔值');
assert.deepStrictEqual(pickSettings({ budget: 3000, theme: 'paper', serverUrl: 'http://127.0.0.1:8787' }), { budget: 3000, theme: 'paper' }, '客户端保存设置前应清理旧服务器地址字段');

const localState = {
  records: { settings: { app: { id: 'app', data: { budget: 3000, serverUrl: 'http://127.0.0.1:8787' } } } },
  queue: [{ type: 'put', collection: 'settings', id: 'app', data: { budget: 3000, serverUrl: 'http://127.0.0.1:8787' }, updatedAt: 1 }]
};
global.wx = {
  getStorageSync: () => localState,
  setStorageSync: () => {}
};
const store = require('../miniprogram/utils/store');
store.loadLocal();
assert.deepStrictEqual(store.state.records.settings.app.data, { budget: 3000 }, '加载本地设置时应移除旧服务器地址');
assert.deepStrictEqual(store.state.queue[0].data, { budget: 3000 }, '加载待同步队列时应移除旧服务器地址');

console.log('SETTINGS_VALIDATION_TEST_PASSED');
