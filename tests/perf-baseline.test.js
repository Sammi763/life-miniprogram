/*
 * 性能基线（性能方案 §5）：可重复的 JS 侧渲染基线。
 * 环境：Node（非真机、非开发者工具）、内存 wx mock、固定合成数据。
 * 确定性断言（不依赖时序、CI 稳定）：
 *   1) 数据未变时重复 render 零 setData（diffSetData 值守卫）；
 *   2) 同步状态变化走 renderSyncState，载荷远小于整页（< 800 字符）；
 *   3) 隐藏页收到无关集合通知不渲染、不 setData；
 *   4) 派生数据缓存：相关集合未变时 render 复用缓存（通过计数器观测）。
 * 计时数据仅作为记录输出（Node 与真机不可比），不用于断言；真机指标必须另行实测。
 */
const assert = require('assert');
const path = require('path');

const storage = {};
const originalWx = global.wx;
global.wx = {
  getStorageSync: (key) => storage[key],
  setStorageSync: (key, value) => { storage[key] = value; },
  removeStorageSync: (key) => { delete storage[key]; },
  getStorageInfoSync: () => ({ keys: Object.keys(storage) }),
  showToast: () => {},
  vibrateShort: () => {}
};

const store = require('../miniprogram/utils/store');
const sync = require('../miniprogram/utils/sync');

function loadPage(name) {
  const target = path.resolve(__dirname, '../miniprogram/pages/' + name + '/' + name + '.js');
  const originalPage = global.Page;
  let definition;
  global.Page = (page) => { definition = page; };
  delete require.cache[require.resolve(target)];
  require(target);
  global.Page = originalPage;
  return definition;
}

function makePage(definition, counter) {
  function assignPath(target, key, value) {
    const keys = key.split('.');
    let cur = target;
    for (let i = 0; i < keys.length - 1; i++) {
      if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = value;
  }
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) {
      counter.calls += 1;
      counter.chars += JSON.stringify(update).length;
      // diffSetData 的值守卫依赖 page.data 与渲染层一致：mock 必须真实合并
      for (const key of Object.keys(update)) assignPath(this.data, key, update[key]);
    }
  };
  return page;
}

function seed(dateText, month) {
  const money = {};
  for (let i = 0; i < 2000; i++) {
    money['m' + i] = {
      id: 'm' + i,
      data: { type: i % 5 === 0 ? 'income' : 'expense', amount: 10 + (i % 90), category: '分类' + (i % 9), date: month + '-' + String((i % 27) + 1).padStart(2, '0'), note: '流水' + i },
      updatedAt: 1000000 + i, deletedAt: 0
    };
  }
  const memories = {};
  for (let i = 0; i < 1500; i++) {
    memories['c' + i] = {
      id: 'c' + i,
      data: { content: '随记内容' + i + ' 咖啡阅读散步', occurredAt: month + '-' + String((i % 27) + 1).padStart(2, '0') + 'T' + String(i % 24).padStart(2, '0') + ':30', mood: 'calm', tags: ['日常'] },
      updatedAt: 2000000 + i, deletedAt: 0
    };
  }
  const habit = {};
  for (let i = 0; i < 20; i++) habit['d' + i] = { id: 'd' + i, data: { kind: 'def', name: '习惯' + i, mode: 'count', target: 8, unit: '次' }, updatedAt: 1, deletedAt: 0 };
  for (let i = 0; i < 1500; i++) {
    habit['e' + i] = { id: 'e' + i, data: { kind: 'entry', habitId: 'd' + (i % 20), date: dateText, value: i % 9 }, updatedAt: 3000000 + i, deletedAt: 0 };
  }
  const plan = {};
  for (let i = 0; i < 600; i++) {
    plan['p' + i] = { id: 'p' + i, data: { title: '日程' + i, date: month + '-' + String((i % 27) + 1).padStart(2, '0'), time: i % 3 ? '' : '09:00', done: i % 4 === 0 }, updatedAt: 4000000 + i, deletedAt: 0 };
  }
  const shopping = {};
  for (let i = 0; i < 400; i++) shopping['s' + i] = { id: 's' + i, data: { name: '物品' + i, done: i % 2 === 0, price: i }, updatedAt: 5000000 + i, deletedAt: 0 };
  store.state.records.money = money;
  store.state.records.memories = memories;
  store.state.records.habit = habit;
  store.state.records.plan = plan;
  store.state.records.shopping = shopping;
  store.state.records.settings = { app: { id: 'app', data: { budget: 3000 }, updatedAt: 1, deletedAt: 0 } };
}

async function main() {
  const now = new Date();
  const t = sync.fmtDate(now);
  const month = t.slice(0, 7);
  seed(t, month);

  const counter = { calls: 0, chars: 0 };
  const today = makePage(loadPage('today'), counter);
  const memory = makePage(loadPage('memory'), counter);

  const time = (fn) => { const started = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - started) / 1e6; };
  const report = {};

  /* ---- 1. today 首次渲染（冷，含派生计算） ---- */
  counter.calls = 0; counter.chars = 0;
  const todayFirstMs = time(() => today.render.call(today));
  report.todayFirst = { ms: +todayFirstMs.toFixed(1), setDataCalls: counter.calls, payloadChars: counter.chars };
  assert.ok(counter.calls > 0, '首次渲染必须产生 setData');
  assert.ok(counter.chars < 10000, '首页首屏只下发模板实际展示的数据');

  /* ---- 2. 数据未变时重复渲染：零 setData（diffSetData 值守卫，确定性断言） ---- */
  counter.calls = 0; counter.chars = 0;
  const todayRepeatMs = time(() => today.render.call(today));
  report.todayRepeat = { ms: +todayRepeatMs.toFixed(1), setDataCalls: counter.calls };
  assert.strictEqual(counter.calls, 0, '数据未变时重复 render 不得触发 setData（diffSetData 值守卫）');
  assert.strictEqual(counter.chars, 0);

  /* ---- 3. 派生缓存：相关集合未变时复用同一模型对象（身份断言，不依赖调用计数） ---- */
  let firstModel = null;
  let secondModel = null;
  const originalCompute = today.computeTodayModel;
  today.computeTodayModel = function (...args) {
    const model = originalCompute.apply(this, args);
    if (!firstModel) firstModel = model; else secondModel = model;
    return model;
  };
  today.render.call(today);
  today.render.call(today);
  today.computeTodayModel = originalCompute;
  assert.ok(firstModel && firstModel === secondModel, '数据未变时派生计算必须命中缓存（复用同一模型对象）');
  // 任一相关集合变化 → 版本号推进 → 重算出新模型
  store.applyLocalUpsert('money', { id: 'm-new', data: { type: 'expense', amount: 5, date: t }, updatedAt: Date.now() });
  let thirdModel = null;
  today.computeTodayModel = function (...args) { thirdModel = originalCompute.apply(this, args); return thirdModel; };
  today.render.call(today);
  today.computeTodayModel = originalCompute;
  assert.ok(thirdModel && thirdModel !== firstModel, '相关集合变化后派生计算必须重算');

  /* ---- 4. 同步状态变化走轻更新：载荷远小于整页 ---- */
  counter.calls = 0; counter.chars = 0;
  store.setSyncState('syncing');
  today.renderSyncState.call(today);
  assert.strictEqual(counter.calls, 0, '后台保存不应触发界面更新');
  store.setSyncState('offline');
  today.renderSyncState.call(today);
  report.syncOnly = { setDataCalls: counter.calls, payloadChars: counter.chars };
  assert.strictEqual(counter.calls, 1, '同步状态轻更新应恰好一次 setData');
  assert.ok(counter.chars < 800, '同步状态轻更新载荷必须远小于整页（实测 ' + counter.chars + ' 字符）');
  assert.ok(counter.chars < report.todayFirst.payloadChars / 4, '轻更新载荷必须明显小于整页渲染');

  store.setSyncState('idle');

  /* ---- 5. 隐藏页 dirty：无关集合通知不渲染、只标 dirty；恢复显示后由 onShow 合并刷新 ---- */
  const ui = require('../miniprogram/utils/ui');
  const unbindTestStore = ui.bindStore(today,
    ['money', 'habit', 'plan', 'shopping', 'media', 'fitness', 'memories', 'settings', 'accounts', '__sync__'],
    () => today.render.call(today),
    () => today.renderSyncState.call(today));
  today.__pageHidden = true;
  today.__storeDirty = false;
  let hiddenRenderCount = 0;
  const originalRender = today.render;
  today.render = function (...args) { hiddenRenderCount += 1; return originalRender.apply(this, args); };
  store.applyLocalUpsert('habit', { id: 'e-x', data: { kind: 'entry', habitId: 'd1', date: t, value: 9 }, updatedAt: Date.now() });
  store.notify(['habit']);
  assert.strictEqual(hiddenRenderCount, 0, '隐藏页收到通知不得立即渲染');
  assert.strictEqual(today.__storeDirty, true, '隐藏页必须标记 dirty，等 onShow 合并刷新');
  today.render = originalRender;
  unbindTestStore();
  today.__pageHidden = false;
  today.__storeDirty = false;

  /* ---- 6. 随记时间线：1500 条首屏（分批 60 条）与重复渲染 ---- */
  counter.calls = 0; counter.chars = 0;
  const memoryFirstMs = time(() => memory.render.call(memory));
  report.memoryFirst = { ms: +memoryFirstMs.toFixed(1), setDataCalls: counter.calls, payloadChars: counter.chars };
  assert.ok(memory.data.total === 1500, '统计口径应为筛选后的完整条数');
  assert.ok(memory.data.groups.length <= 3, '首屏按 60 条预算分批，不应下发全部 1500 条');
  counter.calls = 0; counter.chars = 0;
  const initialTimeline = memory.computeTimelineModel();
  const memoryRepeatMs = time(() => memory.render.call(memory));
  assert.strictEqual(memory.computeTimelineModel(), initialTimeline, '随记分页和回到页面复用同一组筛选结果');
  report.memoryRepeat = { ms: +memoryRepeatMs.toFixed(1), setDataCalls: counter.calls };
  assert.strictEqual(counter.calls, 0, '数据未变时随记页重复 render 不得触发 setData');

  /* ---- 7. 随记搜索 300ms 防抖（确定性等待） ---- */
  memory.visibleCount = 60;
  memory.onKeyword.call(memory, { detail: { value: '咖啡' } });
  assert.strictEqual(memory.visibleCount, 60, '防抖窗口内不得立即重置分页');
  await new Promise((resolve) => setTimeout(resolve, 360));
  assert.strictEqual(memory.visibleCount, 60, '防抖触发后重置回第一批');

  /* ---- 8. 记账页：2000 条月流水渲染与条数预算 ---- */
  const moneyCounter = { calls: 0, chars: 0 };
  const money = makePage(loadPage('money'), moneyCounter);
  money.data.month = month;
  money.visibleGroups = 10;
  money.visibleItems = 120;
  const moneyFirstMs = time(() => money.render.call(money));
  report.moneyFirst = { ms: +moneyFirstMs.toFixed(1), setDataCalls: moneyCounter.calls, payloadChars: moneyCounter.chars };
  let shownItems = 0;
  for (const group of money.data.groups) shownItems += group.items.length;
  assert.ok(shownItems <= 120, '首批下发条数不得超过条数预算（实测 ' + shownItems + '）');
  assert.ok(money.data.hasMore, '2000 条月流水必然还有更多');

  const initialLedger = money.computeLedgerModel(month);
  moneyCounter.calls = 0;
  const moneyRepeatMs = time(() => money.render());
  report.moneyRepeat = { ms: +moneyRepeatMs.toFixed(1), setDataCalls: moneyCounter.calls };
  assert.strictEqual(money.computeLedgerModel(month), initialLedger, '账本反复渲染复用该月计算结果');
  assert.strictEqual(moneyCounter.calls, 0, '切回账本不传输未变化的流水列表');
  const newExpense = { type: 'expense', amount: 1, category: '餐饮', date: t };
  store.applyLocalUpsert('money', { id: 'new-expense', data: newExpense, updatedAt: Date.now() });
  assert.strictEqual(money.computeLedgerModel(month).sumOut, initialLedger.sumOut + 1, '新增流水后重新计算账本');

  const reminderClient = require('../miniprogram/utils/reminder-client');
  const originalFetchCaps = reminderClient.fetchCaps;
  reminderClient.fetchCaps = async () => ({ bill: { enabled: true, credits: 2 }, habit: { enabled: true, credits: 3 } });
  try {
    const habit = makePage(loadPage('habit'), { calls: 0, chars: 0 });
    for (const [page, field, credits] of [[money, 'billReminder', 2], [habit, 'habitReminder', 3]]) {
      page.render = () => assert.fail('提醒查询完成时不应重算整页');
      await page.refreshReminderCaps();
      assert.strictEqual(page.data[field].credits, credits);
    }
  } finally {
    reminderClient.fetchCaps = originalFetchCaps;
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await wait(1);
  console.log('[perf-baseline] ' + JSON.stringify(report));
  console.log('perf-baseline.test.js 通过（Node 计时仅作记录，不代表真机指标）');
}

main().catch((error) => { console.error(error); process.exit(1); }).finally(() => { if (originalWx) global.wx = originalWx; });
