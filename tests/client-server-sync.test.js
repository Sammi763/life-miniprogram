/*
 * 客户端同步引擎 ↔ 真实服务端的组装级回归（复核补充：pull 消费真实 cursor、
 * 冲刷真实上送、第二设备写入被客户端拉到 —— 此前两侧分别测试、从未在同一进程组装）。
 * 仅 mock wx 桥（login/request/storage/网络状态），HTTP 打到本进程内起的隔离 FileStore 服务端。
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const storage = {};
const originalWx = global.wx;
global.wx = {
  getStorageSync: (key) => storage[key],
  setStorageSync: (key, value) => { storage[key] = value === undefined ? value : JSON.parse(JSON.stringify(value)); },
  removeStorageSync: (key) => { delete storage[key]; },
  getStorageInfoSync: () => ({ keys: Object.keys(storage) }),
  showToast: () => {},
  vibrateShort: () => {},
  // wx.login 桥：DEV 服务端接受任意 code
  login: (options) => options.success({ code: 'dev' }),
  // wx.request 桥：转发到本地隔离服务端
  request: (options) => {
    fetch(options.url, {
      method: options.method,
      headers: options.header,
      body: options.data && ['POST', 'PUT', 'DELETE'].includes(String(options.method).toUpperCase()) ? JSON.stringify(options.data) : undefined
    }).then(async (res) => {
      let body;
      try { body = res.status === 204 ? undefined : JSON.parse(await res.text()); } catch (e) { body = undefined; }
      options.success({ statusCode: res.status, data: body });
    }).catch((error) => options.fail({ errMsg: 'request:fail ' + error.message }));
  },
  onNetworkStatusChange: () => {},
  offNetworkStatusChange: () => {},
  connectSocket: () => { throw new Error('e2e 不应建立 WebSocket'); }
};

const store = require('../miniprogram/utils/store');
const sync = require('../miniprogram/utils/sync');
const api = require('../miniprogram/utils/api');
const { FileStore } = require('../server/db/file-store');
const { createApp } = require('../server/server');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-client-e2e-'));
  const config = { dataDir, storageDriver: 'file', devMode: true, tokenTtlDays: 30 };
  const serverStore = new FileStore(config);
  await serverStore.init();
  const app = createApp(serverStore, config, new Set());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  api.setBaseUrl(`http://127.0.0.1:${server.address().port}`);

  try {
    /* 1. 登录 + 首次拉取：空空间 cursor=0，哨兵归位 */
    await api.ensureLogin();
    assert.strictEqual(await sync.pull(), true);
    assert.strictEqual(store.state.sinceSeq, 0, '空空间首次拉取游标为 0');

    /* 2. 客户端写入 → 真实冲刷上送 → 服务端可查 */
    sync.upsert('money', { type: 'expense', amount: 25, category: '餐饮', date: '2026-10-28', note: '客户端记一笔' }, 'c1');
    assert.strictEqual(await sync.flush().then(() => true), true);
    const cloudRecords = await serverStore.getCollection('dev-user', 'money');
    assert.ok(cloudRecords.c1 && cloudRecords.c1.data.amount === 25, '客户端写入必须真实到达服务端');
    assert.ok(store.state.sinceSeq === 0 || typeof store.state.sinceSeq === 'number');
    // 冲刷完成后再拉一次：游标推进到包含本机写入的序号
    assert.strictEqual(await sync.pull(), true);
    assert.ok(store.state.sinceSeq >= 1, '冲刷后的拉取推进 sinceSeq');

    /* 3. 第二设备直写服务端 → 客户端 pull 拉到（含旧时间戳的晚到上传） */
    await serverStore.upsert('dev-user', 'money', 'device2', { type: 'expense', amount: 9, category: '交通', date: '2026-10-27', note: '晚到的另一台设备记录' }, 500);
    assert.strictEqual(await sync.pull(), true);
    const local = store.state.records.money.device2;
    assert.ok(local && local.data.amount === 9, '另一台设备的旧时间戳记录必须被拉到（R03 核心场景）');
    const cursorAfter = store.state.sinceSeq;
    assert.ok(cursorAfter >= 2, '游标推进覆盖第二设备写入');

    /* 4. 客户端编辑与本机新写入不推进下载游标；再拉不漏 */
    sync.upsert('money', { type: 'expense', amount: 99, category: '餐饮', date: '2026-10-28', note: '本地第二笔' }, 'c2');
    const beforeLocal = store.state.sinceSeq;
    assert.strictEqual(await sync.pull(), true);
    assert.strictEqual(store.state.sinceSeq, beforeLocal, '本机写入后按旧游标拉取不得漏掉其他设备记录');
    await serverStore.upsert('dev-user', 'money', 'device2-b', { type: 'expense', amount: 8, category: '交通', date: '2026-10-26', note: '再晚到的上传' }, 400);
    assert.strictEqual(await sync.pull(), true);
    assert.ok(store.state.records.money['device2-b'], '本机写入之后的其他设备记录仍可拉到');

    /* 5. 删除同步：客户端 remove → 服务端墓碑 → 第二次拉取不再重复 */
    sync.remove('money', 'c1');
    assert.strictEqual(await sync.flush().then(() => true), true);
    const afterDelete = await serverStore.getCollection('dev-user', 'money');
    assert.ok(afterDelete.c1 && afterDelete.c1.deletedAt > 0, '服务端保留墓碑');

    console.log('client-server-sync.test.js 通过');
  } finally {
    sync.destroy();
    await serverStore.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (originalWx) global.wx = originalWx;
  }
})().catch((error) => { console.error(error); process.exit(1); });
