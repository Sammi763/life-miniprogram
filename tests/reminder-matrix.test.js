/*
 * v2.11 提醒矩阵（习惯打卡 + 账单还款）—— file 驱动口径（MySQL 双驱动实现见 mysql-store.js，同语义）：
 * 扫描按日去重、额度 0 跳过、发送成功才扣减额度、capabilities 扩展（向后兼容原字段）、
 * PUT /api/reminders/credit 上下账、settings 新字段白名单。
 *
 * 运行：node tests/reminder-matrix.test.js
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { FileStore } = require('../server/db/file-store');
const { createApp } = require('../server/server');
const { createReminderWorker, getReminderCapabilities } = require('../server/reminders');

const root = path.resolve(__dirname, '..');

function pad(value) { return String(value).padStart(2, '0'); }
function localDate(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}
function dayOfMonth(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.getDate();
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-reminder-matrix-'));
  const config = {
    dataDir,
    storageDriver: 'file',
    devMode: true,
    tokenTtlDays: 30,
    wxAppId: 'test-appid',
    wxSecret: 'test-secret',
    wxReminderTemplateId: 'tpl-plan',
    wxHabitReminderTemplateId: 'tpl-habit',
    wxBillReminderTemplateId: 'tpl-bill',
    habitReminderHour: 20,
    reminderRateLimit: 100
  };
  const store = new FileStore(config);
  await store.init();
  const now = Date.now();
  const today = localDate(0);
  const endOfToday = new Date(today + 'T23:59:59').getTime();

  /* ---------- store 层：额度上下账 ---------- */
  assert.deepStrictEqual(await store.getReminderCredits('u1'), { habit: 0, bill: 0 }, '新用户额度必须从 0 开始');
  assert.strictEqual(await store.addReminderCredit('u1', 'habit', 1), 1, '上账后额度 +1');
  await store.addReminderCredit('u1', 'habit', 1);
  await store.addReminderCredit('u1', 'bill', 2);
  assert.deepStrictEqual(await store.getReminderCredits('u1'), { habit: 2, bill: 2 }, '额度必须按 kind 分开记');
  assert.strictEqual(await store.addReminderCredit('u1', 'habit', -5), 0, '下账不得透支到负数');
  await store.addReminderCredit('u1', 'habit', 1);
  await store.addReminderCredit('u1', 'bill', 1);

  let threw = '';
  try { await store.addReminderCredit('u1', 'other', 1); } catch (error) { threw = error.message; }
  assert.ok(threw, '未知 kind 必须拒绝');

  /* ---------- 习惯扫描：开启 + 额度>0 + 当日无打卡 才发一条，同日绝不重发 ---------- */
  await store.upsert('u1', 'settings', 'app', { habitReminderEnabled: true, habitReminderTime: '00:00', billReminderEnabled: true }, now, {});
  assert.strictEqual(await store.scanHabitReminders(today, now), 1, '符合条件时必须生成一条习惯提醒');
  const habitReminder = await store.getLatestReminderForPlan('u1', 'habit:' + today);
  assert.ok(habitReminder && habitReminder.status === 'pending', '习惯提醒必须落在现有 scheduled_reminders 存储里');
  assert.ok(String(habitReminder.title).includes('打卡'), '习惯提醒标题必须可识别');
  assert.strictEqual(await store.scanHabitReminders(today, now + 60000), 0, '同一天重复扫描绝不能重发');
  assert.strictEqual((await store.getLatestReminderForPlan('u1', 'habit:' + today)).id, habitReminder.id, '重复扫描必须复用同一条提醒');

  // 当日已有打卡 entry：不发
  await store.upsert('u2', 'settings', 'app', { habitReminderEnabled: true, habitReminderTime: '00:00' }, now, {});
  await store.addReminderCredit('u2', 'habit', 1);
  await store.upsert('u2', 'habit', 'entry-u2', { kind: 'entry', habitId: 'h1', date: today, value: 1 }, now, {});
  assert.strictEqual(await store.scanHabitReminders(today, now), 0, '当日已有打卡的用户必须跳过');

  // 额度为 0：不发
  await store.upsert('u3', 'settings', 'app', { habitReminderEnabled: true, habitReminderTime: '00:00' }, now, {});
  assert.strictEqual(await store.scanHabitReminders(today, now), 0, '额度为 0 的用户必须跳过');

  // 未开启：不发
  await store.upsert('u4', 'settings', 'app', { habitReminderTime: '07:30' }, now, {});
  await store.addReminderCredit('u4', 'habit', 1);
  assert.strictEqual(await store.scanHabitReminders(today, now), 0, '未开启开关的用户必须跳过');

  // 时间非法：回退默认时间（config.habitReminderHour=20），用当天末尾的注入 now 保证确定性
  await store.upsert('u5', 'settings', 'app', { habitReminderEnabled: true, habitReminderTime: 'bad' }, now, {});
  await store.addReminderCredit('u5', 'habit', 1);
  assert.strictEqual(await store.scanHabitReminders(today, endOfToday), 1, '时间非法时必须回退默认时间仍可发送');

  // 同 userId+kind+日期唯一：今天一次、明天一次；同一天重复扫描不重发
  await store.upsert('u7', 'settings', 'app', { habitReminderEnabled: true, habitReminderTime: '00:00' }, now, {});
  await store.addReminderCredit('u7', 'habit', 2);
  assert.strictEqual(await store.scanHabitReminders(today, now), 1, 'u7 今天首次扫描必须生成');
  assert.strictEqual(await store.scanHabitReminders(today, now + 60000), 0, 'u7 同一天重复扫描不得重发');
  await store.scanHabitReminders(localDate(1), endOfToday + 86400000);
  const u7Today = await store.getLatestReminderForPlan('u7', 'habit:' + today);
  const u7Tomorrow = await store.getLatestReminderForPlan('u7', 'habit:' + localDate(1));
  assert.ok(u7Tomorrow, '次日扫描必须为 u7 生成新一天提醒');
  assert.notStrictEqual(u7Tomorrow.id, u7Today.id, '不同日期必须是不同提醒记录');
  await store.scanHabitReminders(localDate(1), endOfToday + 86400000 + 60000);
  assert.strictEqual((await store.getLatestReminderForPlan('u7', 'habit:' + localDate(1))).id, u7Tomorrow.id, '次日重复扫描不得重发');

  /* ---------- 账单扫描：到期前 2 天（含当天）发送，按 账户+到期日 去重 ---------- */
  await store.upsert('u1', 'accounts', 'acc1', { kind: 'liability', name: '招行信用卡', openingBalance: 0, manualAdjustment: 0, category: '消费信贷', currentBill: 1200, dueDay: dayOfMonth(2) }, now, {});
  await store.upsert('u1', 'accounts', 'acc2', { kind: 'liability', name: '花呗', openingBalance: 0, manualAdjustment: 0, category: '消费信贷', currentBill: 300, dueDay: dayOfMonth(5) }, now, {});
  await store.upsert('u1', 'accounts', 'acc3', { kind: 'liability', name: '白条', openingBalance: 0, manualAdjustment: 0, category: '消费信贷' }, now, {});
  await store.upsert('u1', 'accounts', 'acc4', { kind: 'asset', name: '储蓄卡', openingBalance: 500, manualAdjustment: 0, category: '银行卡' }, now, {});
  assert.strictEqual(await store.scanBillReminders(today, now), 1, '只有进入 2 天窗口且开启了开关的负债账户必须生成提醒');
  const dueDate = localDate(2);
  const billReminder = await store.getLatestReminderForPlan('u1', 'bill:acc1:' + dueDate);
  assert.ok(billReminder && billReminder.status === 'pending', '账单提醒必须按 账户+到期日 落库');
  assert.strictEqual(await store.scanBillReminders(today, now + 60000), 0, '同一天重复扫描绝不能重发账单提醒');
  // 未开启还款提醒：不发（u6 连设置记录都没有）
  await store.upsert('u6', 'accounts', 'acc9', { kind: 'liability', name: '月付', openingBalance: 0, manualAdjustment: 0, category: '消费信贷', currentBill: 50, dueDay: dayOfMonth(1) }, now, {});
  assert.strictEqual(await store.scanBillReminders(today, now), 0, '未开启还款提醒的用户必须跳过');

  /* ---------- worker：按 kind 选模板与落地页，发送成功才扣额度 ---------- */
  const delivered = [];
  const worker = createReminderWorker(store, config, async (_config, message) => { delivered.push(message); return { errcode: 0 }; });
  const result = await worker.runOnce();
  assert.strictEqual(result.skipped, false, '任一 kind 可用时 worker 必须运行');
  const u1HabitMsgs = delivered.filter((message) => message.touser === 'u1' && message.templateId === 'tpl-habit');
  assert.strictEqual(u1HabitMsgs.length, 1, 'u1 的习惯提醒必须恰好投递一次');
  assert.strictEqual(u1HabitMsgs[0].page, 'pages/habit/habit', '习惯提醒落地页必须是习惯页');
  assert.ok(u1HabitMsgs[0].data.thing1 && u1HabitMsgs[0].data.time2, '习惯提醒必须复用 thing1/time2 结构');
  const u1BillMsgs = delivered.filter((message) => message.touser === 'u1' && message.templateId === 'tpl-bill');
  assert.strictEqual(u1BillMsgs.length, 1, 'u1 的账单提醒必须恰好投递一次');
  assert.strictEqual(u1BillMsgs[0].page, 'pages/money/money', '账单提醒落地页必须是记账页');
  assert.deepStrictEqual(await store.getReminderCredits('u1'), { habit: 0, bill: 2 }, '发送成功后必须按 kind 扣减额度（habit 1→0，bill 3→2）');
  assert.strictEqual((await store.getReminder(habitReminder.id)).status, 'sent', '习惯提醒发送后必须标记 sent');
  await worker.runOnce();
  assert.strictEqual(delivered.filter((message) => message.touser === 'u1').length, 2, '已发送的提醒不得重复投递');

  /* ---------- 模板未配置时对应 kind 静默停用，不影响另一类 ---------- */
  assert.deepStrictEqual(getReminderCapabilities({ ...config, wxHabitReminderTemplateId: '' }), { enabled: true, templateId: 'tpl-plan' }, 'plan 能力查询结果不得回归');
  const partialStore = new FileStore({ ...config, wxHabitReminderTemplateId: '', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'life-reminder-partial-')) });
  await partialStore.init();
  await partialStore.upsert('u1', 'settings', 'app', { habitReminderEnabled: true }, now, {});
  await partialStore.addReminderCredit('u1', 'habit', 1);
  assert.strictEqual(await partialStore.scanHabitReminders(today, endOfToday), 0, '习惯模板未配置时习惯扫描必须静默停用');
  await partialStore.close();

  /* ---------- HTTP 层：capabilities 扩展 + credit 端点 + settings 白名单 ---------- */
  const app = createApp(store, config, new Set(), { sendSubscriptionMessage: async () => ({ errcode: 0 }) });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const request = (url, options) => fetch(baseUrl + url, options);

  try {
    assert.strictEqual((await request('/api/reminders/credit', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'habit' }) })).status, 401, 'credit 端点必须受登录态保护');
    const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'dev' }) });
    const { token } = await login.json();
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

    const capabilities = await request('/api/reminders/capabilities', { headers });
    assert.strictEqual(capabilities.status, 200);
    const capBody = await capabilities.json();
    assert.strictEqual(capBody.enabled, true, 'capabilities 必须保留原 enabled 字段');
    assert.strictEqual(capBody.templateId, 'tpl-plan', 'capabilities 必须保留原 templateId 字段');
    assert.deepStrictEqual(capBody.habit, { enabled: true, templateId: 'tpl-habit', credits: 0 }, 'capabilities 必须扩展 habit kind（enabled/templateId/credits）');
    assert.deepStrictEqual(capBody.bill, { enabled: true, templateId: 'tpl-bill', credits: 0 }, 'capabilities 必须扩展 bill kind');

    const credit1 = await request('/api/reminders/credit', { method: 'PUT', headers, body: JSON.stringify({ kind: 'habit' }) });
    assert.strictEqual(credit1.status, 200, '上报授权必须成功');
    assert.strictEqual((await credit1.json()).credits, 1, 'credit 上账必须返回最新额度');
    assert.strictEqual((await store.getReminderCredits('dev-user')).habit, 1, 'credit 端点必须真实落库');
    const badKind = await request('/api/reminders/credit', { method: 'PUT', headers, body: JSON.stringify({ kind: 'plan' }) });
    assert.strictEqual(badKind.status, 422, '未知 kind 必须拒绝');
    const badBody = await request('/api/reminders/credit', { method: 'PUT', headers, body: JSON.stringify({}) });
    assert.strictEqual(badBody.status, 422, '缺少 kind 必须拒绝');

    const settingsNew = await request('/api/records/settings/app', {
      method: 'PUT', headers,
      body: JSON.stringify({ updatedAt: now + 1, data: { habitReminderEnabled: true, billReminderEnabled: true, habitReminderTime: '20:30', theme: 'auto' } })
    });
    assert.strictEqual(settingsNew.status, 200, '含提醒新字段与 theme=auto 的设置必须可保存');
    const settingsOld = await request('/api/records/settings/app', {
      method: 'PUT', headers,
      body: JSON.stringify({ updatedAt: now + 2, data: { budget: 3000, aiConsent: true } })
    });
    assert.strictEqual(settingsOld.status, 200, '旧字段集必须继续可保存');
    const settingsBad = await request('/api/records/settings/app', {
      method: 'PUT', headers,
      body: JSON.stringify({ updatedAt: now + 3, data: { habitReminderTime: '9 点' } })
    });
    assert.strictEqual(settingsBad.status, 422, '非法提醒时间必须被拒绝');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  /* ---------- 客户端：开关开启 → 订阅授权 → 额度上报；额度 0 时横幅 ---------- */
  const miniStore = require('../miniprogram/utils/store');
  const miniApi = require('../miniprogram/utils/api');
  const clientApi = require('../miniprogram/utils/api');

  function loadMiniPage(relativePath) {
    const absolutePath = path.join(root, relativePath);
    const originalPage = global.Page;
    let definition = null;
    global.Page = (page) => { definition = page; };
    delete require.cache[require.resolve(absolutePath)];
    require(absolutePath);
    global.Page = originalPage;
    return definition;
  }
  function cloneValue(value) { return JSON.parse(JSON.stringify(value)); }
  function assignPath(target, key, value) {
    const parts = key.split('.');
    let current = target;
    for (const part of parts.slice(0, -1)) {
      if (!current[part] || typeof current[part] !== 'object') current[part] = {};
      current = current[part];
    }
    current[parts[parts.length - 1]] = value;
  }
  function makeMiniPage(definition) {
    return {
      ...definition,
      data: cloneValue(definition.data),
      setData(update) { Object.keys(update).forEach((key) => assignPath(this.data, key, update[key])); }
    };
  }

  const serverWxBackup = global.wx;
  const clientWx = {
    showToast: (options) => clientToasts.push(options && options.title || ''),
    getStorageSync: (key) => (key in clientStorage ? clientStorage[key] : ''),
    setStorageSync: (key, value) => { clientStorage[key] = value; },
    removeStorageSync: (key) => { delete clientStorage[key]; },
    setNavigationBarColor: () => {}, setBackgroundColor: () => {},
    requestSubscribeMessage: (options) => { subscribeCalls.push(options.tmplIds); options.success(clientSubscribeResult); },
    vibrateShort: () => {}, showLoading: () => {}, hideLoading: () => {}, switchTab: () => {}, navigateTo: () => {}
  };
  const clientToasts = [];
  const subscribeCalls = [];
  const clientStorage = {};
  let clientSubscribeResult = { 'tpl-habit': 'accept' };
  global.wx = clientWx;

  miniStore.loadLocal();
  for (const coll of miniStore.COLLECTIONS) miniStore.state.records[coll] = {};
  const originalMiniToken = miniApi.getToken;
  const originalCaps = miniApi.getReminderCapabilities;
  const originalCredit = miniApi.addReminderCredit;
  const originalSubscribe = miniApi.requestReminderSubscription;
  miniApi.getToken = () => 'test-token';
  miniApi.getReminderCapabilities = async () => ({
    enabled: true, templateId: 'tpl-plan',
    habit: { enabled: true, templateId: 'tpl-habit', credits: 0 },
    bill: { enabled: true, templateId: 'tpl-bill', credits: 0 }
  });
  miniApi.addReminderCredit = async (kind) => ({ kind, credits: 1 });
  miniApi.requestReminderSubscription = async (templateId) => {
    subscribeCalls.push(templateId);
    return clientSubscribeResult[templateId] === 'accept';
  };
  // 开关保存会触发 sync.flush 真实上送：mock 掉读写通道，避免登录路径产生 15s 重试定时器
  const originalApiPut = miniApi.apiPut;
  const originalApiDelete = miniApi.apiDelete;
  miniApi.apiPut = async () => ({ applied: true });
  miniApi.apiDelete = async () => ({ applied: true });

  try {
    const habitPage = makeMiniPage(loadMiniPage('miniprogram/pages/habit/habit.js'));
    // 开关默认关闭
    miniStore.state.records.settings = {};
    habitPage.render.call(habitPage);
    assert.strictEqual(habitPage.data.habitReminder.enabled, false, '未配置时习惯提醒开关必须默认关闭');

    // 开启 → 订阅授权（habit 模板）→ 额度上报 → settings 保存
    await habitPage.onHabitReminderToggle.call(habitPage, { detail: { value: true } });
    assert.deepStrictEqual(subscribeCalls, ['tpl-habit'], '开启习惯提醒必须弹出 habit 模板订阅');
    assert.strictEqual(miniStore.state.records.settings.app.data.habitReminderEnabled, true, '开启后必须写入 habitReminderEnabled');
    assert.strictEqual(miniStore.state.queue[miniStore.state.queue.length - 1].data.habitReminderEnabled, true, '设置必须进入同步队列');

    // 拒绝订阅：开关仍保存（用户意图），但不报额度 → 横幅提示续订
    subscribeCalls.length = 0;
    clientSubscribeResult = { 'tpl-habit': 'reject' };
    await habitPage.onHabitReminderToggle.call(habitPage, { detail: { value: true } });
    assert.strictEqual(subscribeCalls.length, 1, '再次开启仍会尝试订阅');
    assert.strictEqual(miniStore.state.records.settings.app.data.habitReminderEnabled, true, '拒绝订阅时开关不得回退');
    clientSubscribeResult = { 'tpl-habit': 'accept' };

    // 关闭：不弹订阅
    subscribeCalls.length = 0;
    await habitPage.onHabitReminderToggle.call(habitPage, { detail: { value: false } });
    assert.strictEqual(subscribeCalls.length, 0, '关闭开关不得弹出订阅');
    assert.strictEqual(miniStore.state.records.settings.app.data.habitReminderEnabled, false, '关闭后必须保存 false');

    // 时间选择保存
    await habitPage.onHabitReminderTime.call(habitPage, { detail: { value: '21:30' } });
    assert.strictEqual(miniStore.state.records.settings.app.data.habitReminderTime, '21:30', '提醒时间必须写入设置');

    // 额度 0 时横幅出现
    habitPage.reminderCaps = { enabled: true, habit: { enabled: true, templateId: 'tpl-habit', credits: 0 }, bill: { enabled: true, templateId: 'tpl-bill', credits: 0 } };
    miniStore.state.records.settings.app = { id: 'app', data: { habitReminderEnabled: true }, updatedAt: 1, deletedAt: 0 };
    habitPage.render.call(habitPage);
    assert.match(habitPage.data.habitReminder.banner, /续订/, '额度耗尽时必须出现续订横幅');

    // money 页：还款提醒开关走 bill kind
    const moneyPage = makeMiniPage(loadMiniPage('miniprogram/pages/money/money.js'));
    moneyPage.reminderCaps = { enabled: true, habit: { enabled: true, templateId: 'tpl-habit', credits: 0 }, bill: { enabled: true, templateId: 'tpl-bill', credits: 0 } };
    miniStore.state.records.settings.app = { id: 'app', data: {}, updatedAt: 2, deletedAt: 0 };
    moneyPage.render.call(moneyPage);
    assert.strictEqual(moneyPage.data.billReminder.enabled, false, '未配置时还款提醒开关必须默认关闭');
    subscribeCalls.length = 0;
    clientSubscribeResult = { 'tpl-bill': 'accept' };
    await moneyPage.onBillReminderToggle.call(moneyPage, { detail: { value: true } });
    assert.deepStrictEqual(subscribeCalls, ['tpl-bill'], '开启还款提醒必须弹出 bill 模板订阅');
    assert.strictEqual(miniStore.state.records.settings.app.data.billReminderEnabled, true, '开启后必须写入 billReminderEnabled');

    // 「我的 → 提醒设置」续订成功后必须立刻反映新额度，不得停留在旧文案直到下次 onShow
    const minePage = makeMiniPage(loadMiniPage('miniprogram/pages/mine/mine.js'));
    minePage.reminderCaps = { enabled: true, templateId: 'tpl-plan', habit: { enabled: true, templateId: 'tpl-habit', credits: 0 }, bill: { enabled: true, templateId: 'tpl-bill', credits: 0 } };
    clientSubscribeResult = { 'tpl-habit': 'accept' };
    await minePage.onReminderRenew.call(minePage, { currentTarget: { dataset: { kind: 'habit' } } });
    assert.strictEqual(minePage.data.reminderHabitText, '剩余提醒次数 1', '续订成功后弹层文案必须立即反映新额度');

    // api.js 必须导出额度端点封装，页面模板必须挂上开关
    assert.strictEqual(typeof clientApi.addReminderCredit, 'function', 'api 必须导出 addReminderCredit');
    const habitWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/habit/habit.wxml'), 'utf8');
    const moneyWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/money/money.wxml'), 'utf8');
    assert.match(habitWxml, /bindchange="onHabitReminderToggle"/, '习惯页必须渲染打卡提醒开关');
    assert.match(habitWxml, /bindchange="onHabitReminderTime"/, '习惯页必须渲染提醒时间选择');
    assert.match(moneyWxml, /bindchange="onBillReminderToggle"/, '记账页必须渲染还款提醒开关');
  } finally {
    require('../miniprogram/utils/sync').destroy();
    // store 的 250ms 防抖落盘定时器还挂着：等它在本段 clientWx（带 setStorageSync）下走完，
    // 再恢复 global.wx，否则恢复后定时器触发会打出 persist fail 栈噪音
    await new Promise((resolve) => setTimeout(resolve, 320));
    global.wx = serverWxBackup;
    miniApi.getToken = originalMiniToken;
    miniApi.getReminderCapabilities = originalCaps;
    miniApi.addReminderCredit = originalCredit;
    miniApi.requestReminderSubscription = originalSubscribe;
    miniApi.apiPut = originalApiPut;
    miniApi.apiDelete = originalApiDelete;
  }

  console.log('REMINDER_MATRIX_TEST_PASSED');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
