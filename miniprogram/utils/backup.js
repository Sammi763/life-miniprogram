/* 备份导出与导入恢复：云端与本机统一为 v1 格式（含记录 ID），导入不覆盖现值、幂等可重复。
 *
 * 格式：
 *   { format: 'life-backup', version: 1, exportedAt: <ISO>, source: 'cloud'|'local',
 *     records: { <collection>: [ { id, data, updatedAt, deletedAt? }, ... ] },
 *     localWrites?: { pending: [...], rejected: [...] } }
 *
 * 兼容：
 *   - 旧云端导出（{exportedAt, records:{coll:{id:{data,updatedAt,deletedAt}}}} 的 map 形态，
 *     含记录 ID）自动归一化为 v1；
 *   - 旧「本机副本」（仅 data 数组、无 ID）无法定位记录、不承诺可恢复 —— 明确拒收。
 *
 * 导入规则（与产品口径一致）：
 *   - 备份中自带 deletedAt 的记录是「已删除数据」，一律跳过，绝不作为存活记录恢复；
 *   - 本地存在同 id 存活记录 → 跳过保留现值（不覆盖）；
 *   - 本地同 id 为墓碑 → 跳过保持删除；
 *   - 本地无此 id → 以原 id 创建，写入走服务端 createOnly（仅不存在时创建）：
 *     云端已有同 ID 存活记录或墓碑（含导入期间其他设备并发创建）时保留云端状态，
 *     本地随后被服务端权威回写覆盖 —— 仅在导入前 pull 不构成并发保护；
 *   - settings.aiConsent 强制置 false（AI 同意需重新选择）；plan 的 reminder 字段整体剥离；
 *   - 待同步队列非空或离线时不得导入；
 *   - 导入记录统一用新的 updatedAt（保留旧时间戳会破坏其他设备的增量拉取游标，
 *     原始时序由 data.date / data.occurredAt 等业务字段承载）。
 *
 * 容量边界（与导出能力对齐）：本机缓存单 key 上限 1MB（store.MAX_PERSIST_CHARS=900k），
 * 导入接受 ≤ 10,000 条 / 850,000 字符，并在预览期做「当前缓存 + 新建记录」动态预检；
 * 应用阶段分批（每批 50 条）「本地写入 → 入队 → await 冲刷」，队列不会随导入体量膨胀，
 * 网络中断即停止后续批次并如实报告已写入数量。超出容量边界的备份无法在本机恢复。 */

const store = require('./store');
const sync = require('./sync');
const { normalizeMoneyData } = require('./amount');
const { monthlyMoneyDifferences } = require('./money-audit');
const { ID_PATTERN, validateRecordData } = require('./record-validation');

const BACKUP_FORMAT = 'life-backup';
const BACKUP_VERSION = 1;
const MAX_IMPORT_CHARS = 850000;
const MAX_IMPORT_RECORDS = 10000;
const IMPORT_BATCH_SIZE = 50;
/* 预留队列/游标/元信息的余量：当前缓存 + 新建记录估算不得超过该值 */
const CAPACITY_BUDGET = store.MAX_PERSIST_CHARS - 80000;

/* ---------- 导出 ---------- */

function recordsToArray(recordsMap) {
  const output = {};
  for (const collection of store.COLLECTIONS) {
    const source = recordsMap && recordsMap[collection] ? recordsMap[collection] : {};
    output[collection] = Object.values(source).map((record) => ({
      id: record.id,
      data: record.data,
      updatedAt: record.updatedAt || 0,
      ...(record.deletedAt ? { deletedAt: record.deletedAt } : {})
    }));
  }
  return output;
}

/* 本机备份保留记录快照，以及可能与快照不同的本机待写和被拒改动。 */
function buildLocalBackup() {
  const { records, queue, rejectedWrites } = store.state;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    source: 'local',
    records: recordsToArray(records),
    ...(queue.length || rejectedWrites.length
      ? { localWrites: { pending: queue.slice(), rejected: rejectedWrites.slice() } }
      : {})
  };
}

/* 云端导出（GET /api/export 的响应）归一化为 v1 */
function normalizeCloudExport(payload) {
  const records = payload && payload.records;
  if (!records || typeof records !== 'object') return null;
  const normalized = {};
  for (const collection of store.COLLECTIONS) {
    const source = records[collection];
    if (!source || typeof source !== 'object') { normalized[collection] = []; continue; }
    // 旧云端导出是 map 形态；v1 是数组形态，两种都接受
    normalized[collection] = Array.isArray(source)
      ? source.map((entry) => ({
          id: entry.id,
          data: entry.data,
          updatedAt: entry.updatedAt || 0,
          ...(entry.deletedAt ? { deletedAt: entry.deletedAt } : {})
        }))
      : Object.keys(source).map((id) => ({
          id,
          data: source[id] && source[id].data,
          updatedAt: (source[id] && source[id].updatedAt) || 0,
          ...(source[id] && source[id].deletedAt ? { deletedAt: source[id].deletedAt } : {})
        }));
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: payload.exportedAt || new Date().toISOString(),
    source: 'cloud',
    records: normalized
  };
}

/* ---------- 导入：解析 ---------- */

function parseBackup(text) {
  const source = String(text || '').trim();
  if (!source) return { error: 'empty', message: '请先粘贴备份 JSON' };
  if (source.length > MAX_IMPORT_CHARS) {
    return { error: 'too_large', message: '备份超过 ' + Math.round(MAX_IMPORT_CHARS / 10000) / 100 + ' 万字符的本机容量边界，无法在手机上恢复；请分账号/分批处理' };
  }
  let parsed;
  try { parsed = JSON.parse(source); } catch (e) { return { error: 'bad_json', message: '不是有效的 JSON，请完整复制备份内容' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'bad_shape', message: '备份结构不正确' };

  // v1 格式
  if (parsed.format === BACKUP_FORMAT) {
    if (Number(parsed.version) !== BACKUP_VERSION) return { error: 'bad_version', message: '暂不支持的备份版本（v' + parsed.version + '）' };
    return fromRecordArrays(parsed.records, parsed.exportedAt, parsed.source, parsed.localWrites);
  }
  // 旧云端导出（map 形态、含 ID）
  if (parsed.records && typeof parsed.records === 'object' && !Array.isArray(parsed.records)) {
    const values = Object.values(parsed.records);
    const looksLikeMap = values.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
    if (looksLikeMap) {
      const normalized = normalizeCloudExport(parsed);
      if (normalized) return fromRecordArrays(normalized.records, normalized.exportedAt, 'cloud');
    }
  }
  // 旧本机副本：集合 → data 数组，无 id —— 无法定位记录，明确拒收
  const keys = Object.keys(parsed);
  if (keys.length && keys.every((key) => store.COLLECTIONS.includes(key) && Array.isArray(parsed[key]))) {
    return { error: 'legacy_local', message: '这是旧版本机备份（不含记录 ID），无法安全恢复；请在当前版本重新生成备份' };
  }
  return { error: 'bad_shape', message: '不是可识别的备份格式' };
}

function fromRecordArrays(records, exportedAt, source, localWrites) {
  if (!records || typeof records !== 'object') return { error: 'bad_shape', message: '备份缺少 records 字段' };
  let total = 0;
  const normalized = {};
  for (const collection of store.COLLECTIONS) {
    const entries = Array.isArray(records[collection]) ? records[collection] : [];
    normalized[collection] = entries;
    total += entries.length;
  }
  const unknown = Object.keys(records).filter((key) => !store.COLLECTIONS.includes(key));
  if (total > MAX_IMPORT_RECORDS) {
    return { error: 'too_many', message: '备份含 ' + total + ' 条记录，超过本机 ' + MAX_IMPORT_RECORDS + ' 条容量边界，无法完整恢复' };
  }
  const backup = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: exportedAt || '', source: source || '', records: normalized };
  if (source === 'local' && localWrites && Array.isArray(localWrites.pending) && Array.isArray(localWrites.rejected)) {
    backup.localWrites = { pending: localWrites.pending, rejected: localWrites.rejected };
  }
  return { backup, total, unknownCollections: unknown };
}

/* ---------- 导入：门槛与预览 ---------- */

function importBlockedReason() {
  if (store.state.queue.length) return '还有 ' + store.state.queue.length + ' 条改动正在等待保存到账号，请稍后再导入';
  if (store.state.syncState === 'offline') return '当前离线，请联网后再导入';
  return '';
}

/* 与产品口径一致的导入前清洗：AI 同意重置、提醒授权剥离 */
function sanitizeImportData(collection, data) {
  const cleaned = { ...(data && typeof data === 'object' ? data : {}) };
  if (collection === 'settings') {
    cleaned.aiConsent = false;
    delete cleaned.trialAiConsent;
  }
  if (collection === 'plan') delete cleaned.reminder;
  return cleaned;
}

function previewImport(backup) {
  const result = {
    total: 0, create: 0, skipLive: 0, skipDeleted: 0, skipBackupDeleted: 0,
    invalid: [], byCollection: {}, creates: [], roundedMoneyRecords: 0
  };
  const importedMoney = [];
  for (const collection of store.COLLECTIONS) {
    const existing = store.state.records[collection] || {};
    const stats = { create: 0, skipLive: 0, skipDeleted: 0, skipBackupDeleted: 0, invalid: 0 };
    const seen = new Set();
    for (const entry of backup.records[collection]) {
      result.total++;
      const id = entry && entry.id;
      if (seen.has(id)) { stats.invalid++; if (result.invalid.length < 5) result.invalid.push(collection + '/' + id + ' 重复出现'); continue; }
      seen.add(id);
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) { stats.invalid++; if (result.invalid.length < 5) result.invalid.push(collection + '/' + String(id) + ' 记录 ID 不合法'); continue; }
      /* 备份自带 deletedAt = 已删除数据：跳过且绝不复活 */
      if (entry.deletedAt) { stats.skipBackupDeleted++; continue; }
      const original = sanitizeImportData(collection, entry.data);
      const data = normalizeMoneyData(collection, original);
      const reason = validateRecordData(collection, data);
      if (reason) { stats.invalid++; if (result.invalid.length < 5) result.invalid.push(collection + '/' + id + ' 字段校验未通过'); continue; }
      const local = existing[id];
      if (local && !local.deletedAt) { stats.skipLive++; continue; }
      if (local && local.deletedAt) { stats.skipDeleted++; continue; }
      stats.create++;
      if (data !== original) result.roundedMoneyRecords++;
      if (collection === 'money') importedMoney.push({ data: original });
      result.creates.push({ collection, id, data });
    }
    if (stats.create || stats.skipLive || stats.skipDeleted || stats.skipBackupDeleted || stats.invalid) {
      result.byCollection[collection] = stats;
    }
    result.create += stats.create;
    result.skipLive += stats.skipLive;
    result.skipDeleted += stats.skipDeleted;
    result.skipBackupDeleted += stats.skipBackupDeleted;
    result.invalidCount = (result.invalidCount || 0) + stats.invalid;
  }
  result.moneyDifferences = monthlyMoneyDifferences(importedMoney).filter((row) =>
    [row.income, row.expense, row.transfer, row.balance].some((amount) => amount.differenceCents));
  /* 动态容量预检：当前本机缓存 + 本次新建记录的估算体积不得超过本机容量边界 */
  const estimatedChars = JSON.stringify(result.creates).length;
  const currentChars = store.localCacheChars();
  if (currentChars + estimatedChars > CAPACITY_BUDGET) {
    return {
      error: 'capacity',
      message: '恢复后预计占用约 ' + Math.round((currentChars + estimatedChars) / 1024) + 'KB，超过本机约 ' +
        Math.round(CAPACITY_BUDGET / 1024) + 'KB 的容量边界（当前已用 ' + Math.round(currentChars / 1024) + 'KB）。' +
        '请先清理不需要的内容或换一台本机记录较少的设备恢复。',
      currentChars, estimatedChars, capacityBudget: CAPACITY_BUDGET
    };
  }
  return result;
}

/* ---------- 导入：应用（分批 + 服务端 createOnly 并发保护） ---------- */

/*
 * 每批 IMPORT_BATCH_SIZE 条：本地乐观写入（带 createOnly 标记入队）→ await 冲刷 → 冲解。
 * 冲解口径：冲刷后仍保持本次写入时间戳且存活的记录才是「本次实际创建」；
 * 被服务端 reason=exists 权威回写（云端已有存活记录或墓碑，含并发创建）的记录计入
 * cloudResolved、不进入撤销清单。网络中断立即停止后续批次 —— 已写入的记录保留在本地
 * 与队列中（断点续传），返回值如实携带 created/stopped，绝不虚报「本机数据未变化」。
 */
async function applyImport(preview) {
  const applied = [];
  let created = 0;
  let cloudResolved = 0;
  let stopped = '';
  for (let index = 0; index < preview.creates.length; index += IMPORT_BATCH_SIZE) {
    const batch = preview.creates.slice(index, index + IMPORT_BATCH_SIZE);
    const batchApplied = [];
    for (const item of batch) {
      const ts = Date.now();
      sync.upsert(item.collection, item.data, item.id, { updatedAt: ts, createOnly: true });
      batchApplied.push({ collection: item.collection, id: item.id, importedUpdatedAt: ts });
    }
    try {
      await sync.flush();
    } catch (error) {
      stopped = '网络不可用，剩余记录已停止导入（本批已写入的记录保留，联网后自动续传）';
    }
    for (const entry of batchApplied) {
      const record = store.state.records[entry.collection] && store.state.records[entry.collection][entry.id];
      if (record && !record.deletedAt && record.updatedAt === entry.importedUpdatedAt) {
        created++;
        applied.push(entry);
      } else {
        cloudResolved++;
      }
    }
    if (stopped) break;
  }
  return { applied, created, cloudResolved, stopped, total: preview.creates.length };
}

/* 撤销：只作用于「本次实际创建且未被后续修改」的记录（时间戳仍等于本次写入值）。
 * 已被用户改动或被云端记录接管的 id 不动 —— 撤销不能删除别人的数据。 */
function undoImport(applied) {
  let count = 0;
  for (const item of applied) {
    const record = store.state.records[item.collection] && store.state.records[item.collection][item.id];
    if (record && !record.deletedAt && record.updatedAt === item.importedUpdatedAt) {
      sync.remove(item.collection, item.id);
      count++;
    }
  }
  return count;
}

module.exports = {
  BACKUP_FORMAT, BACKUP_VERSION, MAX_IMPORT_CHARS, MAX_IMPORT_RECORDS, IMPORT_BATCH_SIZE, CAPACITY_BUDGET,
  buildLocalBackup, normalizeCloudExport, parseBackup,
  importBlockedReason, previewImport, applyImport, undoImport, sanitizeImportData
};
