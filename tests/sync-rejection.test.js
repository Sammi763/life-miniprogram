/*
 * 写队列拒绝处理 —— 来自 2026-09-24 真机走查发现的「控制台每 15 秒刷一次 422」。
 *
 * 现场证据（PUT http://127.0.0.1:8787/api/records/settings/app）：
 *   body {"data":{"budget":3000,"aiConsent":true}} → 422 {"error":"bad_settings"}
 *   每 15 秒重发一次，3 分钟 15 次，永不停止；「我的 → 待同步」长期停在 19 不降。
 * 根因：flush() 严格 FIFO（只看 q[0]），旧实现对任何失败都「保留队首 + 15s 重试」，
 * 于是一条被服务端永久拒绝的写入把整条队列堵死，并周期性刷错误日志。
 *
 * 本测试直接驱动真实 utils/{store,sync}.js，只把 api 模块的 HTTP 方法换成桩，
 * 因此不需要真机、不需要后端，也不产生真实网络请求。
 */
const assert = require('assert');

// ---------- mock wx（store 的持久化通道） ----------
const mem = {};
global.wx = {
  getStorageSync: (k) => (k in mem ? mem[k] : ''),
  setStorageSync: (k, v) => { mem[k] = v; },
  removeStorageSync: (k) => { delete mem[k]; },
  onNetworkStatusChange() {},
  connectSocket: () => ({ onOpen() {}, onMessage() {}, onClose() {}, onError() {}, close() {}, send() {} })
};

const store = require('../miniprogram/utils/store');
const sync = require('../miniprogram/utils/sync');
const api = require('../miniprogram/utils/api');

function httpError(statusCode, code) {
  const error = new Error('http ' + statusCode + (code ? ' ' + code : ''));
  error.statusCode = statusCode;
  error.category = 'http_' + statusCode;
  error.code = code || '';
  return error;
}

let calls = [];
function stubPut(handler) {
  api.apiPut = (collection, id, data, updatedAt) => {
    calls.push({ collection, id, updatedAt });
    return handler(collection, id);
  };
}

(async () => {
  store.loadLocal();

  /* ---------- 1. 4xx 明确拒绝：丢弃队首、继续冲刷、记入可见状态、不死循环 ---------- */
  calls = [];
  stubPut((collection) => {
    if (collection === 'settings') return Promise.reject(httpError(422, 'bad_settings'));
    return Promise.resolve({ applied: true });
  });
  store.enqueue({ type: 'put', collection: 'settings', id: 'app', data: { budget: 3000, aiConsent: true }, updatedAt: 111 });
  store.enqueue({ type: 'put', collection: 'money', id: 'm1', data: { amount: 1 }, updatedAt: 222 });

  await sync.flush();

  assert.strictEqual(store.state.queue.length, 0, '被拒的队首必须被丢弃，队列不能被永久堵住');
  assert.strictEqual(calls.length, 2, '后面的写入必须继续冲刷（旧的堵队列实现只会发出第 1 条）');
  assert.strictEqual(store.state.syncState, 'idle', '丢弃后应回到 idle，而不是停在 offline');
  assert.strictEqual(store.state.rejectedWrites.length, 1, '被拒写入必须留下来供用户查看/重试');
  const rejected = store.state.rejectedWrites[0];
  assert.strictEqual(rejected.item.collection, 'settings');
  assert.strictEqual(rejected.item.id, 'app');
  assert.strictEqual(rejected.statusCode, 422);
  assert.strictEqual(rejected.code, 'bad_settings');
  assert.strictEqual(rejected.item.data.aiConsent, true, '必须完整保留原始 payload，手动重试才有内容可发');

  /* 同一条记录重复被拒只保留一条，避免列表被反复操作刷爆 */
  store.enqueue({ type: 'put', collection: 'settings', id: 'app', data: { budget: 1 }, updatedAt: 333 });
  await sync.flush();
  assert.strictEqual(store.state.rejectedWrites.length, 1, '同一 collection+id 只保留最近一次拒绝');

  /* ---------- 2. 传输类失败：保留队首、进入 offline、不记为「被拒绝」 ---------- */
  calls = [];
  stubPut(() => {
    const error = new Error('request fail');
    error.category = 'network_refused';
    return Promise.reject(error);
  });
  store.enqueue({ type: 'put', collection: 'money', id: 'm2', data: { amount: 2 }, updatedAt: 444 });
  await sync.flush().catch(() => {});

  assert.strictEqual(store.state.queue.length, 1, '传输失败必须保留队首等待自动重试');
  assert.strictEqual(store.state.queue[0].id, 'm2');
  assert.strictEqual(store.state.syncState, 'offline', '传输失败仍是 offline 语义');
  assert.strictEqual(store.state.rejectedWrites.length, 1, '传输失败不得被当成服务端拒绝');

  /* ---------- 3. 401 / 408 / 429 是例外，必须保持可重试 ---------- */
  for (const status of [401, 408, 429]) {
    store.clearRejectedWrites();
    stubPut(() => Promise.reject(httpError(status)));
    store.enqueue({ type: 'put', collection: 'money', id: 'e' + status, data: {}, updatedAt: 555 + status });
    await sync.flush().catch(() => {});
    assert.strictEqual(store.state.rejectedWrites.length, 0, 'HTTP ' + status + ' 不应被当成永久拒绝');
    assert.ok(store.state.queue.length >= 1, 'HTTP ' + status + ' 必须保留队列等待重试');
    store.state.queue.length = 0; // 清掉，进入下一轮
  }

  /* ---------- 4. 手动重试：放回队列头部 + 换新的 updatedAt ---------- */
  store.clearRejectedWrites();
  calls = [];
  stubPut(() => Promise.reject(httpError(422, 'bad_settings')));
  store.enqueue({ type: 'put', collection: 'settings', id: 'app', data: { budget: 3000 }, updatedAt: 666 });
  await sync.flush();
  assert.strictEqual(store.state.rejectedWrites.length, 1, '先制造一条被拒写入');
  const originalUpdatedAt = store.state.rejectedWrites[0].item.updatedAt;

  stubPut(() => Promise.resolve({ applied: true }));
  calls = [];
  const n = store.retryRejectedWrites();
  assert.strictEqual(n, 1, '重试应返回被重新入队的条数');
  assert.strictEqual(store.state.rejectedWrites.length, 0, '重试后拒绝列表应清空');
  assert.strictEqual(store.state.queue.length, 1);
  assert.ok(
    store.state.queue[0].updatedAt > originalUpdatedAt,
    '重试必须换新的 updatedAt —— 沿用旧时间戳会被服务端按 LWW 判为旧写入直接丢弃'
  );
  await sync.flush();
  assert.strictEqual(store.state.queue.length, 0, '重试成功后队列应清空');
  assert.strictEqual(store.state.rejectedWrites.length, 0, '重试成功后不应再有被拒记录');

  /* ---------- 5. 被拒状态必须能跨重启恢复（持久化在本机缓存里） ---------- */
  stubPut(() => Promise.reject(httpError(422, 'bad_settings')));
  store.enqueue({ type: 'put', collection: 'settings', id: 'app', data: { theme: 'forest' }, updatedAt: 777 });
  await sync.flush();
  assert.strictEqual(store.state.rejectedWrites.length, 1);
  // 持久化是 250ms 防抖：先等它落盘，再清空内存并读回，验证的是「从缓存恢复」而不是内存残留
  await new Promise((resolve) => setTimeout(resolve, 320));
  store.state.rejectedWrites = [];
  store.loadLocal();
  assert.strictEqual(store.state.rejectedWrites.length, 1, '被拒写入应随本机缓存一起恢复，重启后仍然可见');

  sync.destroy();
  console.log('sync-rejection.test.js  OK（4xx 丢弃队首不死循环 / 传输失败仍重试 / 401·408·429 例外 / 手动重试换时间戳 / 跨重启可见）');
  process.exit(0);
})().catch((error) => {
  console.error('FAIL:', error && error.message);
  process.exit(1);
});
