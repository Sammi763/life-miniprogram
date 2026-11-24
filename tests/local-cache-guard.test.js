/*
 * 本机缓存体量保护与全局异常捕获回归。
 * 背景：微信单个 storage key 上限 1MB（官方 wx.setStorageSync 文档）。store 把 9 个集合的
 * 全量快照写进同一个 key，超限后 setStorageSync 会抛错 —— 过去只 console.error，用户无感知。
 * 这里锁住：写失败必须被记录并通知页面、超限前先做无损瘦身、重建本机缓存不得丢掉未上送队列。
 */
const assert = require('assert');
const { BUILD_VERSION } = require('../miniprogram/config/build');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const storage = {};
let failWrite = false;
const infoLogs = [];
const errorLogs = [];
const originalInfo = console.info;
const originalError = console.error;

global.wx = {
  getStorageSync: (key) => storage[key],
  setStorageSync: (key, value) => {
    if (failWrite) { const error = new Error('setStorageSync:fail exceed storage max size'); error.errMsg = 'setStorageSync:fail exceed storage max size'; throw error; }
    storage[key] = value;
  },
  removeStorageSync: (key) => { delete storage[key]; }
};

const store = require('../miniprogram/utils/store');

function seedRecord(collection, id, data, updatedAt) {
  store.state.records[collection][id] = { id, data, updatedAt };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.info = (...args) => infoLogs.push(args.join(' '));
  console.error = (...args) => errorLogs.push(args.join(' '));
  try {
    // ---- 1. 写入失败必须被记录并通知页面 ----
    failWrite = true;
    let notified = 0;
    const unsubscribe = store.subscribe(() => { notified++; });
    seedRecord('money', 'm1', { amount: 12, date: '2026-09-24' }, Date.now());
    store.persist();
    await wait(320);
    assert.ok(store.state.persistError, '写入失败后 persistError 必须非空，页面才能提示用户');
    assert.match(store.state.persistError, /本机缓存写入失败/);
    assert.match(store.state.persistError, /导出备份后重建本机缓存/, '提示必须给出可执行的下一步');
    assert.ok(notified >= 1, '写入失败必须触发订阅通知，否则页面永远看不到');
    assert.ok(store.state.persistSize > 0, '即使写失败也应记录体积，便于用户判断问题');

    // ---- 2. 恢复后可写，错误状态自动清除 ----
    failWrite = false;
    store.persist();
    await wait(320);
    assert.strictEqual(store.state.persistError, '', '恢复写入后必须清除错误状态');
    assert.ok(storage.wb_life_state, '成功写入后 storage 中应有快照');
    assert.strictEqual(JSON.stringify(storage.wb_life_state.records.money.m1.data).includes('12'), true);

    // ---- 3. 未过保留窗口的墓碑不清理，过期的才清理 ----
    const now = Date.now();
    seedRecord('shopping', 'fresh-tombstone', { name: 'x' }, now - 1000);
    store.state.records.shopping['fresh-tombstone'].deletedAt = now - 1000;
    seedRecord('shopping', 'old-tombstone', { name: 'y' }, now - 30 * 24 * 3600 * 1000);
    store.state.records.shopping['old-tombstone'].deletedAt = now - 30 * 24 * 3600 * 1000;
    store.pruneTombstones();
    assert.strictEqual(Boolean(store.state.records.shopping['fresh-tombstone']), true, '窗口内的墓碑应保留，避免旧写入回灌');
    assert.strictEqual(Boolean(store.state.records.shopping['old-tombstone']), false, '远超窗口的墓碑应被清理');
    assert.ok(store.state.prunedCount >= 1);

    // ---- 4. 超过阈值时自动做无损瘦身 ----
    const stale = now - 30 * 24 * 3600 * 1000;
    for (let i = 0; i < 500; i++) {
      const id = 'bulk-' + i;
      seedRecord('memories', id, { content: 'x'.repeat(2000) }, stale + i);
      store.state.records.memories[id].deletedAt = stale + i;
    }
    assert.ok(store.localCacheChars() > store.MAX_PERSIST_CHARS, '构造的数据应超过持久化阈值');
    const before = Object.keys(store.state.records.memories).length;
    store.persist();
    await wait(320);
    const after = Object.keys(store.state.records.memories).length;
    assert.ok(after < before, '超限前应先清理过期墓碑（无损瘦身），实际 ' + before + ' -> ' + after);
    assert.strictEqual(store.state.persistError, '', '瘦身后应能正常写入');

    // ---- 5. 重建本机缓存：legacy 兜底仍保留（清记录、回退 since、不丢队列）；页面入口走原子重建 ----
    store.state.since = 123456;
    store.state.queue.push({ type: 'put', collection: 'money', id: 'queued-1', data: { amount: 1 }, updatedAt: 999 });
    const queuedBefore = store.state.queue.length;
    store.rebuildCache();
    let totalRecords = 0;
    for (const collection of store.COLLECTIONS) totalRecords += Object.keys(store.state.records[collection]).length;
    assert.strictEqual(totalRecords, 0, '重建后本机记录应为空，等待全量重拉');
    assert.strictEqual(store.state.since, 0, 'since 必须回退到 0，否则增量拉取补不回被清掉的记录');
    assert.strictEqual(store.state.queue.length, queuedBefore, '未上送的队列绝不能丢');
    assert.strictEqual(store.state.persistError, '');

    // ---- 6. 页面契约：「我的」页有入口与提示位；重建走 sync.rebuild 原子路径（失败保留旧缓存） ----
    const mineWxml = read('miniprogram/pages/mine/mine.wxml');
    const mineJs = read('miniprogram/pages/mine/mine.js');
    assert.match(mineWxml, /bindtap="rebuildLocalCache"/, '「我的」页必须提供重建本机缓存入口');
    assert.match(mineWxml, /\{\{cacheText\}\}/, '应展示本机缓存占用，用户才判断得出是否异常');
    assert.match(mineWxml, /\{\{cacheError\}\}/, '写入失败必须能在页面上看到');
    assert.match(mineJs, /sync\.rebuild\(\)/, '页面重建必须走原子重建（先拉取校验再换装）');
    assert.match(mineJs, /s\.persistSize/, '占用体积应取实测值，不要每次渲染重新序列化全量数据');
    const appWxss = read('miniprogram/app.wxss');
    assert.match(appWxss, /\.notice-warn\s*\{/, '需要全局的警示样式');

    // ---- 6b. 切后台兜底：App.onHide 必须立即落盘，不能等 250ms 防抖（进程被杀会丢） ----
    assert.match(read('miniprogram/app.js'), /persistNow\(\)/, 'App.onHide 必须同步落盘');

    // ---- 7. 全局异常捕获：本地留痕、打码、不外传 ----
    const appSource = read('miniprogram/app.js');
    assert.match(appSource, /onError\s*\(/, '缺少 onError，线上 JS 异常无人知晓');
    assert.match(appSource, /onUnhandledRejection\s*\(/, '缺少 onUnhandledRejection');
    assert.match(appSource, /token=.*\*\*\*|\(token=\)/, '异常文本必须给 token 打码');
    assert.match(appSource, /code=/, '异常文本必须给 code 打码');
    assert.doesNotMatch(appSource, /wx\.request|wx\.uploadFile|reportError/, '异常不得上报远端，与隐私政策一致');

    let appDefinition;
    const originalApp = global.App;
    const originalGetCurrentPages = global.getCurrentPages;
    try {
      global.App = (definition) => { appDefinition = definition; };
      global.getCurrentPages = () => [{ route: 'pages/mine/mine', data: {} }];
      delete require.cache[require.resolve('../miniprogram/app.js')];
      require('../miniprogram/app.js');
    } finally {
      global.App = originalApp;
      global.getCurrentPages = originalGetCurrentPages;
    }
    const appInstance = { globalData: {}, ...appDefinition };
    // 冷启动登录校验期间，切后台不能使用尚未载入缓存的空状态回写。
    store.resetLocal();
    const pending = { type: 'put', collection: 'memories', id: 'draft', data: { content: '旧版离线随记' }, updatedAt: 1 };
    const snapshot = {
      records: { memories: { draft: { id: 'draft', data: pending.data, updatedAt: 1 } } },
      since: 0,
      queue: [pending],
      rejectedWrites: [{ item: pending, statusCode: 422 }]
    };
    storage.wb_life_state = JSON.parse(JSON.stringify(snapshot));
    appInstance.onHide();
    assert.deepStrictEqual(storage.wb_life_state, snapshot, '未读入快照前切后台应保留旧版内容');
    store.loadLocal();
    store.applyLocalUpsert('memories', { id: 'last', data: { content: '最后一笔' }, updatedAt: 2 });
    appInstance.onHide();
    assert.strictEqual(storage.wb_life_state.records.memories.last.data.content, '最后一笔');
    const savedSnapshot = storage.wb_life_state;
    appInstance.onHide();
    assert.strictEqual(storage.wb_life_state, savedSnapshot, '快照无变更时无需重写');

    appInstance.onError({ message: 'connectSocket:fail url wss://h/ws?token=SECRET-TOKEN-abcdef' });
    assert.ok(appInstance.globalData.clientIssue, '异常应写入 globalData 供页面展示');
    assert.strictEqual(appInstance.globalData.clientIssue.kind, 'onError');
    assert.strictEqual(appInstance.globalData.clientIssue.text.includes('SECRET-TOKEN-abcdef'), false, '日志与展示都不得包含原始 token');
    assert.match(appInstance.globalData.clientIssue.text, /token=\*\*\*/);
    assert.strictEqual(appInstance.globalData.clientIssue.buildVersion, BUILD_VERSION);
    appInstance.onUnhandledRejection({ reason: { message: 'boom' } });
    assert.strictEqual(appInstance.globalData.clientIssue.kind, 'onUnhandledRejection');

    store.resetLocal();
    console.log('LOCAL_CACHE_GUARD_TEST_PASSED');
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }
}

main().catch((error) => {
  console.info = originalInfo;
  console.error = originalError;
  console.error(error);
  process.exitCode = 1;
});
