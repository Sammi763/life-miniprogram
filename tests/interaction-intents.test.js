/*
 * 高频交互回归（U01/U04/U05/U08 + R04）。
 * 锁住：今日页快捷入口写入一次性新增意图（消费即清除）；今日待处理完成可撤销、
 * 计数连点不受节流影响；记账新增聚焦金额、恢复未保存草稿、记住上次分类/账户；
 * 预算编辑器行来自任意自定义支出分类、编辑中不被后台刷新覆盖（R04）。
 */
const assert = require('assert');
const path = require('path');

const storage = {};
const originalWx = global.wx;
const toasts = [];
const nav = [];
const store2 = {};
global.wx = {
  getStorageSync: (key) => storage[key],
  setStorageSync: (key, value) => { storage[key] = value; },
  removeStorageSync: (key) => { delete storage[key]; },
  getStorageInfoSync: () => ({ keys: Object.keys(storage) }),
  showToast: (options) => toasts.push(options.title),
  navigateTo: (options) => nav.push(['navigateTo', options.url]),
  switchTab: (options) => nav.push(['switchTab', options.url]),
  vibrateShort: () => {}
};

const store = require('../miniprogram/utils/store');
const sync = require('../miniprogram/utils/sync');
const api = require('../miniprogram/utils/api');
const { setPendingOpen, consumePendingAction, PENDING_OPEN_KEY } = require('../miniprogram/utils/pending-open');

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
function assignPath(target, key, value) {
  const keys = [];
  // 支持 setData 的数组下标路径（如 budgetForm.rows[0].value）
  for (const part of key.split('.')) {
    const m = part.match(/^(.*?)\[(\d+)\]$/);
    if (m) { if (m[1]) keys.push(m[1]); keys.push(Number(m[2])); } else keys.push(part);
  }
  let cur = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = typeof keys[i + 1] === 'number' ? [] : {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}
function makePage(definition) {
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) { for (const key of Object.keys(update)) assignPath(this.data, key, update[key]); }
  };
}
const record = (id, data, updatedAt) => ({ id, data, updatedAt: updatedAt || 1, deletedAt: 0 });

function resetAll() {
  for (const key of Object.keys(storage)) delete storage[key];
  for (const key of Object.keys(store2)) delete store2[key];
  store.resetLocal({ keepAuxiliary: true });
  toasts.length = 0;
  nav.length = 0;
}

async function main() {
  const originalUpsert = sync.upsert;
  const originalFlush = sync.flush;
  const originalSubscribe = api.requestReminderSubscription;
  const originalSchedule = api.scheduleReminder;
  const writes = [];
  sync.upsert = (collection, data, id, options) => {
    const rid = id || 'spy-' + writes.length;
    const updatedAt = options && Number(options.updatedAt) > 0 ? Number(options.updatedAt) : Date.now();
    store.applyLocalUpsert(collection, { id: rid, data, updatedAt });
    writes.push([collection, data, rid, options]);
    return rid;
  };

  try {
    const today = new Date();
    const t = sync.fmtDate(today);
    const month = t.slice(0, 7);

    /* ---------- U01 · 今日快捷入口 → 一次性新增意图 ---------- */
    resetAll();
    const todayPage = makePage(loadPage('today'));
    todayPage.goMoney.call(todayPage);
    assert.deepStrictEqual(nav.pop(), ['switchTab', '/pages/money/money']);
    assert.deepStrictEqual(consumePendingAction('money'), { id: '', action: 'create' }, '记一笔必须携带一次性新增意图');
    assert.strictEqual(storage[PENDING_OPEN_KEY], undefined, '意图消费即清除');
    todayPage.goPlan.call(todayPage);
    assert.deepStrictEqual(nav.pop(), ['navigateTo', '/pages/plan/plan?create=1'], '排日程直达新增');
    todayPage.goShopping.call(todayPage);
    assert.deepStrictEqual(nav.pop(), ['navigateTo', '/pages/shopping/shopping?create=1'], '待买直达新增');
    todayPage.goFitness.call(todayPage);
    assert.deepStrictEqual(nav.pop(), ['navigateTo', '/pages/fitness/fitness?create=weight'], '记体重直达新增');
    todayPage.goBudget.call(todayPage);
    assert.deepStrictEqual(consumePendingAction('money'), { id: '', action: 'budget' }, '预算入口直达预算编辑器');
    todayPage.openToolsSheet();
    assert.strictEqual(todayPage.data.toolsSheetShow, true);
    const appRoutes = require('../miniprogram/app.json').pages;
    const toolRoutes = todayPage.data.lifeTools.map((tool) => tool.url);
    assert.strictEqual(new Set(toolRoutes).size, 8, '生活工具保留全部入口');
    for (const url of toolRoutes) {
      assert.ok(appRoutes.includes(url.slice(1)), '生活工具跳转到列表页');
      todayPage.openToolsSheet();
      todayPage.openLifeTool({ currentTarget: { dataset: { url } } });
      assert.deepStrictEqual(nav.pop(), ['navigateTo', url]);
      assert.strictEqual(todayPage.data.toolsSheetShow, false, '导航后收起弹层');
    }
    todayPage.goPlanList();
    assert.deepStrictEqual(nav.pop(), ['navigateTo', '/pages/plan/plan']);
    store.state.records.accounts.a1 = record('a1', { kind: 'liability', name: '信用卡', currentBill: 68 }, 1);
    const accountPage = makePage(loadPage('money'));
    todayPage.goAccounts({ currentTarget: { dataset: { id: 'a1' } } });
    accountPage.consumePendingOpen();
    assert.strictEqual(accountPage.data.accountForm.id, 'a1');
    assert.strictEqual(accountPage.data.accountSheetShow, true);
    assert.strictEqual(accountPage.data.sheetShow, false, '还款行不应打开新增流水');

    const habitPage = makePage(loadPage('habit'));
    todayPage.goHabit();
    habitPage.consumePendingOpen();
    assert.strictEqual(habitPage.data.sheetShow, true);
    const writesBeforePreset = writes.length;
    habitPage.applyPreset({ currentTarget: { dataset: { name: '阅读' } } });
    assert.strictEqual(habitPage.data.form.unit, '分钟');
    assert.strictEqual(writes.length, writesBeforePreset, '选择预设只填表');
    habitPage.setTarget({ detail: { value: '15' } });
    habitPage.save();
    assert.strictEqual(writes.at(-1)[1].target, 15);

    for (let i = 0; i < 9; i++) {
      store.applyLocalUpsert('shopping', { id: 'item' + i, data: { name: '物品' + i }, updatedAt: 1 });
    }
    todayPage.render();
    assert.strictEqual(todayPage.data.todayQueue.length, 8);
    todayPage.toggleQueue();
    assert.strictEqual(todayPage.data.todayQueue.length, todayPage.data.queueCount);
    todayPage.toggleQueue();
    assert.strictEqual(todayPage.data.todayQueue.length, 8);

    // 离线改标题保留提醒，标记完成时保存并取消；只有新申请才触发授权。
    const future = new Date();
    future.setDate(future.getDate() + 1);
    const date = sync.fmtDate(future);
    const time = '16:00';
    const dueAt = new Date(date + 'T' + time + ':00').getTime();
    store.state.records.plan.p1 = record('p1', { title: '还书', date, time, done: false, reminder: { enabled: true, dueAt } }, 1);
    let requests = 0;
    let accepted = false;
    api.requestReminderSubscription = async () => { requests++; return accepted; };
    const schedules = [];
    api.scheduleReminder = async (id, due) => schedules.push({ id, due });
    sync.flush = async () => {};
    const planEdit = makePage(loadPage('plan'));
    planEdit.fillFormFromSource(store.state.records.plan.p1, date);
    planEdit.onTitle({ detail: { value: '还图书馆的书' } });
    planEdit.save();
    assert.strictEqual(store.state.records.plan.p1.data.title, '还图书馆的书');
    assert.deepStrictEqual(store.state.records.plan.p1.data.reminder, { enabled: true, dueAt });
    assert.strictEqual(requests, 0);
    const planComplete = makePage(loadPage('plan'));
    planComplete.fillFormFromSource(store.state.records.plan.p1, date);
    planComplete.onDone({ detail: { value: true } });
    planComplete.save();
    assert.strictEqual(store.state.records.plan.p1.data.done, true);
    assert.deepStrictEqual(store.state.records.plan.p1.data.reminder, { enabled: true, dueAt });
    const oneOff = { kind: 'plan', sourceId: 'p1', id: 'p1', isVirtual: false };
    sync.upsert('plan', { ...store.state.records.plan.p1.data, done: false }, 'p1');
    const undoCompletion = todayPage.captureQueueUndo(oneOff);
    todayPage.completeQueueItem(oneOff);
    assert.strictEqual(store.state.records.plan.p1.data.done, true);
    undoCompletion();
    assert.strictEqual(store.state.records.plan.p1.data.done, false);
    assert.deepStrictEqual(store.state.records.plan.p1.data.reminder, { enabled: true, dueAt });
    for (const allow of [false, true]) {
      accepted = allow;
      const planNew = makePage(loadPage('plan'));
      planNew.data.reminder = { enabled: true, templateId: 'test-template' };
      Object.assign(planNew.data.form, { date, time, title: '续借', remind: true });
      await planNew.save();
      const saved = writes.at(-1);
      assert.strictEqual(saved[1].reminder.enabled, allow);
    }
    assert.strictEqual(requests, 2);
    assert.strictEqual(schedules.length, 1);

    // money 页消费 create：打开新增表单并聚焦金额
    resetAll();
    const moneyPage = makePage(loadPage('money'));
    setPendingOpen('money', '', 'create');
    moneyPage.consumePendingOpen.call(moneyPage);
    assert.strictEqual(moneyPage.data.sheetShow, true, 'create 意图必须直接打开新增表单');
    assert.strictEqual(moneyPage.data.focusAmount, true, '新增表单必须聚焦金额（U04）');

    /* ---------- U04 · 未保存表单草稿保护 + 上次分类/账户 ---------- */
    resetAll();
    store.state.records.accounts = { a1: record('a1', { kind: 'asset', name: '招行卡', openingBalance: 100, category: '银行卡' }, 1) };
    const money2 = makePage(loadPage('money'));
    money2.data.month = month;
    money2.render.call(money2);
    money2.openAdd.call(money2);
    money2.onAmount.call(money2, { detail: { value: '36.5' } });
    money2.onNote.call(money2, { detail: { value: '咖啡豆' } });
    // 关闭（未保存）→ 草稿暂存；再次打开 → 恢复并提示
    money2.closeSheet.call(money2);
    assert.ok(storage['wb_life_money_form_draft'], '有实际修改的表单关闭时必须暂存草稿');
    money2.openAdd.call(money2);
    assert.strictEqual(money2.data.form.amount, '36.5', '未保存内容必须恢复');
    assert.strictEqual(money2.data.form.note, '咖啡豆');
    assert.ok(toasts.some((text) => /已恢复上次未保存的内容/.test(text)), '恢复草稿必须提示');
    // 恢复后原样关闭：草稿保留（用户没有否定它）；清空全部输入后关闭：草稿清除
    money2.closeSheet.call(money2);
    assert.ok(storage['wb_life_money_form_draft'], '恢复草稿后原样关闭仍保留草稿');
    money2.openAdd.call(money2);
    money2.onAmount.call(money2, { detail: { value: '' } });
    money2.onNote.call(money2, { detail: { value: '' } });
    money2.closeSheet.call(money2);
    assert.strictEqual(storage['wb_life_money_form_draft'], undefined, '清空全部输入后关闭不得留草稿');
    // 空表单（无历史草稿）直接开关：不留草稿、不弹确认
    money2.openAdd.call(money2);
    money2.closeSheet.call(money2);
    assert.strictEqual(storage['wb_life_money_form_draft'], undefined, '空表单关闭不得留草稿');
    // 保存后记住上次支出分类与账户，下次新增沿用
    money2.openAdd.call(money2);
    money2.onAmount.call(money2, { detail: { value: '12' } });
    money2.setCat.call(money2, { currentTarget: { dataset: { cat: '餐饮' } } });
    money2.onAccountChange.call(money2, { detail: { value: 1 } }); // 选择 a1
    money2.save.call(money2);
    const recent = storage['wb_life_money_recent']; // 内存 mock 直存对象，无需反序列化
    assert.strictEqual(recent.category, '餐饮', '保存后必须记住本次支出分类');
    assert.strictEqual(recent.accountId, 'a1', '保存后必须记住本次账户');
    const money3 = makePage(loadPage('money'));
    money3.data.month = month;
    money3.render.call(money3);
    money3.openAdd.call(money3);
    assert.strictEqual(money3.data.form.category, '餐饮', '下次新增沿用上次分类');
    assert.strictEqual(money3.data.form.accountId, 'a1', '下次新增沿用上次账户');

    /* ---------- U05 · 预算编辑器行含自定义分类 ---------- */
    resetAll();
    store.state.records.settings = { app: record('app', { budget: 3000, customCategories: [{ name: '宠物', type: 'expense' }] }, 1) };
    store.state.records.money = {};
    const money4 = makePage(loadPage('money'));
    money4.data.month = month;
    money4.render.call(money4);
    money4.openBudgetSheet.call(money4);
    assert.ok(money4.data.budgetForm.rows.some((row) => row.key === '宠物'), '自定义分类必须出现在预算编辑器（U05）');
    assert.ok(money4.data.budgetForm.rows.some((row) => row.key === '餐饮'), '内置分类保留');

    /* ---------- R04 · 预算编辑中的后台刷新不得覆盖输入 ---------- */
    money4.onBudgetMainInput.call(money4, { detail: { value: '4500' } });
    const rowIndex = money4.data.budgetForm.rows.findIndex((row) => row.key === '餐饮');
    money4.onBudgetRowInput.call(money4, { currentTarget: { dataset: { index: rowIndex } }, detail: { value: '800' } });
    // 模拟后台同步改写了 settings（updatedAt 推进）→ 页面收到无关通知触发 render
    store.state.records.settings.app = record('app', { budget: 9999, height: 175 }, 50);
    money4.render.call(money4);
    assert.strictEqual(money4.data.budgetForm.main, '4500', '后台刷新不得覆盖正在编辑的预算输入（R04 probe）');
    assert.strictEqual(money4.data.budgetForm.rows[rowIndex].value, '800', '分类预算输入同样受保护');
    assert.strictEqual(money4.data.budgetRemoteChanged, true, '其他设备已更新时必须提示（不静默覆盖也不静默丢失）');
    // 保存以用户输入为准，并保留无关 settings 字段
    money4.saveBudget.call(money4);
    const budgetWrite = writes.find((w) => w[0] === 'settings');
    assert.strictEqual(budgetWrite[1].budget, 4500, '保存以用户输入为准');
    assert.strictEqual(budgetWrite[1].height, 175, '保存预算必须保留无关个人设置');
    assert.strictEqual(budgetWrite[1].categoryBudgets['餐饮'], 800, '分类预算随保存写入');

    /* ---------- U08 · 待处理完成可撤销、计数连点不受节流影响 ---------- */
    resetAll();
    store.state.records.shopping = { s1: record('s1', { name: '咖啡豆', done: false }, 1) };
    store.state.records.plan = { p1: record('p1', { title: '交周报', date: t, time: '', done: false }, 2) };
    const today2 = makePage(loadPage('today'));
    today2.data.month = month;
    today2.render.call(today2);
    // 购物项完成 → 撤销恢复 done:false
    today2.onQueueComplete.call(today2, { currentTarget: { dataset: { id: 's1', kind: 'shopping' } } });
    assert.strictEqual(store.state.records.shopping.s1.data.done, true, '完成立即生效');
    today2.onUndoTap.call(today2);
    assert.strictEqual(store.state.records.shopping.s1.data.done, false, '完成提供撤销（U08）');
    // 计数习惯连点：两次点击都生效（不被 400ms 节流吞掉）
    store.state.records.habit = { d1: record('d1', { kind: 'def', name: '喝水', mode: 'count', target: 8 }, 1) };
    const today3 = makePage(loadPage('today'));
    today3.render.call(today3);
    const queueItem = today3.currentQueue.find((item) => item.kind === 'habit' && item.sourceId === 'd1');
    assert.ok(queueItem, '未完成习惯必须出现在今日待处理');
    today3.onQueueComplete.call(today3, { currentTarget: { dataset: { id: queueItem.id, kind: 'habit' } } });
    today3.onQueueComplete.call(today3, { currentTarget: { dataset: { id: queueItem.id, kind: 'habit' } } });
    const entry = Object.values(store.state.records.habit).find((item) => item.data && item.data.kind === 'entry');
    assert.ok(entry && Number(entry.data.value) === 2, '计数连点必须次次生效（动画与节流不得影响真实写入）');
    console.log('interaction-intents.test.js 通过');
  } finally {
    sync.upsert = originalUpsert;
    sync.flush = originalFlush;
    api.requestReminderSubscription = originalSubscribe;
    api.scheduleReminder = originalSchedule;
    if (originalWx) global.wx = originalWx;
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
