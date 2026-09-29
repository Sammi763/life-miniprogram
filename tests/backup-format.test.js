/*
 * 备份 v1 格式 —— 云端与本机统一、含记录 ID；旧格式兼容口径。
 * 运行：node tests/backup-format.test.js
 */
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');

const mem = {};
global.wx = {
  getStorageSync: (k) => (k in mem ? mem[k] : ''),
  setStorageSync: (k, v) => { mem[k] = v; },
  removeStorageSync: (k) => { delete mem[k]; },
  onNetworkStatusChange() {},
  connectSocket: () => ({ onOpen() {}, onMessage() {}, onClose() {}, onError() {}, close() {}, send() {} })
};

const store = require(path.join(root, 'miniprogram', 'utils', 'store'));
const backup = require(path.join(root, 'miniprogram', 'utils', 'backup'));

(async () => {
  store.loadLocal();
  for (const coll of store.COLLECTIONS) store.state.records[coll] = {};
  store.applyLocalUpsert('money', { id: 'm1', data: { type: 'expense', amount: 12, category: '餐饮', date: '2026-09-01' }, updatedAt: 100, deletedAt: 0 });
  store.applyLocalUpsert('money', { id: 'm2', data: { type: 'expense', amount: 1, category: '交通', date: '2026-09-02' }, updatedAt: 200, deletedAt: 200 });
  store.applyLocalUpsert('settings', { id: 'app', data: { budget: 3000, aiConsent: true }, updatedAt: 300, deletedAt: 0 });

  /* ---------- 1. 本机备份：v1 结构、含 ID、含墓碑（无损） ---------- */
  const local = backup.buildLocalBackup();
  assert.strictEqual(local.format, 'life-backup');
  assert.strictEqual(local.version, 1);
  assert.strictEqual(local.source, 'local');
  assert.ok(local.exportedAt, '必须有导出时间');
  for (const coll of store.COLLECTIONS) assert.ok(Array.isArray(local.records[coll]), '每个集合都必须是数组形态');
  const m1 = local.records.money.find((r) => r.id === 'm1');
  const m2 = local.records.money.find((r) => r.id === 'm2');
  assert.strictEqual(m1.data.category, '餐饮');
  assert.strictEqual(m2.deletedAt, 200, '墓碑必须保留（无损）');
  assert.strictEqual(local.records.settings[0].data.aiConsent, true, '导出保持原样，导入侧才做授权清洗');

  /* ---------- 2. 云端导出归一化：map 形态与数组形态都收 ---------- */
  const cloudMap = {
    exportedAt: '2026-09-01T00:00:00.000Z',
    records: {
      money: { m1: { data: { type: 'expense', amount: 12, category: '餐饮', date: '2026-09-01' }, updatedAt: 100, deletedAt: 0 } },
      habit: {}
    }
  };
  const normalized = backup.normalizeCloudExport(cloudMap);
  assert.strictEqual(normalized.source, 'cloud');
  assert.ok(Array.isArray(normalized.records.money));
  assert.strictEqual(normalized.records.money[0].id, 'm1');
  assert.strictEqual(normalized.exportedAt, '2026-09-01T00:00:00.000Z', '保留云端导出时间');
  const cloudArray = { exportedAt: 'x', records: { money: [{ id: 'm1', data: {}, updatedAt: 1 }] } };
  assert.ok(Array.isArray(backup.normalizeCloudExport(cloudArray).records.money), 'v1 数组形态直接透传');

  /* ---------- 3. parseBackup：v1 / 旧云端可解析；旧本机副本明确拒收 ---------- */
  const v1Text = JSON.stringify(backup.buildLocalBackup());
  const parsed = backup.parseBackup(v1Text);
  assert.ok(!parsed.error, 'v1 必须可解析');
  assert.strictEqual(parsed.total, 3);

  const legacyCloud = backup.parseBackup(JSON.stringify(cloudMap));
  assert.ok(!legacyCloud.error, '旧云端导出（含 ID）必须可解析');

  const legacyLocal = { money: [{ type: 'expense', amount: 12, category: '餐饮', date: '2026-09-01' }] };
  const rejected = backup.parseBackup(JSON.stringify(legacyLocal));
  assert.strictEqual(rejected.error, 'legacy_local', '旧本机副本（无 ID）必须明确拒收');
  assert.ok(/无法/.test(rejected.message), '拒收文案必须说明原因');

  assert.strictEqual(backup.parseBackup('').error, 'empty');
  assert.strictEqual(backup.parseBackup('not json').error, 'bad_json');
  assert.strictEqual(backup.parseBackup('{"format":"life-backup","version":9}').error, 'bad_version');
  assert.strictEqual(backup.parseBackup('{"format":"life-backup","version":1,"records":{"money":[]}}').error, undefined, 'records 缺失的集合按空处理');

  /* ---------- 4. 容量上限 ---------- */
  const big = { format: 'life-backup', version: 1, records: { money: [] } };
  // 最小条目（解析层不校验 data 内容），确保先触发条数上限而不是字符上限
  for (let i = 0; i < backup.MAX_IMPORT_RECORDS + 1; i++) {
    big.records.money.push({ id: 'm' + i, data: 1, updatedAt: 0 });
  }
  assert.strictEqual(backup.parseBackup(JSON.stringify(big)).error, 'too_many', '超过记录数上限必须拒收');
  assert.strictEqual(backup.parseBackup('x'.repeat(backup.MAX_IMPORT_CHARS + 1)).error, 'too_large');

  /* ---------- 5. 容量边界与导出能力对齐：约 500 条长备注（服务端允许 500 字）必须可导入 ---------- */
  const longNotes = { format: 'life-backup', version: 1, exportedAt: 'x', source: 'cloud', records: { money: [] } };
  const longNote = '长'.repeat(480);
  for (let i = 0; i < 500; i++) {
    longNotes.records.money.push({
      id: 'note-' + i,
      data: { type: 'expense', amount: 1 + i / 100, category: '餐饮', date: '2026-09-01', note: longNote },
      updatedAt: i
    });
  }
  const longText = JSON.stringify(longNotes);
  assert.ok(longText.length > backup.MAX_IMPORT_CHARS / 4, '场景构造检查：长备注体量应显著超过旧 30 万字符上限的一半');
  const longParsed = backup.parseBackup(longText);
  assert.ok(!longParsed.error, '500 条长备注必须可解析（旧 300k 上限会拒收当前版本的合法导出）');
  const longPreview = backup.previewImport(longParsed.backup);
  assert.ok(!longPreview.error, '空库 + 500 条长备注不得触发容量预检');
  assert.strictEqual(longPreview.create, 500);
  assert.ok(backup.MAX_IMPORT_RECORDS > 2000, '导入记录上限必须覆盖超过 2000 条的场景');
  assert.ok(backup.MAX_IMPORT_CHARS > 300000, '导入字符上限必须高于旧 30 万字符');

  console.log('BACKUP_FORMAT_TEST_PASSED');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
