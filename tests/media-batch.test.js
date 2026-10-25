/*
 * v2.11 书影音列表分批渲染：卡片墙与列表共用首批 40 条，触底/「加载更多」按批追加；
 * 筛选 chips 变化时重置回首批；年度统计卡始终按全量计算。
 *
 * 运行：node tests/media-batch.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sync = require(path.join(root, 'miniprogram', 'utils', 'sync'));
const store = require(path.join(root, 'miniprogram', 'utils', 'store'));

function loadPage(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const originalPage = global.Page;
  let definition = null;
  global.Page = (page) => { definition = page; };
  delete require.cache[require.resolve(absolutePath)];
  require(absolutePath);
  global.Page = originalPage;
  return definition;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function assignPath(target, key, value) {
  const parts = key.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function makePage(definition) {
  return {
    ...definition,
    data: clone(definition.data),
    setData(update, callback) {
      Object.keys(update).forEach((key) => assignPath(this.data, key, update[key]));
      if (callback) callback();
    }
  };
}

(async () => {
  const originalWx = global.wx;
  global.wx = {
    showToast: () => {}, showLoading: () => {}, hideLoading: () => {},
    vibrateShort: () => {}, setNavigationBarColor: () => {}, setBackgroundColor: () => {},
    getStorageSync: () => '', setStorageSync: () => {}, removeStorageSync: () => {},
    switchTab: () => {}, navigateTo: () => {}, onNetworkStatusChange() {},
    connectSocket: () => ({ onOpen() {}, onMessage() {}, onClose() {}, onError() {}, close() {}, send() {} })
  };

  try {
    store.loadLocal();
    for (const coll of store.COLLECTIONS) store.state.records[coll] = {};

    const year = sync.fmtDate(new Date()).slice(0, 4);
    // 90 条书 + 6 条今年看完的影（统计口径基准）
    for (let i = 0; i < 90; i++) {
      store.applyLocalUpsert('media', { id: 'md-' + i, data: { kind: 'book', title: '书 ' + i, status: 'doing', rating: 0, date: year + '-01-01' }, updatedAt: 1000 + i, deletedAt: 0 });
    }
    for (let i = 0; i < 6; i++) {
      store.applyLocalUpsert('media', { id: 'mv-' + i, data: { kind: 'movie', title: '影 ' + i, status: 'done', rating: 4, date: year + '-02-01' }, updatedAt: 2000 + i, deletedAt: 0 });
    }

    const media = makePage(loadPage('miniprogram/pages/media/media.js'));
    media.render.call(media);

    assert.strictEqual(media.data.items.length, 40, '首批必须只下发 40 条（卡片墙与列表共用）');
    assert.strictEqual(media.data.hasMore, true, '还有更多时必须出现加载更多');
    assert.strictEqual(media.data.shownTotal, 96, 'shownTotal 必须是筛选后全量条数');

    // 年度统计按全量计算
    assert.strictEqual(media.data.stats.movie, 6, '年度统计必须按全量计算，不随分批裁剪');

    // 追加：40 → 80 → 96
    media.onReachBottom.call(media);
    assert.strictEqual(media.data.items.length, 80, '触底一次必须追加到 80 条');
    assert.strictEqual(media.data.hasMore, true, '未取完时 hasMore 必须为真');
    media.onReachBottom.call(media);
    assert.strictEqual(media.data.items.length, 96, '再次触底必须取完全部条目');
    assert.strictEqual(media.data.hasMore, false, '取完后不得再出现加载更多');
    assert.strictEqual(media.data.stats.movie, 6, '分批追加后年度统计必须仍是全量口径');

    // 筛选 chips 重置回首批
    media.setFilter.call(media, { currentTarget: { dataset: { kind: 'movie' } } });
    assert.strictEqual(media.data.filter, 'movie', '必须切到影分类');
    assert.strictEqual(media.data.items.length, 6, '筛选后不足一批时只下发实际条数');
    assert.strictEqual(media.data.hasMore, false, '筛选结果不足一批时不得出现加载更多');

    media.setStatusFilter.call(media, { currentTarget: { dataset: { status: 'done' } } });
    assert.strictEqual(media.data.items.length, 6, '状态筛选叠加后仍按实际条数下发');
    media.setStatusFilter.call(media, { currentTarget: { dataset: { status: 'done' } } });
    media.setFilter.call(media, { currentTarget: { dataset: { kind: '' } } });
    assert.strictEqual(media.data.items.length, 40, '清除筛选必须重置回首批 40 条');

    // wxml：加载更多入口
    const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/media/media.wxml'), 'utf8');
    assert.match(wxml, /bindtap="loadMore"/, 'media 必须提供加载更多按钮');
  } finally {
    global.wx = { getStorageSync: () => '', setStorageSync: () => {}, removeStorageSync: () => {} };
  }

  console.log('MEDIA_BATCH_TEST_PASSED');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
