const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const http = require('node:http');
const { createApp } = require('../server/server');
const { FileStore } = require('../server/db/file-store');
const { MySqlStore } = require('../server/db/mysql-store');
const { loadConfig } = require('../server/config');
const { createReminderWorker } = require('../server/reminders');
const miniStore = require('../miniprogram/utils/store');
const sync = require('../miniprogram/utils/sync');
const api = require('../miniprogram/utils/api');
const { focusDraftKey } = require('../miniprogram/utils/focus-draft');
const { buildTodayQueue } = require('../miniprogram/utils/daily-utils');
const { buildHabitHistory, updateSchedule } = require('../miniprogram/utils/habit-utils');
const { buildWeeklyReview } = require('../miniprogram/utils/review-utils');
const { buildMonthlyReport } = require('../miniprogram/utils/report-utils');
const { searchAll } = require('../miniprogram/utils/search-utils');
const { sanitizeImportData } = require('../miniprogram/utils/backup');
const { buildMoneyAudit } = require('../miniprogram/utils/money-audit');
const { repaymentId } = require('../miniprogram/utils/money-rules');
const { buildMoneyCsv } = require('../miniprogram/utils/money-csv');
const { buildBillAlerts } = require('../miniprogram/utils/ledger-utils');
const { addDays, formatDate } = require('../miniprogram/utils/plan-utils');

const def = { kind: 'def', name: '运动', mode: 'count', target: 3 };
const monday = '2026-11-02';
const tuesday = addDays(monday, 1);
const wednesday = addDays(monday, 2);
const friday = addDays(monday, 4);
const monWedFri = 1 | 4 | 16;
const wrapped = (id, data, updatedAt = 1) => ({ id, data, updatedAt });
const entry = (date, value) => ({ kind: 'entry', habitId: 'h1', date, value, mode: 'count', target: 3 });

function checkHabitStats() {
  const schedule = updateSchedule(null, monday, monWedFri);
  const initial = wrapped('h1', { ...def, schedule });
  const habit = [initial, wrapped('mon', entry(monday, 3)), wrapped('tue', entry(tuesday, 3)), wrapped('fri', entry(friday, 2))];
  assert.equal(buildTodayQueue({ habit }, tuesday).length, 0);
  assert.equal(buildTodayQueue({ habit }, friday)[0].done, false);
  assert.deepEqual(buildWeeklyReview({ habit }, monday).habit, { total: 3, done: 1, rate: 33.3 });
  assert.equal(buildMonthlyReport({ habit }, monday.slice(0, 7)).life.habit.total, 13);
  const changed = updateSchedule(initial, friday, 8);
  habit[0] = wrapped('h1', { ...def, schedule: changed });
  assert.deepEqual(buildWeeklyReview({ habit }, monday).habit, { total: 2, done: 1, rate: 50 });
  const history = buildHabitHistory(habit, habit[0], friday).grid.flat();
  assert.equal(history.find((cell) => cell.date === tuesday).scheduled, false);
  assert.equal(history.find((cell) => cell.date === tuesday).done, true);
  assert.equal(history.find((cell) => cell.date === wednesday).scheduled, true);
  assert.deepEqual(sanitizeImportData('habit', habit[0].data), habit[0].data);
}

function loadPage(name) {
  let definition;
  global.Page = (page) => { definition = page; };
  const modulePath = require.resolve('../miniprogram/pages/' + name + '/' + name);
  delete require.cache[modulePath];
  try { require(modulePath); } finally { delete global.Page; }
  return {
    ...definition, data: structuredClone(definition.data), updates: 0,
    setData(patch, callback) { Object.assign(this.data, patch); this.updates++; if (callback) callback(); }
  };
}

function checkSearch() {
  const start = '2026-10-28';
  const end = '2026-11-03';
  const source = {
    plan: [
      wrapped('series', { kind: 'series', startDate: start, repeat: 'weekly', title: '例会', subtasks: [{ id: 'step', title: '打印议程' }] }),
      wrapped('override', { kind: 'occurrence', seriesId: 'series', date: start, titleOverride: '预算会议' })
    ],
    money: [
      wrapped('earlier', { type: 'expense', category: '咖啡', amount: 18, date: '2026-10-27' }, 900),
      wrapped('inside', { type: 'expense', category: '咖啡', amount: 18, date: '2026-10-30' }, 1)
    ],
    shopping: [wrapped('no-date', { name: '咖啡杯' })]
  };
  assert.deepEqual(searchAll(source, { start, end }).map((item) => item.id).sort(), ['inside', 'series']);
  const hits = searchAll(source, { start, end, keyword: '打印议程' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].occurrenceDate, start);
  assert.equal(hits[0].title, '预算会议');
  assert.equal(searchAll(source, { keyword: '预算会议' })[0].occurrenceDate, start);
  assert.equal(searchAll(source, { keyword: '咖啡杯' })[0].id, 'no-date');

  miniStore.state.records.plan = Object.fromEntries(source.plan.map((record) => [record.id, record]));
  miniStore.state.records.money = Object.fromEntries(source.money.map((record) => [record.id, record]));
  const search = loadPage('search');
  search.selectDate({ detail: { value: start } });
  assert.equal(search.data.resultTotal, 1);
  search.openResult({ currentTarget: { dataset: { key: hits[0].key } } });
  assert.equal(wx.lastUrl, '/pages/plan/plan?id=series&date=' + start);
  search.selectDate({ detail: { value: '2026-10-30' } });
  search.visibleResults = 200;
  search.openResult({ currentTarget: { dataset: { key: 'money_inside' } } });
  assert.equal(wx.lastUrl, '/pages/money/money');
  search.onLoad({ resume: '1' });
  assert.equal(search.data.selectedDate, '2026-10-30');
  assert.equal(search.visibleResults, 200);
  search.onUnload();
}

function checkMoney() {
  const page = loadPage('money');
  const record = (id, type, amount, accountId, toAccountId) =>
    wrapped(id, { type, amount, accountId, toAccountId, category: '同名', date: monday });
  const expenses = Array.from({ length: 121 }, (_, index) => record('x' + index, 'expense', 0.1, 'card'));
  const rows = expenses.concat(record('salary', 'income', 12, 'card'), record('unlinked', 'expense', 3),
    record('transfer', 'transfer', 7, 'card', 'wallet'));
  miniStore.state.records.money = Object.fromEntries(rows.map((row) => [row.id, row]));
  miniStore.state.records.accounts = {
    card: wrapped('card', { kind: 'asset', name: '银行卡', balance: 0 }),
    wallet: wrapped('wallet', { kind: 'asset', name: '电子钱包', balance: 0 })
  };
  page.setData({ month: '2026-11' });
  page.updateFilters({ accountFilter: 'card', typeFilter: 'expense', filter: '同名' });
  assert.equal(page.data.shownItems, 121);
  assert.equal(page.data.usedItems, 120);
  assert.equal(page.data.filteredOutText, '12.1');
  assert.equal(page.data.sumOutText, '15.1');
  assert.equal(page.data.filteredInText, '0');
  assert.equal(page.data.hasMore, true);
  page.loadMore();
  assert.equal(page.data.filteredOutText, '12.1');
  assert.equal(page.data.usedItems, 121);
  page.updateFilters({ filter: '', typeFilter: 'transfer' });
  assert.equal(page.data.shownItems, 1);
  page.updateFilters({ accountFilter: 'wallet' });
  assert.equal(page.data.shownItems, 1);
  assert.equal(page.data.filteredTransferText, '7');
  page.shiftMonth(1);
  assert.equal(page.data.accountFilter, 'wallet');
  assert.equal(page.data.typeFilter, 'transfer');
  assert.equal(page.data.shownItems, 0);
  page.shiftMonth(-1);
  page.selectAccountFilter({ detail: { value: '1' } });
  page.updateFilters({ typeFilter: '' });
  assert.deepEqual(page.data.groups.flatMap((group) => group.items.map((item) => item.id)), ['unlinked']);
  page.clearFilters();
  assert.equal(page.data.shownItems, 124);
}

function checkFocus() {
  const actualNow = Date.now;
  const upsert = sync.upsert;
  let clock = actualNow();
  let writes = 0;
  const today = loadPage('today');
  const focus = loadPage('focus');
  try {
    Date.now = () => clock;
    sync.upsert = (collection, data, id) => {
      writes++;
      miniStore.state.records[collection][id] = wrapped(id, data, clock);
    };
    focus.onLoad({ kind: 'habit', id: 'h1', title: '运动' });
    focus.onShow();
    focus.onMinutes({ detail: { value: '1' } });
    focus.start();
    const key = focusDraftKey();
    const draft = wx.getStorageSync(key);
    const updates = focus.updates;
    focus.tick();
    assert.equal(focus.updates, updates);
    focus.onHide();
    today.renderRunningFocus();
    assert.equal(today.data.runningFocus.action, '继续专注');
    clock = draft.targetAt;
    today.renderRunningFocus();
    assert.equal(today.data.runningFocus.action, '记录本次');
    const reloaded = { ...focus, data: { ...focus.data }, session: null };
    reloaded.onShow();
    assert.equal(reloaded.session.id, draft.id);
    assert.equal(reloaded.data.finished, true);
    reloaded.finish();
    reloaded.finish();
    assert.equal(writes, 1);
    assert.equal(miniStore.state.records.focusSessions[draft.id].data.endedAt, draft.targetAt);
    wx.setStorageSync(key, { ...draft, id: 'another-session' });
    api.saveProfile({ accountKey: 'other' });
    today.renderRunningFocus();
    assert.equal(today.data.runningFocus, null);
  } finally {
    today.onHide();
    focus.onHide();
    Date.now = actualNow;
    sync.upsert = upsert;
  }
}

function checkBillPage() {
  const now = new Date();
  const date = formatDate(now);
  const first = repaymentId('card', date);
  miniStore.state.records.accounts = {
    card: wrapped('card', { kind: 'liability', name: '信用卡', balance: 0, currentBill: 1000, dueDay: now.getDate() }),
    cash: wrapped('cash', { kind: 'asset', name: '现金', balance: 0 })
  };
  miniStore.state.records.money = {
    [first]: wrapped(first, { type: 'transfer', accountId: 'cash', toAccountId: 'card', amount: 100, date })
  };
  const bills = loadPage('bills');
  bills.render();
  bills.openRepayment('card');
  assert.equal(bills.data.payment.amount, '900');
  assert.equal(bills.data.payment.id, repaymentId('card', date, 2));
  const originalUpsert = sync.upsert;
  const writes = [];
  try {
    sync.upsert = (...args) => writes.push(args);
    bills.data.payment.accountId = 'cash';
    bills.data.payment.amount = '901';
    bills.confirmPayment();
    assert.equal(writes.length, 0);
    bills.data.payment.amount = '900';
    bills.confirmPayment();
    assert.equal(writes.length, 1);
    assert.equal(writes[0][1].amount, 900);
    assert.equal(writes[0][2], repaymentId('card', date, 2));
    assert.equal(writes[0][3].createOnly, true);
  } finally {
    sync.upsert = originalUpsert;
  }
}

async function checkServer() {
  const dir = await mkdtemp(join(tmpdir(), 'life-efficiency-'));
  const config = {
    ...loadConfig(), dataDir: dir, avatarDir: '', devMode: true, requireHttps: false,
    wxAppId: 'stub-app', wxSecret: 'stub', wxHabitReminderTemplateId: 'stub-template',
    wxReminderTemplateId: 'stub-plan', wxBillReminderTemplateId: 'stub-bill', syncGeneration: 'original'
  };
  const store = process.env.LIFE_EFFICIENCY_MYSQL === '1' ? new MySqlStore(config) : new FileStore(config);
  const server = http.createServer(createApp(store, config, new Set()));
  try {
    await store.init();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    async function send(method, url, token, body) {
      const response = await fetch(base + url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body && JSON.stringify(body)
      });
      assert.equal(response.status, 200);
      return response.json();
    }
    const login = async () => (await send('POST', '/api/login', '', { code: 'fixture' })).token;
    const first = await login();
    const second = await login();
    const now = Date.now();
    const today = formatDate(new Date(now));
    const todayBit = 1 << ((new Date(now).getDay() + 6) % 7);
    const offDay = todayBit === 1 ? 2 : 1;
    const scheduled = (days) => ({ startDate: today, changes: [{ date: today, days, updatedAt: now }] });
    const put = (id, data, time = now) => send('PUT', '/api/records/habit/' + id, first, { data, updatedAt: time });
    await put('h1', { ...def, schedule: scheduled(todayBit) });
    const before = await send('GET', '/api/sync?sinceSeq=0', second);
    assert.deepEqual(before.changes.habit[0].data.schedule, scheduled(todayBit));
    await put('h1', { ...def, name: '旧客户端改名' }, now + 1);
    const after = await send('GET', '/api/sync?sinceSeq=' + before.cursor, second);
    assert.equal(after.changes.habit[0].data.name, '旧客户端改名');
    assert.deepEqual(after.changes.habit[0].data.schedule, scheduled(todayBit));
    const tomorrow = addDays(today, 1);
    await put('h1', { ...def, schedule: {
      startDate: today, changes: [
        { date: today, days: offDay, updatedAt: now - 10 },
        { date: tomorrow, days: 127, updatedAt: now + 2 }
      ]
    } }, now + 2);
    const merged = await send('GET', '/api/sync?sinceSeq=' + after.cursor, second);
    assert.deepEqual(merged.changes.habit[0].data.schedule.changes, [
      ...scheduled(todayBit).changes, { date: tomorrow, days: 127, updatedAt: now + 2 }
    ]);
    await put('rest', { ...def, schedule: scheduled(offDay) });
    await put('other', { ...def, schedule: scheduled(todayBit) });
    await put('partial', entry(today, 1));
    await put('complete', { ...entry(today, 3), habitId: 'other' });
    await send('PUT', '/api/records/settings/app', first, {
      data: { habitReminderEnabled: true, habitReminderTime: '00:00' }, updatedAt: now
    });
    await send('PUT', '/api/reminders/credit', first, { kind: 'habit' });
    const scans = await Promise.all([store.scanHabitReminders(today, now), store.scanHabitReminders(today, now)]);
    assert.equal(scans[0] + scans[1], 1);
    await put('partial', entry(today, 3), now + 2);
    let delivered = 0;
    const worker = createReminderWorker(store, config, async () => { delivered++; });
    await worker.runOnce();
    assert.equal(delivered, 0);
    assert.equal((await store.getLatestReminderForPlan('dev-user', 'habit:' + today)).status, 'cancelled');
    assert.equal((await store.getReminderCredits('dev-user')).habit, 1);
    assert.equal(await store.scanHabitReminders(today, now + 5), 0);
    const beforeAudit = await send('GET', '/api/sync?sinceSeq=0', first);
    const oldMoney = { type: 'expense', category: '其他', date: today, amount: 1.005, accountId: 'historical-cash' };
    await store.upsert('dev-user', 'accounts', 'historical-cash',
      { kind: 'asset', name: '现金', openingBalance: 10 }, now);
    await store.upsert('dev-user', 'money', 'old-decimal-a', oldMoney, now);
    await store.upsert('dev-user', 'money', 'old-decimal-b', oldMoney, now + 1);
    const history = await store.exportRecords('dev-user');
    const cursorBeforeAudit = await send('GET', '/api/sync?sinceSeq=' + beforeAudit.cursor, first);
    const audit = buildMoneyAudit(history);
    assert.equal(audit.adjustments.length, 2);
    assert.deepEqual(audit.accounts, [{ id: 'historical-cash', previousCents: 800, currentCents: 798, differenceCents: -2 }]);
    assert.deepEqual(audit.months[0].expense, { previousCents: 201, currentCents: 202, differenceCents: 1 });
    assert.deepEqual(await store.exportRecords('dev-user'), history);
    assert.deepEqual(await send('GET', '/api/sync?sinceSeq=' + cursorBeforeAudit.cursor, second).then((result) => result.changes), {});
    const oldUpload = await send('PUT', '/api/records/money/old-client-upload', first, { data: oldMoney, updatedAt: now });
    assert.equal(oldUpload.record.data.amount, 1.01);
    assert.equal((await store.getRecord('dev-user', 'money', 'old-client-upload')).data.amount, 1.01);
    const retryUpload = await send('PUT', '/api/records/money/old-client-upload', first, { data: oldMoney, updatedAt: now });
    assert.equal(retryUpload.record.data.amount, 1.01);
    const accountId = 'long-private-credit-account-for-payment-testing';
    await send('PUT', '/api/records/accounts/' + accountId, first, {
      data: { kind: 'liability', name: '信用卡', category: '信用卡', openingBalance: 0, currentBill: 100, dueDay: new Date(now).getDate() }
    });
    await send('PUT', '/api/records/settings/app', first, { data: { billReminderEnabled: true } });
    await send('PUT', '/api/reminders/credit', first, { kind: 'bill' });
    assert.equal(await store.scanBillReminders(today, now), 1);
    const billReminderId = 'bill:' + accountId + ':' + today;
    const pay = (token, id, amount, options = {}) => send('PUT', '/api/records/money/' + id, token, {
      createOnly: true,
      data: { type: 'transfer', accountId: 'cash', toAccountId: accountId, category: '账户转账', date: today, amount },
      ...options
    });
    await pay(first, repaymentId(accountId, today), 33.33);
    const pending = await store.getLatestReminderForPlan('dev-user', billReminderId);
    assert.equal(pending.status, 'pending');
    const alerts = await store.exportRecords('dev-user');
    assert.equal(buildBillAlerts(alerts.accounts, alerts.money, new Date(now))[0].remainingBill, 66.67);
    const secondPaymentId = repaymentId(accountId, today, 2);
    const settlement = await Promise.all([pay(first, secondPaymentId, 66.67), pay(second, secondPaymentId, 66.67)]);
    assert.equal(settlement.filter((result) => result.applied).length, 1);
    assert.equal((await store.getReminder(pending.id)).status, 'cancelled');
    const paidAt = settlement.find((result) => result.applied).record.updatedAt;
    await send('DELETE', '/api/records/money/' + secondPaymentId + '?updatedAt=' + (paidAt + 1), second);
    assert.equal(await store.scanBillReminders(today, now), 1);
    assert.equal((await store.getReminder(pending.id)).status, 'pending');

    const date = addDays(today, 1);
    const dueAt = new Date(date + 'T09:00:00').getTime();
    const plan = { title: '预约', date, time: '09:00', reminder: { enabled: true, dueAt } };
    const planUrl = '/api/records/plan/undo-plan';
    await send('PUT', planUrl, first, { data: { ...plan, done: false }, updatedAt: now });
    const planReminder = await store.createReminder('dev-user', 'undo-plan', { title: plan.title, dueAt });
    await send('PUT', planUrl, first, { data: { ...plan, done: true }, updatedAt: now + 1 });
    assert.equal((await store.getReminder(planReminder.id)).status, 'cancelled');
    await send('PUT', planUrl, second, { data: { ...plan, done: false }, updatedAt: now + 2 });
    assert.equal((await store.getReminder(planReminder.id)).status, 'pending');
    await send('PUT', planUrl, first, { data: { ...plan, done: true }, updatedAt: now + 3 });
    await send('DELETE', '/api/reminders/undo-plan', first);
    await send('PUT', planUrl, second, { data: { ...plan, done: false }, updatedAt: now + 4 });
    assert.equal((await store.getReminder(planReminder.id)).status, 'cancelled');

    const full = await send('GET', '/api/sync?sinceSeq=0', first);
    const discardedId = 'created-after-backup';
    await put(discardedId, def);
    const later = await send('GET', '/api/sync?sinceSeq=' + full.cursor, second);
    assert.equal(later.changes.habit[0].id, discardedId);
    if (store instanceof MySqlStore) {
      const connection = await store.pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute('DELETE FROM records WHERE owner_id = ? AND collection = ? AND record_id = ?', ['dev-user', 'habit', discardedId]);
        await connection.execute('UPDATE owner_seq SET seq = ? WHERE owner_id = ?', [full.cursor, 'dev-user']);
        await connection.commit();
      } finally {
        connection.release();
      }
    } else {
      delete store.db.records.habit['dev-user|' + discardedId];
      store.db.ownerSeqs['dev-user'] = full.cursor;
    }
    const ahead = await send('GET', '/api/sync?sinceSeq=' + later.cursor, second);
    assert.equal(ahead.reset, true);
    assert.equal(ahead.cursor, full.cursor);
    assert.deepEqual(ahead.changes, full.changes);

    await put('written-after-restore', def);
    config.syncGeneration = 'restored';
    const differentGeneration = await send('GET', '/api/sync?sinceSeq=' + later.cursor + '&generation=original', second);
    assert.equal(differentGeneration.reset, true);
    assert.equal(differentGeneration.generation, 'restored');
    assert.equal(differentGeneration.cursor, later.cursor);
    assert.ok(differentGeneration.changes.habit.some((record) => record.id === 'written-after-restore'));
    assert.ok(differentGeneration.changes.habit.every((record) => record.id !== discardedId));
    const caughtUp = await send('GET', '/api/sync?sinceSeq=' + later.cursor + '&generation=restored', second);
    assert.deepEqual(caughtUp.changes, {});
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

(async () => {
  const storage = new Map([['wb_life_token', 'test-session']]);
  global.wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    navigateTo: ({ url }) => { wx.lastUrl = url; },
    switchTab: ({ url }) => { wx.lastUrl = url; },
    showToast() {}
  };
  api.saveProfile({ accountKey: 'test-account' });
  checkHabitStats();
  checkSearch();
  checkMoney();
  const historical = [1.005, 1.005, 0.01, 0.10, 0.20].map((amount, index) =>
    wrapped('precision-' + index, { amount, type: 'expense', category: '其他', date: monday }));
  miniStore.state.records.money = Object.fromEntries(historical.map((record) => [record.id, record]));
  const source = { money: miniStore.state.records.money };
  assert.equal(buildMonthlyReport(source, monday.slice(0, 7)).finance.expense, 2.33);
  assert.equal(buildWeeklyReview(source, monday).finance.expense, 2.33);
  assert.equal(loadPage('today').computeTodayModel(monday, monday.slice(0, 7)).tOut, 2.33);
  const amountPage = loadPage('money');
  amountPage.setData({ month: monday.slice(0, 7) });
  amountPage.render();
  assert.equal(amountPage.data.sumOut, 2.33);
  amountPage.updateFilters({ typeFilter: 'expense' });
  assert.equal(amountPage.data.filteredOutText, '2.33');
  amountPage.onMoneyBlur({ currentTarget: { dataset: { path: 'form.amount', positive: true } }, detail: { value: '1.005' } });
  assert.equal(amountPage.data['form.amount'], '1.01');
  assert.deepEqual(buildMoneyCsv(source.money).trim().split(/\r?\n/).slice(1).map((row) => row.split(',')[3]),
    ['1.01', '1.01', '0.01', '0.1', '0.2']);
  checkBillPage();
  checkFocus();
  await checkServer();
  console.log('DAILY_EFFICIENCY_TEST_PASSED');
})().catch((error) => { console.error(error); process.exitCode = 1; });
