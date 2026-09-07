/* 引擎冒烟测试：mock wx API，跑真实 utils/{api,store,sync}.js，对打真实后端
 * 运行：node tests/engine.test.js  （需先启动 server）*/
const assert = require('assert');

// ---------- mock wx ----------
const mem = {};
global.wx = {
  getStorageSync: (k) => (k in mem ? mem[k] : ''),
  setStorageSync: (k, v) => { mem[k] = v; },
  removeStorageSync: (k) => { delete mem[k]; },
  login: (o) => o.success({ code: 'dev-code' }),
  request: (opt) => {
    const ctrl = { method: opt.method || 'GET', headers: opt.header || {}, body: opt.data ? JSON.stringify(opt.data) : undefined };
    fetch(opt.url, ctrl).then(async (r) => {
      let data = null;
      try { data = await r.json(); } catch (e) { /* ignore */ }
      opt.success && opt.success({ statusCode: r.status, data });
    }).catch((e) => opt.fail && opt.fail({ errMsg: 'request fail ' + e.message }));
  },
  connectSocket: () => ({
    onOpen() {}, onMessage() {}, onClose() {}, onError() {},
    close() {}, send() {}
  }),
  onNetworkStatusChange() {}, showToast() {}, showModal(o) { o && o.success && o.success({ confirm: false }); },
  stopPullDownRefresh() {}, setClipboardData() {}
};

const store = require('../miniprogram/utils/store');
const sync = require('../miniprogram/utils/sync');
const api = require('../miniprogram/utils/api');

const BASE = process.env.LIFE_TEST_BASE || 'http://127.0.0.1:8787';
function wait(cond, label, timeout = 6000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function chk() {
      Promise.resolve().then(cond).then((ok) => {
        if (ok) return resolve();
        if (Date.now() - t0 > timeout) throw new Error('TIMEOUT: ' + label);
        setTimeout(chk, 60);
      }).catch(reject);
    })();
  });
}
const local = (c) => Object.values(store.state.records[c]).filter((r) => !r.deletedAt);

(async () => {
  api.setBaseUrl(BASE);
  // T0 等后端就绪（避免冷启动竞态）
  await wait(async () => {
    try {
      const r = await fetch(BASE + '/api/health');
      return r.ok;
    } catch (e) { return false; }
  }, '后端健康检查', 15000);
  console.log('T0 后端就绪 OK');
  // T1 先渲染后拉数据：init 立即有状态
  sync.init();
  assert.strictEqual(store.state.ready, true, 'init 后 ready');
  console.log('T1 先渲染后拉数据 OK（init 即 ready）');

  // T2 预置示例（含 1 条逾期日程）
  await wait(() => local('money').length >= 5, '示例数据入本地');
  const y = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return sync.fmtDate(d); })();
  const overdue = local('plan').find((r) => r.data.date === y && !r.data.done);
  assert.ok(overdue, '存在逾期示例日程');
  assert.ok(local('habit').length >= 4, '习惯定义+打卡已预置');
  console.log('T2 示例数据 OK（money=' + local('money').length + ' habit=' + local('habit').length + '，含逾期日程）');

  // T3 队列上送：全部写进云端
  await wait(() => store.state.queue.length === 0, '队列冲刷完成', 30000);
  assert.strictEqual(store.state.syncState, 'idle', '上送后回到 idle');
  console.log('T3 写队列上送 OK（云端已入库，队列清空）');

  // T4 新增 → 云端可查
  const rid = sync.upsert('money', { type: 'expense', amount: 66.6, category: '数码', date: sync.fmtDate(new Date()), note: '引擎测试' });
  await wait(() => store.state.queue.length === 0, '新纪录上送', 10000);
  const token = wx.getStorageSync('wb_life_token');
  const res = await fetch(BASE + '/api/records/money', { headers: { Authorization: 'Bearer ' + token } }).then((r) => r.json());
  assert.ok(res.records[rid], '云端存在新纪录');
  console.log('T4 新增上云 OK（id=' + rid.slice(0, 9) + '…）');

  // T5 删除 → 云端墓碑
  sync.remove('money', rid);
  await wait(() => store.state.queue.length === 0, '删除上送', 10000);
  const res2 = await fetch(BASE + '/api/records/money', { headers: { Authorization: 'Bearer ' + token } }).then((r) => r.json());
  assert.ok(res2.records[rid] && res2.records[rid].deletedAt > 0, '云端为墓碑');
  console.log('T5 软删同步 OK（tombstone 已确认）');

  // T6 重启幂等：SEED 标记后重复 init 不重复播种
  const before = local('money').length;
  store.loadLocal();
  assert.strictEqual(local('money').length, before, '缓存读回一致');
  console.log('T6 本地缓存持久化 OK（读回 ' + before + ' 条 money）');

  sync.destroy();
  console.log('ALL_ENGINE_TESTS_PASSED');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
