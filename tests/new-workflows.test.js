const assert = require('node:assert/strict');
const { mkdtemp, rm, mkdir, copyFile, readFile, readdir, stat } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const sharp = require('../server/node_modules/sharp');
const { WebSocket } = require('../server/node_modules/ws');
const { start } = require('../server/server');
const { createReminderWorker } = require('../server/reminders');
const { validateRecordData } = require('../miniprogram/utils/record-validation');
const { derivePlanOccurrences, occurrencePatch } = require('../miniprogram/utils/plan-utils');
const { cycleId, dueCycles, repaymentId } = require('../miniprogram/utils/money-rules');
const { buildBillAlerts, summarizeMoney } = require('../miniprogram/utils/ledger-utils');

const driver = process.env.LIFE_TEST_DRIVER === 'mysql' ? 'mysql' : 'file';

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'life-workflows-'));
  Object.assign(process.env, {
    DEV_MODE: '1', BIND_HOST: '127.0.0.1', PORT: '0', STORAGE_DRIVER: driver, DATA_DIR: dir, AVATAR_DIR: '',
    REQUIRE_HTTPS: '0', AI_ENABLED: '0', WX_APPID: '', WX_SECRET: '', WX_REMINDER_TEMPLATE_ID: '',
    WX_HABIT_REMINDER_TEMPLATE_ID: '', WX_BILL_REMINDER_TEMPLATE_ID: ''
  });
  const sockets = [];
  try {
    const { server, store } = await start();
    const base = 'http://127.0.0.1:' + server.address().port;
    const send = async (method, endpoint, token, data) => {
      const response = await fetch(base + endpoint, {
        method, headers: { ...(token && { Authorization: 'Bearer ' + token }), ...(data && { 'Content-Type': 'application/json' }) },
        body: data && JSON.stringify(data)
      });
      const kind = response.headers.get('content-type') || '';
      return { status: response.status, body: kind.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
    };
    const login = async () => (await send('POST', '/api/login', '', { code: 'fixture' })).body.token;
    const token = await login();
    const secondDevice = await login();
    const stranger = 'other-' + 'a'.repeat(42);
    await store.createSession(stranger, 'other-user', Date.now() + 60000);
    const image = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#885548' } }).png().toBuffer();
    const avatarRoute = '/api/profile/avatar';
    assert.equal((await send('GET', avatarRoute)).status, 401);
    const saved = await send('PUT', avatarRoute, token, { image: image.toString('base64') });
    assert.equal(saved.status, 200);
    assert.match(saved.body.profile.avatarVersion, /^[0-9a-f]{64}$/);
    assert.equal((await send('PUT', avatarRoute, token, { image: 'YWJj' })).status, 422);
    const download = await send('GET', avatarRoute, secondDevice);
    assert.equal(download.status, 200);
    assert.equal((await sharp(download.body).metadata()).format, 'jpeg');
    assert.equal((await send('GET', avatarRoute, stranger)).status, 404);
    assert.equal((await send('GET', '/api/profile', secondDevice)).body.profile.avatarVersion, saved.body.profile.avatarVersion);

    const backupRoot = path.join(dir, 'backup-fixture');
    await mkdir(path.join(backupRoot, 'scripts'), { recursive: true });
    await copyFile(path.join(__dirname, '../server/scripts/backup-avatars.sh'), path.join(backupRoot, 'scripts/backup-avatars.sh'));
    execFileSync('bash', [path.join(backupRoot, 'scripts/backup-avatars.sh')], { env: { ...process.env, BACKUP_RETENTION_DAYS: '30' } });
    const backups = path.join(backupRoot, 'db/backups');
    const [archive] = await readdir(backups);
    assert.equal((await stat(path.join(backups, archive))).mode & 0o777, 0o600);
    const restored = path.join(dir, 'restored');
    await mkdir(restored);
    execFileSync('tar', ['-xzf', path.join(backups, archive), '-C', restored]);
    const [filename] = await readdir(restored);
    assert.deepEqual(await readFile(path.join(restored, filename)), download.body);
    assert.equal((await send('DELETE', avatarRoute, secondDevice)).status, 200);
    assert.equal((await send('GET', avatarRoute, token)).status, 404);

    const connect = async (session) => {
      const socket = new WebSocket(base.replace('http', 'ws') + '/ws?token=' + session);
      sockets.push(socket);
      await once(socket, 'open');
      return socket;
    };
    const ws = await connect(secondDevice);
    const wsOther = await connect(stranger);
    let foreign = 0;
    wsOther.on('message', () => { foreign++; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const memory = { content: '随记恢复测试', occurredAt: '2024-02-29T10:30', mood: 'calm', tags: ['生活'] };
    const recordUrl = '/api/records/memories/m1';
    const signal = once(ws, 'message');
    assert.equal((await send('PUT', recordUrl, token, { data: memory })).status, 200);
    assert.equal(JSON.parse((await signal)[0]).id, 'm1');
    const deletedAt = Date.now();
    await send('DELETE', recordUrl + '?updatedAt=' + deletedAt, token);
    const list = '/api/memories/deleted';
    assert.equal((await send('GET', list, token)).body.items[0].id, 'm1');
    assert.deepEqual((await send('GET', list, stranger)).body.items, []);
    assert.equal((await send('POST', '/api/memories/m1/restore', stranger, { deletedAt })).status, 409);
    const restores = await Promise.all([token, secondDevice].map((session) => send('POST', '/api/memories/m1/restore', session, { deletedAt })));
    assert.deepEqual(restores.map((r) => r.status).sort(), [200, 409]);
    assert.deepEqual((await send('GET', '/api/sync?sinceSeq=0', secondDevice)).body.changes.memories[0].data, memory);
    assert.equal(foreign, 0);

    const reminder = await store.createReminder('dev-user', 'meeting', { dueAt: Date.now() - 1000, title: '会议' });
    assert.equal((await send('GET', '/api/reminders', token)).body.items[0].planId, 'meeting');
    assert.deepEqual((await send('GET', '/api/reminders', stranger)).body.items, []);
    const deliveries = [];
    const worker = createReminderWorker(store, { wxAppId: 'stub', wxSecret: 'stub', wxReminderTemplateId: 'stub' },
      async (config, notice) => { deliveries.push(notice); });
    await worker.runOnce();
    assert.equal(deliveries.length, 1);
    assert.equal((await store.getReminder(reminder.id)).status, 'sent');
    const history = (await send('GET', '/api/reminders?view=history', token)).body.items[0];
    assert.equal(history.status, 'sent');
    assert.equal(history.lastError, undefined);

    const weekly = { weekStart: '2026-11-23', reflection: '本周发现', adjustment: '下周开始整理' };
    const focus = { date: weekly.weekStart, startedAt: 1000, endedAt: 16000, sourceKind: 'plan', sourceId: 'meeting', title: '会议' };
    for (const [collection, id, data] of [['weeklyReviews', weekly.weekStart, weekly], ['focusSessions', 's1', focus]]) {
      assert.equal((await send('PUT', '/api/records/' + collection + '/' + id, token, { data, createOnly: true })).body.applied, true);
      assert.deepEqual((await send('GET', '/api/records/' + collection, secondDevice)).body.records[id].data, data);
    }
    const id = cycleId('rent', '2024-02-29');
    const expense = { type: 'expense', amount: 10, category: '住房', date: '2024-02-29' };
    const cycle = (session, data) => send('PUT', '/api/records/money/' + id, session, { data, createOnly: true });
    const confirmed = await Promise.all([cycle(token, expense), cycle(secondDevice, { ...expense, amount: 20 })]);
    assert.equal(confirmed.filter((r) => r.body.applied).length, 1);
    assert.equal((await cycle(token, { skipped: true })).body.reason, 'exists');
    const secondCycle = '/api/records/money/' + cycleId('rent', '2024-03-31');
    assert.equal((await send('PUT', secondCycle, token, { data: { skipped: true }, createOnly: true })).body.applied, true);
    assert.equal((await send('PUT', secondCycle, token, { data: expense, createOnly: true })).body.reason, 'exists');

    const repayUrl = '/api/records/money/' + repaymentId('card', '2026-11-30');
    const transfer = { type: 'transfer', accountId: 'cash', toAccountId: 'card', category: '账户转账', date: '2026-11-24', amount: 12 };
    const repay = (session, data, options = {}) => send('PUT', repayUrl, session, { data, createOnly: true, ...options });
    const repayment = await repay(token, transfer);
    assert.equal(repayment.body.applied, true);
    const removedAt = repayment.body.record.updatedAt + 1;
    await send('DELETE', repayUrl + '?updatedAt=' + removedAt, token);
    assert.equal((await repay(token, transfer)).body.reason, 'exists');
    assert.equal((await repay(token, transfer, { replacesDeletedAt: removedAt - 1, updatedAt: removedAt + 1 })).body.reason, 'exists');
    const corrected = await Promise.all([token, secondDevice].map((session, index) =>
      repay(session, { ...transfer, amount: 24 + index }, { replacesDeletedAt: removedAt, updatedAt: removedAt + 1 })));
    assert.equal(corrected.filter((response) => response.body.applied).length, 1);
    assert.equal(corrected.filter((response) => response.body.reason === 'exists').length, 1);

    if (driver === 'mysql') {
      const owner = 'rollback-fixture';
      await store.upsert(owner, 'shopping', 'stable', { name: '不变' }, 1000);
      await store.upsert(owner, 'shopping', 'edited', { name: '原始' }, 1000);
      const initial = await store.getChangesBySeq(owner, 0);
      await store.pool.execute('UPDATE records SET data = ? WHERE owner_id = ? AND record_id = ?', [
        JSON.stringify({ name: '回退期间同时间戳修改' }), owner, 'edited'
      ]);
      await assert.rejects(store.verifySchema(), /unpublished record changes/);
      await store.migrateChangeSeq();
      await store.verifySchema();
      const onlyEdit = await store.getChangesBySeq(owner, initial.cursor);
      assert.deepEqual(onlyEdit.changes.shopping.map((row) => row.id), ['edited']);
      assert.equal(onlyEdit.changes.shopping[0].data.name, '回退期间同时间戳修改');
      await store.pool.execute(
        "INSERT INTO records (owner_id, collection, record_id, data, updated_at) VALUES (?, 'shopping', 'new', ?, 900)",
        [owner, JSON.stringify({ name: '回退期间新增' })]
      );
      await store.pool.execute('UPDATE records SET updated_at = ?, deleted_at = ? WHERE owner_id = ? AND record_id = ?', [
        1100, 1100, owner, 'edited'
      ]);
      await store.migrateChangeSeq();
      const upgraded = await store.getChangesBySeq(owner, onlyEdit.cursor);
      assert.deepEqual(upgraded.changes.shopping.map((row) => [row.id, row.deletedAt]), [['new', 0], ['edited', 1100]]);
      await store.migrateChangeSeq();
      assert.deepEqual((await store.getChangesBySeq(owner, upgraded.cursor)).changes, {});
    }

    assert.equal((await send('PUT', avatarRoute, token, { image: image.toString('base64') })).status, 200);
    assert.equal((await send('DELETE', '/api/account', token, { code: 'fixture' })).status, 204);
    assert.equal((await send('GET', avatarRoute, await login())).status, 404);
    sockets.forEach((socket) => socket.close());
    await store.close();
    console.info('NEW_WORKFLOWS_TEST_PASSED ' + driver);
  } finally {
    sockets.forEach((socket) => socket.terminate());
    await rm(dir, { recursive: true, force: true });
  }
}

function rulesAndPlans() {
  const records = { series: { id: 'series', data: {
    kind: 'series', title: '复习', startDate: '2024-02-28', time: '08:00', repeat: 'daily', subtasks: [{ id: 't1', title: '读书' }]
  } } };
  const [first] = derivePlanOccurrences(records, '2024-02-28', '2024-02-29');
  const write = occurrencePatch(records, first, { completedSubtasks: ['t1'], titleOverride: '只改这天', timeOverride: '' });
  records[write.id] = write;
  records[write.id] = occurrencePatch(records, first, { done: true });
  const [a, b] = derivePlanOccurrences(records, '2024-02-28', '2024-02-29');
  assert.equal(a.subtasks[0].done, true);
  assert.equal(a.title, '只改这天');
  assert.equal(a.time, '');
  assert.equal(b.subtasks[0].done, false);
  assert.equal(b.title, '复习');
  assert.equal(validateRecordData('plan', records[write.id].data), '');
  const rule = { title: '房租', type: 'expense', amount: 10, category: '居住', startDate: '2024-01-31', effective: '2024-01-31', frequency: 'monthly', active: true };
  const versions = [rule, { ...rule, amount: 15, effective: '2024-03-02' }];
  assert.equal(validateRecordData('moneyRules', { versions }), '');
  const cycles = dueCycles({ rent: { data: { versions } } }, { [cycleId('rent', '2024-01-31')]: { deletedAt: 1 } }, '2024-03-31');
  assert.deepEqual(cycles.map(({ date, amount }) => [date, amount]), [['2024-03-31', 15], ['2024-02-29', 10]]);
  const account = { card: { id: 'card', data: { kind: 'liability', name: '卡', currentBill: 10, dueDay: 31 } } };
  const id = repaymentId('card', '2024-02-29');
  const transfer = { [id]: { id, data: { type: 'transfer', accountId: 'cash', toAccountId: 'card', amount: 10, date: '2024-02-28' } } };
  assert.equal(buildBillAlerts(account, transfer, new Date(2024, 1, 28)).length, 0);
  assert.deepEqual(summarizeMoney(transfer, '2024-02'), { income: 0, expense: 0, balance: 0, transfer: 10 });
}

Promise.resolve().then(rulesAndPlans).then(main).then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
