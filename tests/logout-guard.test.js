/*
 * 退出账号保护流程回归（R01/R07）。
 * 锁住三件事：
 * 1) 有未同步/被拒/持久化错误时，普通退出必须先进入保护流程（同步尝试 → 导出副本 → 知情确认）；
 * 2) 「导出副本」在导出成功前不得执行退出，导出失败不得退出；
 * 3) 真正执行退出时清理范围与文案一致：队列、草稿、搜索历史一并清除，且不再有本地独有内容时才直接确认。
 */
const assert = require('assert');
const path = require('path');

const storage = {};
const modals = [];
const toasts = [];
const cloned = [];
const reLaunch = [];
const removedFiles = [];
let modalAnswer = { confirm: true };
let clipboardFail = false;

const originalWx = global.wx;
global.wx = {
  getStorageSync: (key) => storage[key],
  setStorageSync: (key, value) => { storage[key] = value; },
  removeStorageSync: (key) => { delete storage[key]; },
  getStorageInfoSync: () => ({ keys: Object.keys(storage) }),
  env: { USER_DATA_PATH: '/test/user-data' },
  getFileSystemManager: () => ({
    readdirSync: () => ['life-backup-2026-11-23.json', 'other-backup.json'],
    unlinkSync: (filePath) => removedFiles.push(filePath)
  }),
  showToast: (options) => toasts.push(options.title),
  showModal: (options) => {
    modals.push({ title: options.title, content: options.content, confirmText: options.confirmText });
    if (options.success) options.success({ confirm: typeof modalAnswer === 'function' ? modalAnswer(options) : Boolean(modalAnswer.confirm) });
  },
  setClipboardData: (options) => {
    if (clipboardFail) { if (options.fail) options.fail({}); return; }
    cloned.push(options.data);
    if (options.success) options.success();
  },
  reLaunch: (options) => reLaunch.push(options.url),
  showLoading: () => {},
  hideLoading: () => {},
  clearStorageSync() {},
  vibrateShort() {}
};

const store = require('../miniprogram/utils/store');
const backup = require('../miniprogram/utils/backup');
const sync = require('../miniprogram/utils/sync');
const mineModule = path.resolve(__dirname, '../miniprogram/pages/mine/mine.js');

let definition;
const originalPage = global.Page;
global.Page = (page) => { definition = page; };
delete require.cache[require.resolve(mineModule)];
require(mineModule);
global.Page = originalPage;

function assignPath(target, key, value) {
  const keys = key.split('.');
  let current = target;
  keys.slice(0, -1).forEach((part) => { current[part] = current[part] || {}; current = current[part]; });
  current[keys[keys.length - 1]] = value;
}
const page = {
  ...definition,
  data: JSON.parse(JSON.stringify(definition.data)),
  setData(update) { Object.keys(update).forEach((key) => assignPath(this.data, key, update[key])); }
};

function resetAll() {
  for (const key of Object.keys(storage)) delete storage[key];
  store.resetLocal({ keepAuxiliary: true });
  page.__lastTapAt = {}; // isRepeatedTap 的节流时间戳不跨测试块残留
  page.__logoutAttempt = null;
  modals.length = 0;
  toasts.length = 0;
  cloned.length = 0;
  reLaunch.length = 0;
  removedFiles.length = 0;
  modalAnswer = { confirm: true };
  clipboardFail = false;
}

/* 把 mine.js 依赖的同步引擎替换为受控行为：flush/pull 结果可控，绝不触网 */
let flushBehavior = () => Promise.resolve();
let pullBehavior = () => Promise.resolve(true);
const originalFlush = sync.flush;
const originalPull = sync.pull;
sync.flush = (...args) => flushBehavior(...args);
sync.pull = (...args) => pullBehavior(...args);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  try {
    /* ---- 干净状态：直接进入普通确认框，一次确认即退出 ---- */
    resetAll();
    page.logout.call(page);
    assert.strictEqual(modals.length, 1, '干净状态直接给退出确认框');
    assert.match(modals[0].content, /随记和记账草稿/, '退出文案必须如实列出清理范围（含随记与记账草稿）');
    assert.match(modals[0].content, /临时跳转记录/, '退出文案必须提到临时跳转记录，和实际清理范围一致');
    // modal mock 默认 confirm:true，confirmLogout 的 success 回调已执行 performLogout
    assert.deepStrictEqual(reLaunch, ['/pages/login/login'], '确认后执行退出');
    assert.deepStrictEqual(removedFiles, ['/test/user-data/life-backup-2026-11-23.json'], '只清理旧体验版留下的备份副本');

    /* ---- 有未同步写入（在线）：先自动同步，同步成功后走普通退出 ---- */
    resetAll();
    storage['wb_life_memory_draft_new'] = { content: 'x', occurredAt: '2026-10-27T10:00', savedAt: 1 };
    storage['wb_life_money_form_draft'] = { amount: '12', savedAt: 1 };
    storage['wb_life_money_recent'] = { category: '餐饮', accountId: '' };
    store.enqueue({ type: 'put', collection: 'money', id: 'm1', data: {}, updatedAt: 1 });
    flushBehavior = () => { store.state.queue = []; store.persistQueue(); return Promise.resolve(); };
    page.logout.call(page);
    assert.ok(!reLaunch.length, '同步进行中不得直接退出');
    await wait(20);
    assert.strictEqual(modals.length, 1, '同步完成后应给出普通退出确认框');
    assert.match(modals[0].title, /退出当前账号/);
    // confirmLogout 的 success 回调（confirm:true）已执行 performLogout
    assert.deepStrictEqual(reLaunch, ['/pages/login/login']);
    assert.strictEqual(storage['wb_life_memory_draft_new'], undefined, '退出后随记草稿被清除（与文案一致）');
    assert.strictEqual(storage['wb_life_money_form_draft'], undefined, '退出后记账草稿被清除（与文案一致）');
    assert.strictEqual(storage['wb_life_money_recent'], undefined, '退出后「上次分类/账户」被清除');
    assert.strictEqual(storage['wb_life_queue'], undefined, '退出后队列快照被清除');

    /* ---- 有被拒写入（唯一副本）：保护流程 → 导出副本 → 「仍要退出」知情确认 → 才执行 ---- */
    resetAll();
    const pendingDelete = { type: 'del', collection: 'money', id: 'm1', updatedAt: 1 };
    const localMemory = { content: '本机唯一的修改', occurredAt: '2026-11-24T10:00' };
    const rejected = { type: 'put', collection: 'memories', id: 'm2', data: localMemory, updatedAt: 2 };
    store.enqueue(pendingDelete);
    store.recordRejectedWrite({ item: rejected, statusCode: 422, code: 'bad_memories' });
    const cloudMemory = { ...localMemory, content: '另一设备已同步的版本' };
    store.applyLocalUpsert('memories', { id: 'm2', data: cloudMemory, updatedAt: 3 }, { fromServer: true });
    flushBehavior = () => Promise.reject(new Error('offline'));
    pullBehavior = () => Promise.resolve(false);
    page.logout.call(page);
    await wait(20);
    const guard = modals.find((modal) => /只保存在本机/.test(modal.title));
    assert.ok(guard, '同步后仍有本机独有内容时必须进入保护流程');
    assert.match(guard.content, /未能保存到账号/, '保护文案必须点明保存失败');
    assert.match(guard.content, /等待保存到账号/, '保护文案必须点明等待保存的改动');
    assert.strictEqual(guard.confirmText, '导出副本', '保护弹窗的主操作是导出副本');
    // guard 确认（confirm:true）→ 自动导出副本 → 第二个弹窗「仍要退出」（confirm:true）→ 执行退出
    assert.strictEqual(cloned.length, 1, '导出副本写入剪贴板');
    const snapshot = JSON.parse(cloned[0]);
    assert.strictEqual(snapshot.version, 1);
    assert.deepStrictEqual(snapshot.records.memories[0].data, cloudMemory);
    assert.deepStrictEqual(snapshot.localWrites.pending, [pendingDelete]);
    assert.deepStrictEqual(snapshot.localWrites.rejected[0].item, rejected);
    assert.strictEqual(snapshot.localWrites.rejected[0].code, 'bad_memories');
    const parsed = backup.parseBackup(cloned[0]);
    assert.deepStrictEqual(parsed.backup.localWrites, snapshot.localWrites);
    const preview = backup.previewImport(parsed.backup);
    assert.deepStrictEqual(preview.creates.map((item) => item.data.content), [cloudMemory.content]);
    page.setData({ importText: cloned[0] });
    page.parseImport();
    assert.strictEqual(page.data.importPreview.localWriteCount, 2);
    page.copyImportLocalWrites();
    assert.deepStrictEqual(JSON.parse(cloned[1]), snapshot.localWrites);
    const finalConfirm = modals.find((modal) => modal.confirmText === '仍要退出');
    assert.ok(finalConfirm, '导出成功后必须再确认一次「仍要退出」');
    assert.match(finalConfirm.content, /将被清除/, '知情文案必须说明未同步内容将被清除');
    assert.deepStrictEqual(reLaunch, ['/pages/login/login'], '知情确认后执行退出');
    assert.strictEqual(store.state.queue.length, 0, '退出后队列清空（用户已知情选择放弃）');
    assert.strictEqual(store.state.rejectedWrites.length, 0, '退出后被拒写入清空（用户已知情选择放弃）');

    /* ---- 导出失败：不得退出 ---- */
    resetAll();
    store.enqueue({ type: 'put', collection: 'money', id: 'm1', data: {}, updatedAt: 1 });
    clipboardFail = true;
    page.exportCopyThenLogout.call(page);
    assert.ok(toasts.some((text) => /复制失败/.test(text)), '导出失败必须提示');
    assert.ok(!reLaunch.length, '导出失败不得退出');

    resetAll();
    store.enqueue({ type: 'put', collection: 'money', id: 'm1', data: {}, updatedAt: 1 });
    store.state.syncState = 'offline';
    modalAnswer = { confirm: false };
    page.logout();
    page.__lastTapAt = {};
    modalAnswer = (options) => options.confirmText !== '仍要退出';
    page.logout();
    page.__lastTapAt = {};
    modalAnswer = { confirm: true };
    clipboardFail = true;
    page.logout();
    page.__lastTapAt = {};
    clipboardFail = false;
    page.logout();
    assert.equal(modals.filter((modal) => modal.confirmText === '导出副本').length, 4);
    assert.deepStrictEqual(reLaunch, ['/pages/login/login'], '取消两层弹窗或复制失败后都可以重试');

    /* 安静保存时不显示同步状态，写入被拒时仍提供入口。 */
    resetAll();
    const pending = { type: 'put', collection: 'money', id: 'm1', data: {}, updatedAt: 1 };
    store.enqueue(pending);
    page.render();
    assert.strictEqual(page.data.pendingCount, undefined);
    assert.strictEqual(page.data.rejectedCount, 0);
    assert.strictEqual(page.data.cacheError, '');
    store.recordRejectedWrite({ item: pending, statusCode: 422 });
    page.render();
    assert.strictEqual(page.data.rejectedCount, 1);
    assert.match(page.data.rejectedText, /未保存到账号/);

    console.log('logout-guard.test.js 通过');
  } finally {
    sync.flush = originalFlush;
    sync.pull = originalPull;
    if (originalWx) global.wx = originalWx;
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
