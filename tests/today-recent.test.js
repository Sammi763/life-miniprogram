/*
 * v2.11 今日页「最近记录」：四类新聚合来源（习惯打卡/日程/书影音/体重）、
 * updatedAt 倒序取前 5、kind 跳转分发（money 走 storage 中转）与按压反馈。
 *
 * 运行：node tests/today-recent.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const api = require(path.join(root, 'miniprogram', 'utils', 'api'));
const sync = require(path.join(root, 'miniprogram', 'utils', 'sync'));
const store = require(path.join(root, 'miniprogram', 'utils', 'store'));
const pendingOpen = require(path.join(root, 'miniprogram', 'utils', 'pending-open'));

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
  const storage = {};
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
    getStorageSync: (key) => (key in storage ? storage[key] : ''),
    setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: (key) => { delete storage[key]; },
    onNetworkStatusChange() {},
    connectSocket: () => ({ onOpen() {}, onMessage() {}, onClose() {}, onError() {}, close() {}, send() {} })
  };
  api.getToken = () => null;

  try {
    store.loadLocal();
    for (const coll of store.COLLECTIONS) store.state.records[coll] = {};

    const today = makePage(loadPage('miniprogram/pages/today/today.js'));
    const t = sync.fmtDate(new Date());

    // ---- 四类新聚合来源 + 既有三类 ----
    const base = Date.now() - 100000;
    store.applyLocalUpsert('money', { id: 'm1', data: { type: 'expense', amount: 12, category: '餐饮', date: t, note: '午饭' }, updatedAt: base + 10, deletedAt: 0 });
    store.applyLocalUpsert('habit', { id: 'hd1', data: { kind: 'def', name: '喝水', mode: 'count', target: 8, unit: '杯' }, updatedAt: base + 1, deletedAt: 0 });
    store.applyLocalUpsert('habit', { id: 'he1', data: { kind: 'entry', habitId: 'hd1', date: t, value: 3 }, updatedAt: base + 20, deletedAt: 0 });
    store.applyLocalUpsert('plan', { id: 'p1', data: { title: '还花呗账单', date: t, time: '', done: true }, updatedAt: base + 30, deletedAt: 0 });
    store.applyLocalUpsert('media', { id: 'md1', data: { kind: 'book', title: '《小王子》', status: 'doing', rating: 4, date: t }, updatedAt: base + 40, deletedAt: 0 });
    store.applyLocalUpsert('fitness', { id: 'f1', data: { kind: 'weight', date: t, weight: 72.5 }, updatedAt: base + 50, deletedAt: 0 });
    today.render.call(today);

    const kinds = today.data.recentRecords.map((item) => item.kind);
    assert.ok(kinds.includes('habit'), '习惯打卡必须进入最近记录');
    assert.ok(kinds.includes('plan'), '日程必须进入最近记录');
    assert.ok(kinds.includes('media'), '书影音必须进入最近记录');
    assert.ok(kinds.includes('fitness'), '体重必须进入最近记录');
    assert.ok(kinds.includes('money'), '既有财务行不得回归丢失');

    const habitRow = today.data.recentRecords.find((item) => item.kind === 'habit');
    assert.ok(habitRow.title.includes('喝水') && habitRow.title.includes('3'), '习惯行标题必须是习惯名+数值');
    assert.ok(habitRow.sub.includes('习惯'), '习惯行 sub 必须带「习惯」类型标签');
    const planRow = today.data.recentRecords.find((item) => item.kind === 'plan');
    assert.strictEqual(planRow.title, '还花呗账单', '日程行标题必须是日程标题');
    assert.ok(planRow.sub.includes('日程'), '日程行 sub 必须带「日程」类型标签');
    const mediaRow = today.data.recentRecords.find((item) => item.kind === 'media');
    assert.ok(mediaRow.title.includes('《小王子》'), '书影音行标题必须含标题');
    assert.ok(mediaRow.sub.includes('书影音'), '书影音行 sub 必须带「书影音」类型标签');
    const fitnessRow = today.data.recentRecords.find((item) => item.kind === 'fitness');
    assert.ok(String(fitnessRow.title).includes('72.5'), '体重行标题必须是体重值');
    assert.ok(fitnessRow.sub.includes('体重'), '体重行 sub 必须带「体重」类型标签');

    // ---- updatedAt 倒序取前 5 ----
    assert.strictEqual(today.data.recentRecords.length, 5, '最近记录必须只取前 5 条');
    assert.strictEqual(today.data.recentRecords[0].kind, 'fitness', 'updatedAt 最大的体重记录必须排第一');

    // ---- 既有待买/随记来源不回归（以更新的时间戳进入前 5）----
    store.applyLocalUpsert('shopping', { id: 'sp1', data: { name: '咖啡豆 250g', done: false }, updatedAt: base + 100, deletedAt: 0 });
    store.applyLocalUpsert('memories', { id: 'mm1', data: { content: '今晚风很舒服', occurredAt: t + 'T21:00' }, updatedAt: base + 90, deletedAt: 0 });
    today.render.call(today);
    const kinds2 = today.data.recentRecords.map((item) => item.kind);
    assert.ok(kinds2.includes('shopping') && kinds2.includes('memory'), '待买与随记必须继续进入最近记录');
    assert.strictEqual(today.data.recentRecords[0].kind, 'shopping', 'updatedAt 倒序必须仍然成立');

    // ---- 重复日程的完成记录（occurrence，自身无 title）必须借系列标题进入最近记录 ----
    store.applyLocalUpsert('plan', { id: 'ps1', data: { kind: 'series', title: '每周复盘', startDate: t, time: '', repeat: 'weekly' }, updatedAt: base + 60, deletedAt: 0 });
    store.applyLocalUpsert('plan', { id: 'po1', data: { kind: 'occurrence', seriesId: 'ps1', date: t, done: true, skipped: false }, updatedAt: base + 80, deletedAt: 0 });
    // 孤儿 occurrence（系列已不存在）：无标题可展示，必须整体跳过而不是渲染成空标题行
    store.applyLocalUpsert('plan', { id: 'po2', data: { kind: 'occurrence', seriesId: 'gone', date: t, done: true, skipped: false }, updatedAt: base + 95, deletedAt: 0 });
    today.render.call(today);
    const occurrenceRow = today.data.recentRecords.find((item) => item.id === 'po1');
    assert.ok(occurrenceRow, '重复日程的完成记录必须进入最近记录（借系列标题展示）');
    assert.strictEqual(occurrenceRow.title, '每周复盘', 'occurrence 行标题必须取自其重复源系列');
    assert.ok(occurrenceRow.sub.includes('日程'), 'occurrence 行 sub 必须带「日程」类型标签');
    assert.strictEqual(occurrenceRow.navId, 'ps1', 'occurrence 行的跳转目标必须是系列 id（单日覆盖记录不可直接编辑）');
    assert.ok(!today.data.recentRecords.some((item) => item.id === 'po2'), '无系列可借标题的孤儿 occurrence 必须整体跳过');

    // ---- 跳转分发 ----
    const tapEvent = (kind) => ({ currentTarget: { dataset: { kind, id: 'x1' } } });
    today.onRecentTap.call(today, tapEvent('money'));
    assert.ok(events.includes('tab:/pages/money/money'), 'money 行必须 switchTab 到记账页');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(storage[pendingOpen.PENDING_OPEN_KEY])), { kind: 'money', id: 'x1', action: '', at: storage[pendingOpen.PENDING_OPEN_KEY].at }, 'money 行必须写入 pending-open 中转意图（浏览入口不带 action）');

    today.onRecentTap.call(today, tapEvent('memory'));
    assert.ok(events.includes('nav:/pages/memory/memory?id=x1'), 'memory 行必须跳随记页');
    today.onRecentTap.call(today, tapEvent('shopping'));
    assert.ok(events.includes('nav:/pages/shopping/shopping?id=x1'), 'shopping 行必须跳待买页');
    today.onRecentTap.call(today, tapEvent('plan'));
    assert.ok(events.includes('nav:/pages/plan/plan?id=x1'), 'plan 行必须跳日程页');
    today.onRecentTap.call(today, { currentTarget: { dataset: { kind: 'plan', id: 'po1', navId: 'ps1' } } });
    assert.ok(events.includes('nav:/pages/plan/plan?id=ps1'), 'occurrence 行必须跳转到系列编辑而非单日覆盖记录');
    today.onRecentTap.call(today, tapEvent('media'));
    assert.ok(events.includes('nav:/pages/media/media?id=x1'), 'media 行必须跳书影音页');
    today.onRecentTap.call(today, tapEvent('fitness'));
    assert.ok(events.includes('nav:/pages/fitness/fitness?id=x1'), 'fitness 行必须跳健身页');
    today.onRecentTap.call(today, tapEvent('habit'));
    assert.ok(events.includes('tab:/pages/habit/habit'), 'habit 行必须 switchTab 到习惯页');

    // ---- pending-open 中转复用：search 与 money 消费同一套 ----
    pendingOpen.setPendingOpen('money', 'mm-9');
    assert.strictEqual(pendingOpen.consumePendingOpen('habit'), '', 'kind 不匹配时不得取走意图');
    assert.strictEqual(pendingOpen.consumePendingOpen('money'), 'mm-9', 'kind 匹配时必须返回记录 id');
    assert.strictEqual(pendingOpen.consumePendingOpen('money'), '', '意图消费后必须清除');

    const searchPage = makePage(loadPage('miniprogram/pages/search/search.js'));
    searchPage.data.results = [{ id: 'ss-1', kind: 'money', title: '午饭' }];
    searchPage.openResult.call(searchPage, { currentTarget: { dataset: { kind: 'money', id: 'ss-1' } } });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(storage[pendingOpen.PENDING_OPEN_KEY])), { kind: 'money', id: 'ss-1', action: pendingOpen.ACTIONS.SEARCH, at: storage[pendingOpen.PENDING_OPEN_KEY].at }, '搜索页必须经 pending-open 写入同一中转键');
    assert.ok(events.includes('tab:/pages/money/money'), '搜索页 money 结果必须 switchTab');

    const moneyPage = makePage(loadPage('miniprogram/pages/money/money.js'));
    let openedEdit = '';
    moneyPage.openEditById = (id) => { openedEdit = id; };
    moneyPage.consumePendingOpen();
    assert.strictEqual(openedEdit, 'ss-1', 'money onShow 必须消费中转意图并打开对应流水');
    assert.strictEqual(moneyPage.data.returnSearch, true, '从搜索进入时保留返回入口');

    // ---- wxml 结构：tap 事件 + 按压反馈 ----
    const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/today/today.wxml'), 'utf8');
    assert.match(wxml, /recent-row[^>]*bindtap="onRecentTap"/, 'recent-row 必须绑定 onRecentTap');
    assert.match(wxml, /recent-row[^>]*hover-class="tap-pressed"/, 'recent-row 必须带按压反馈');
    assert.match(wxml, /data-kind="\{\{item.kind\}\}"/, 'recent-row 必须下发 kind');
  } finally {
    global.wx = { getStorageSync: () => '', setStorageSync: () => {}, removeStorageSync: () => {} };
    api.getToken = originalToken;
  }

  console.log('TODAY_RECENT_TEST_PASSED');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
