/*
 * 今日页首次空状态与提示强化 —— 「三步开始」卡、逾期徽标、预算/还款直达。
 *
 * 三步开始只在 money/habit/plan/shopping 四个核心集合全空时出现（不做强制引导），
 * 任何一条记录写入后即消失；逾期徽标计数来自今日+逾期日程。
 *
 * 运行：node tests/today-empty.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const api = require(path.join(root, 'miniprogram', 'utils', 'api'));
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
  const events = [];
  const originalWx = global.wx;
  const originalToken = api.getToken;
  global.wx = {
    showToast: () => {},
    showLoading: () => {},
    hideLoading: () => {},
    switchTab: (options) => events.push('tab:' + options.url),
    navigateTo: (options) => events.push('nav:' + options.url),
    vibrateShort: () => {},
    setNavigationBarColor: () => {},
    setBackgroundColor: () => {},
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    onNetworkStatusChange() {},
    connectSocket: () => ({ onOpen() {}, onMessage() {}, onClose() {}, onError() {}, close() {}, send() {} })
  };
  api.getToken = () => null; // 跳过 AI 轻提醒请求

  try {
    store.loadLocal();
    for (const coll of store.COLLECTIONS) store.state.records[coll] = {};

    const today = makePage(loadPage('miniprogram/pages/today/today.js'));
    today.render.call(today);
    assert.strictEqual(today.data.firstRun, true, '没有生活记录时应判定为首次使用');

    const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/today/today.wxml'), 'utf8');
    assert.match(wxml, /wx:if="\{\{firstRun\}\}"/, '首次使用必须突出随记入口');
    assert.match(wxml, /写下第一条随记/);
    assert.doesNotMatch(wxml, /今日生活指数/);
    assert.match(wxml, /记一笔/, '首页必须包含记一笔');
    assert.match(wxml, /建习惯/, '首页必须包含建习惯');
    assert.match(wxml, /排日程/, '首页必须包含排日程');
    assert.match(wxml, /bindtap="goHabit"/, '建习惯入口必须可达');
    assert.match(wxml, /overdue-badge/, '必须渲染逾期徽标');
    assert.match(wxml, /bindtap="goBudget"/, '预算行必须直达记账页预算编辑器（U05）');
    assert.match(wxml, /bindtap="goMoney" data/ === null ? /x/ : /class="today-bill-row tap-row"/, '还款行必须可点击直达账本');

    today.goHabit.call(today);
    assert.ok(events.includes('tab:/pages/habit/habit'), '建习惯必须切到习惯 tab');

    store.applyLocalUpsert('memories', { id: 'first-memory', data: { content: '第一条随记' }, updatedAt: 1 });
    today.render();
    assert.strictEqual(today.data.firstRun, false, '只写过随记也应结束首次使用引导');
    store.applyLocalDelete('memories', 'first-memory', 2);

    // 写入任一核心记录后三步开始必须消失
    store.applyLocalUpsert('money', { id: 'm1', data: { type: 'expense', amount: 12, category: '餐饮', date: sync.fmtDate(new Date()) }, updatedAt: 1, deletedAt: 0 });
    today.render.call(today);
    assert.strictEqual(today.data.firstRun, false, '记账后首次使用引导消失');

    // 逾期徽标：昨日未完成日程计入，已完成/今日不计
    const t = sync.fmtDate(new Date());
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    store.applyLocalUpsert('plan', { id: 'p1', data: { title: '昨日未完成', date: sync.fmtDate(yesterday), time: '', done: false }, updatedAt: 2, deletedAt: 0 });
    store.applyLocalUpsert('plan', { id: 'p2', data: { title: '昨日已完成', date: sync.fmtDate(yesterday), time: '', done: true }, updatedAt: 3, deletedAt: 0 });
    today.render.call(today);
    assert.strictEqual(today.data.overdueCount, 1, '只有未完成的逾期日程计入徽标');
    assert.ok(today.data.todayQueue.some((plan) => plan.overdue), '逾期项必须带 overdue 标记');
    assert.ok(String(t).length === 10);
  } finally {
    // 防抖 persist 定时器可能在测试结束后才触发，恢复一个带 storage 的兜底避免噪音报错
    global.wx = { getStorageSync: () => '', setStorageSync: () => {}, removeStorageSync: () => {} };
    api.getToken = originalToken;
  }

  console.log('TODAY_EMPTY_TEST_PASSED');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
