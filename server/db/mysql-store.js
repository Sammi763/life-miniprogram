const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { preserveHabitSchedule } = require('../../miniprogram/utils/habit-utils');
const { validateRecordData, preservePlanDetails } = require('../validation');
const { TRIAL_INSIGHT_PREFIX, aiConsentRevision } = require('../ai-consent');
const mysql = require('mysql2/promise');
const { hashSessionToken, isTokenHash } = require('../session-token');
const { scanBillReminders: scanBillRemindersShared, scanHabitReminders: scanHabitRemindersShared } = require('./reminder-scan');

const COLLECTIONS = ['money', 'habit', 'plan', 'fitness', 'shopping', 'media', 'accounts', 'settings', 'memories', 'focusSessions', 'weeklyReviews', 'moneyRules'];
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_]+$/;
const REMINDER_CREDIT_KINDS = ['habit', 'bill'];
const REQUIRED_TABLES = ['records', 'sessions', 'users', 'scheduled_reminders', 'app_secrets', 'ai_insights', 'reminder_credits', 'owner_seq'];

function assertDatabaseName(name) {
  if (!IDENTIFIER_PATTERN.test(name)) throw new Error('Invalid DB_NAME');
  return name;
}

function normalizeRecord(row) {
  let data = row.data;
  if (typeof data === 'string') data = JSON.parse(data);
  return {
    id: row.id,
    data: data || {},
    updatedAt: Number(row.updatedAt),
    deletedAt: Number(row.deletedAt) || 0
  };
}

function normalizeProfile(row, ownerId) {
  return {
    ownerId: ownerId || row.ownerId,
    nickname: String((row && row.nickname) || ''),
    phone: String((row && row.phone) || ''),
    updatedAt: Number((row && row.updatedAt) || 0)
  };
}

// MySQL 将 JSON 转为规范文本，使旧服务端变更可被识别，即便 updated_at 相同。
function recordFingerprint(data, updatedAt, deletedAt) {
  return `UNHEX(SHA2(CONCAT(CAST(${data} AS CHAR CHARACTER SET utf8mb4), ':', CAST(${updatedAt} AS UNSIGNED), ':', CAST(${deletedAt} AS UNSIGNED)), 256))`;
}

const STORED_FINGERPRINT = recordFingerprint('data', 'updated_at', 'deleted_at');
const UNPUBLISHED_RECORD = `seq = 0 OR NOT (seq_fingerprint <=> ${STORED_FINGERPRINT})`;
const WRITE_FINGERPRINT = recordFingerprint('CAST(? AS JSON)', '?', '?');
const WRITE_RECORD_SQL = `INSERT INTO records (owner_id, collection, record_id, data, updated_at, deleted_at, seq, seq_fingerprint)
  VALUES (?, ?, ?, ?, ?, ?, ?, ${WRITE_FINGERPRINT})
  ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at), deleted_at = VALUES(deleted_at),
    seq = VALUES(seq), seq_fingerprint = VALUES(seq_fingerprint)`;

function insertRecord(connection, ownerId, collection, id, data, updatedAt, deletedAt, seq) {
  const json = JSON.stringify(data);
  return connection.execute(WRITE_RECORD_SQL, [ownerId, collection, id, json, updatedAt, deletedAt, seq, json, updatedAt, deletedAt]);
}

async function readAiConsentRevision(db, ownerId, isTrial, lock = false) {
  const [rows] = await db.execute(
    `SELECT data, deleted_at AS deletedAt, seq FROM records
     WHERE owner_id = ? AND collection = 'settings' AND record_id = 'app'${lock ? ' FOR UPDATE' : ''}`,
    [ownerId]
  );
  const row = rows[0];
  return row ? aiConsentRevision({ ...normalizeRecord(row), seq: Number(row.seq) }, isTrial) : 0;
}

async function writeAiInsight(db, ownerId, insightKey, contextHash, content) {
  const now = Date.now();
  await db.execute(
    `INSERT INTO ai_insights (owner_id, insight_key, context_hash, content, generated_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE context_hash = VALUES(context_hash), content = VALUES(content), generated_at = VALUES(generated_at), updated_at = VALUES(updated_at)`,
    [ownerId, String(insightKey || ''), String(contextHash || ''), String(content || '').slice(0, 500), now, now]
  );
}

async function clearDisabledAiInsights(db, ownerId, settings) {
  const keepRegular = settings.aiConsent === true;
  const keepTrial = settings.trialAiConsent === true;
  if (keepRegular && keepTrial) return;
  if (!keepRegular && !keepTrial) {
    await db.execute('DELETE FROM ai_insights WHERE owner_id = ?', [ownerId]);
    return;
  }
  const comparison = keepTrial ? 'NOT LIKE' : 'LIKE';
  await db.execute(`DELETE FROM ai_insights WHERE owner_id = ? AND insight_key ${comparison} ?`, [ownerId, TRIAL_INSIGHT_PREFIX + '%']);
}

class MySqlStore {
  constructor(config) {
    this.config = config;
    this.pool = null;
    this.legacyUploadsAvailable = false;
  }

  async init() {
    const databaseName = assertDatabaseName(this.config.db.name);
    if (this.config.db.autoCreate) {
      const adminPool = mysql.createPool({
        host: this.config.db.host,
        port: this.config.db.port,
        user: this.config.db.user,
        password: this.config.db.password,
        waitForConnections: true,
        connectionLimit: 1
      });
      try {
        await adminPool.query(
          `CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        );
      } finally {
        await adminPool.end();
      }
    }
    this.pool = mysql.createPool({
      host: this.config.db.host,
      port: this.config.db.port,
      user: this.config.db.user,
      password: this.config.db.password,
      database: databaseName,
      waitForConnections: true,
      connectionLimit: this.config.db.connectionLimit,
      charset: 'utf8mb4',
      namedPlaceholders: false
    });
    if (this.config.db.runMigrations) await this.migrate();
    else await this.verifySchema();
  }

  async migrate() {
    if (!this.pool) throw new Error('MySQL store is not initialized');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    const statements = schema.split(/;\s*(?:\r?\n|$)/).map((sql) => sql.trim()).filter(Boolean);
    for (const statement of statements) await this.pool.query(statement);
    const [tokenColumns] = await this.pool.execute(
      "SELECT character_maximum_length AS length FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'sessions' AND column_name = 'token' LIMIT 1"
    );
    if (tokenColumns.length && Number(tokenColumns[0].length) < 64) {
      await this.pool.query('ALTER TABLE sessions MODIFY token CHAR(64) NOT NULL');
    }
    // 旧版本已存在的会话令牌统一转为哈希；客户端将于下一次请求时重新登录。
    await this.pool.query('UPDATE sessions SET token = SHA2(token, 256) WHERE CHAR_LENGTH(token) = 48');
    // 历史版本曾保存完整手机号；新版本仅保留可展示的掩码。
    await this.pool.query("UPDATE users SET phone = CONCAT(LEFT(phone, 3), '****', RIGHT(phone, 4)) WHERE phone REGEXP '^[0-9]{11}$'");
    await this.migrateChangeSeq();
    const [legacyTables] = await this.pool.execute(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'uploads' LIMIT 1"
    );
    this.legacyUploadsAvailable = legacyTables.length > 0;
  }

  /* 迁移在切换服务版本时执行。补发旧写入时从已发布序号头之后分配。 */
  async migrateChangeSeq() {
    const [columns] = await this.pool.execute(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'records' AND column_name IN ('seq', 'seq_fingerprint')"
    );
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('seq')) await this.pool.query('ALTER TABLE records ADD COLUMN seq BIGINT UNSIGNED NOT NULL DEFAULT 0');
    if (!names.has('seq_fingerprint')) await this.pool.query('ALTER TABLE records ADD COLUMN seq_fingerprint BINARY(32) NULL');

    const [seqIndexes] = await this.pool.execute(
      "SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'records' AND index_name = 'idx_records_owner_seq' LIMIT 1"
    );
    if (!seqIndexes.length) await this.pool.query('CREATE INDEX idx_records_owner_seq ON records (owner_id, seq)');

    const refreshHeads = `INSERT INTO owner_seq (owner_id, seq)
      SELECT owner_id, MAX(seq) FROM records WHERE seq > 0 GROUP BY owner_id
      ON DUPLICATE KEY UPDATE seq = GREATEST(seq, VALUES(seq))`;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(refreshHeads);
      await connection.query(`UPDATE records r JOIN (
        SELECT owner_id, collection, record_id,
          ROW_NUMBER() OVER (PARTITION BY owner_id ORDER BY updated_at, collection, record_id) AS rn
        FROM records WHERE ${UNPUBLISHED_RECORD}
      ) pending ON r.owner_id = pending.owner_id AND r.collection = pending.collection AND r.record_id = pending.record_id
      LEFT JOIN owner_seq head ON r.owner_id = head.owner_id
      SET r.seq = COALESCE(head.seq, 0) + pending.rn,
        r.seq_fingerprint = ${recordFingerprint('r.data', 'r.updated_at', 'r.deleted_at')}`);
      await connection.query(refreshHeads);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async verifySchema() {
    const [rows] = await this.pool.execute(
      "SELECT table_name AS tableName FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('records', 'sessions', 'users', 'scheduled_reminders', 'app_secrets', 'ai_insights', 'reminder_credits', 'owner_seq')"
    );
    const names = new Set(rows.map((row) => row.tableName));
    const missing = REQUIRED_TABLES.filter((name) => !names.has(name));
    if (missing.length) throw new Error('Database schema missing: ' + missing.join(', ') + '（先执行 db:migrate 再启动）');
    const [seqColumns] = await this.pool.execute(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'records' AND column_name IN ('seq', 'seq_fingerprint')"
    );
    if (seqColumns.length !== 2) throw new Error('Database schema is outdated: records.seq or records.seq_fingerprint missing（先执行 db:migrate 再启动）');
    const [unpublished] = await this.pool.query(`SELECT 1 FROM records WHERE ${UNPUBLISHED_RECORD} LIMIT 1`);
    if (unpublished.length) throw new Error('Database has unpublished record changes（先执行 db:migrate 再启动）');
    const [tokenColumns] = await this.pool.execute(
      "SELECT character_maximum_length AS length FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'sessions' AND column_name = 'token' LIMIT 1"
    );
    if (!tokenColumns.length || Number(tokenColumns[0].length) < 64) {
      throw new Error('Database schema is outdated: run db migration before starting production');
    }
    const [legacyTables] = await this.pool.execute(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'uploads' LIMIT 1"
    );
    this.legacyUploadsAvailable = legacyTables.length > 0;
  }

  async createSession(token, openid, expiresAt) {
    const tokenHash = hashSessionToken(token);
    await this.pool.execute(
      'INSERT INTO sessions (token, openid, expires_at) VALUES (?, ?, ?)',
      [tokenHash, openid, expiresAt]
    );
  }

  async getSession(token) {
    const tokenHash = hashSessionToken(token);
    const [rows] = await this.pool.execute(
      'SELECT token, openid, expires_at AS expiresAt FROM sessions WHERE token IN (?, ?) LIMIT 1',
      [tokenHash, String(token || '')]
    );
    if (!rows.length) return null;
    const storedToken = String(rows[0].token || '');
    // 平滑迁移旧版 48 位明文会话：首次使用后立即替换成哈希。
    if (!isTokenHash(storedToken)) {
      await this.pool.execute('UPDATE sessions SET token = ? WHERE token = ?', [tokenHash, storedToken]);
    }
    const session = { openid: rows[0].openid, expiresAt: Number(rows[0].expiresAt) };
    if (session.expiresAt < Date.now()) {
      await this.pool.execute('DELETE FROM sessions WHERE token = ?', [tokenHash]);
      return null;
    }
    const nextExpiry = Date.now() + this.config.tokenTtlDays * 24 * 3600 * 1000;
    await this.pool.execute('UPDATE sessions SET expires_at = ? WHERE token = ?', [nextExpiry, tokenHash]);
    session.expiresAt = nextExpiry;
    return session;
  }

  async cleanupSessions() {
    await this.pool.execute('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
  }

  async cleanupReminders(before) {
    const [result] = await this.pool.execute(
      "DELETE FROM scheduled_reminders WHERE status IN ('sent', 'failed', 'cancelled') AND updated_at < ?",
      [Number(before) || Date.now()]
    );
    return result.affectedRows;
  }

  async ping() {
    await this.pool.query('SELECT 1');
    return true;
  }

  async getProfile(ownerId) {
    const [rows] = await this.pool.execute(
      `SELECT owner_id AS ownerId, nickname, phone,
              phone_updated_at AS updatedAt
       FROM users WHERE owner_id = ? LIMIT 1`,
      [ownerId]
    );
    return normalizeProfile(rows[0], ownerId);
  }

  async updateProfile(ownerId, patch) {
    const current = await this.getProfile(ownerId);
    const next = normalizeProfile({
      ownerId,
      nickname: patch.nickname === undefined ? current.nickname : patch.nickname,
      phone: patch.phone === undefined ? current.phone : patch.phone,
      updatedAt: Date.now()
    }, ownerId);
    await this.pool.execute(
      `INSERT INTO users (owner_id, nickname, phone, phone_updated_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE nickname = VALUES(nickname),
       phone = VALUES(phone), phone_updated_at = VALUES(phone_updated_at)`,
      [ownerId, next.nickname, next.phone, next.phone ? next.updatedAt : 0]
    );
    return next;
  }

  async getChanges(ownerId, since) {
    const [rows] = await this.pool.execute(
      `SELECT collection, record_id AS id, data, updated_at AS updatedAt, deleted_at AS deletedAt
       FROM records WHERE owner_id = ? AND updated_at > ? ORDER BY updated_at ASC`,
      [ownerId, since]
    );
    const changes = {};
    for (const row of rows) {
      const record = normalizeRecord(row);
      if (record.deletedAt) record.data = null;
      (changes[row.collection] || (changes[row.collection] = [])).push(record);
    }
    return changes;
  }

  async getRecord(ownerId, collection, id) {
    const [rows] = await this.pool.execute(
      'SELECT record_id AS id, data, updated_at AS updatedAt, deleted_at AS deletedAt FROM records WHERE owner_id = ? AND collection = ? AND record_id = ?',
      [ownerId, collection, id]
    );
    return rows[0] ? normalizeRecord(rows[0]) : null;
  }

  async getCollection(ownerId, collection) {
    const [rows] = await this.pool.execute(
      `SELECT record_id AS id, data, updated_at AS updatedAt, deleted_at AS deletedAt
       FROM records WHERE owner_id = ? AND collection = ?`,
      [ownerId, collection]
    );
    return Object.fromEntries(rows.map((row) => {
      const record = normalizeRecord(row);
      return [record.id, { data: record.data, updatedAt: record.updatedAt, deletedAt: record.deletedAt }];
    }));
  }

  /*
   * owner 内单调变更序号（v2.12）：事务内原子自增并回读真实值。
   * INSERT...ON DUPLICATE KEY UPDATE 的 LAST_INSERT_ID(seq+1) 保证并发自增不重号；
   * 同事务 SELECT FOR UPDATE 回读，避免新建 owner 时 LAST_INSERT_ID 未定义的歧义。
   */
  async nextChangeSeq(connection, ownerId) {
    await connection.execute(
      'INSERT INTO owner_seq (owner_id, seq) VALUES (?, 1) ON DUPLICATE KEY UPDATE seq = LAST_INSERT_ID(seq + 1)',
      [ownerId]
    );
    const [rows] = await connection.execute(
      'SELECT seq FROM owner_seq WHERE owner_id = ? FOR UPDATE',
      [ownerId]
    );
    const seq = Number(rows[0] && rows[0].seq) || 1;
    return seq > 0 ? seq : 1;
  }

  async upsert(ownerId, collection, id, data, updatedAt, options) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.writeRecord(ownerId, collection, id, data, updatedAt, options);
      } catch (error) {
        if (attempt >= 2 || error.code !== 'ER_LOCK_DEADLOCK') throw error;
      }
    }
  }

  async writeRecord(ownerId, collection, id, data, updatedAt, options) {
    // createOnly（导入恢复语义）：只要记录已存在（存活或墓碑）就拒绝写入并回传服务端现状。
    // 检查在 FOR UPDATE 事务内、且先于 LWW —— 并发导入/多设备写入由行锁串行化，没有竞态窗口。
    const createOnly = Boolean(options && options.createOnly);
    const restore = options && options.restore;
    const replacesDeletedAt = options && options.replacesDeletedAt;
    const deletedAt = options && options.tombstone ? updatedAt : 0;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT record_id AS id, data, updated_at AS updatedAt, deleted_at AS deletedAt
         FROM records WHERE owner_id = ? AND collection = ? AND record_id = ? FOR UPDATE`,
        [ownerId, collection, id]
      );
      if (restore) {
        const old = rows.length && normalizeRecord(rows[0]);
        if (!old || old.deletedAt !== restore.deletedAt || old.deletedAt < restore.cutoff ||
            validateRecordData('memories', old.data)) {
          await connection.rollback();
          return { applied: false };
        }
        data = old.data;
        updatedAt = Math.max(updatedAt, old.updatedAt + 1);
      }
      if (createOnly && rows.length && !(replacesDeletedAt > 0 && Number(rows[0].deletedAt) === replacesDeletedAt)) {
        await connection.rollback();
        return { applied: false, reason: 'exists', record: normalizeRecord(rows[0]) };
      }
      if (rows.length && Number(rows[0].updatedAt) > updatedAt) {
        await connection.rollback();
        return { applied: false, reason: 'older', record: normalizeRecord(rows[0]) };
      }
      if (rows.length && !Number(rows[0].deletedAt)) {
        if (collection === 'plan') data = preservePlanDetails(normalizeRecord(rows[0]).data, data);
        if (collection === 'habit') data = preserveHabitSchedule(normalizeRecord(rows[0]).data, data);
      }
      // 只有真实应用的写入消耗序号：LWW 拒绝不推进游标，其他设备不会白拉一次
      const seq = await this.nextChangeSeq(connection, ownerId);
      await insertRecord(connection, ownerId, collection, id, data, updatedAt, deletedAt, seq);
      if (collection === 'settings' && id === 'app') await clearDisabledAiInsights(connection, ownerId, deletedAt ? {} : data);
      await connection.commit();
      return { applied: true, record: { id, data, updatedAt, deletedAt } };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async remove(ownerId, collection, id, updatedAt, fallbackData) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT record_id AS id, data, updated_at AS updatedAt, deleted_at AS deletedAt
         FROM records WHERE owner_id = ? AND collection = ? AND record_id = ? FOR UPDATE`,
        [ownerId, collection, id]
      );
      if (rows.length && Number(rows[0].updatedAt) > updatedAt) {
        await connection.rollback();
        return { applied: false, reason: 'older', record: normalizeRecord(rows[0]) };
      }
      const oldData = rows.length ? normalizeRecord(rows[0]).data : (fallbackData || {});
      const seq = await this.nextChangeSeq(connection, ownerId);
      await insertRecord(connection, ownerId, collection, id, oldData, updatedAt, updatedAt, seq);
      if (collection === 'settings' && id === 'app') await clearDisabledAiInsights(connection, ownerId, {});
      await connection.commit();
      return { applied: true };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /*
   * 按变更序号拉取（v2.12 下载游标）：seq > sinceSeq 升序全量返回，cursor 取 owner 序号头。
   * 本机写入不推进该游标 —— 晚到上传的旧时间戳记录（seq 已分配）不会被 since 一刀切掉。
   */
  async getChangesBySeq(ownerId, sinceSeq) {
    const requested = Math.max(0, Number(sinceSeq) || 0);
    // Read the head and matching rows from the same statement snapshot.
    const [rows] = await this.pool.execute(
      `SELECT head.seq AS head, r.collection, r.record_id AS id, r.data,
              r.updated_at AS updatedAt, r.deleted_at AS deletedAt, r.seq
       FROM (SELECT COALESCE((SELECT seq FROM owner_seq WHERE owner_id = ?), 0) AS seq) head
       LEFT JOIN records r ON r.owner_id = ? AND r.seq > IF(head.seq < ?, 0, ?)
       ORDER BY r.seq ASC`,
      [ownerId, ownerId, requested, requested]
    );
    const reset = requested > Number(rows[0].head);
    const changes = {};
    // 游标取"本批实际返回的最大 seq"（水位线）：协议承诺 changes 对 cursor 完备。
    // 单条查询内完成，不存在"cursor 越过未下发记录"的竞态；并发新写入留给下一次拉取。
    let cursor = reset ? 0 : requested;
    for (const row of rows) {
      if (!row.id) continue;
      cursor = Math.max(cursor, Number(row.seq) || 0);
      const record = normalizeRecord(row);
      if (record.deletedAt) record.data = null;
      (changes[row.collection] || (changes[row.collection] = [])).push(record);
    }
    return { cursor, changes, reset };
  }

  async exportRecords(ownerId) {
    const exported = {};
    for (const collection of COLLECTIONS) exported[collection] = await this.getCollection(ownerId, collection);
    return exported;
  }

  async getSecret(name) {
    const [rows] = await this.pool.execute(
      'SELECT secret_value AS secretValue FROM app_secrets WHERE secret_name = ? LIMIT 1',
      [String(name || '')]
    );
    return rows[0] ? String(rows[0].secretValue || '') : '';
  }

  async setSecret(name, value) {
    await this.pool.execute(
      `INSERT INTO app_secrets (secret_name, secret_value, updated_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE secret_value = VALUES(secret_value), updated_at = VALUES(updated_at)`,
      [String(name || ''), String(value || ''), Date.now()]
    );
  }

  async getAiInsight(ownerId, insightKey) {
    const [rows] = await this.pool.execute(
      `SELECT insight_key AS insightKey, context_hash AS contextHash, content, generated_at AS generatedAt
       FROM ai_insights WHERE owner_id = ? AND insight_key = ? LIMIT 1`,
      [ownerId, String(insightKey || '')]
    );
    return rows[0] || null;
  }

  async getAiConsentRevision(ownerId, isTrial) {
    return readAiConsentRevision(this.pool, ownerId, isTrial);
  }

  async saveAiInsight(ownerId, insightKey, contextHash, content, consentRevision) {
    if (!consentRevision) return false;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const currentRevision = await readAiConsentRevision(connection, ownerId, insightKey.startsWith(TRIAL_INSIGHT_PREFIX), true);
      if (currentRevision !== consentRevision) {
        await connection.rollback();
        return false;
      }
      await writeAiInsight(connection, ownerId, insightKey, contextHash, content);
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async createReminder(ownerId, planId, payload) {
    if (payload.onceId) {
      const now = Date.now();
      // The primary key makes concurrent scans for the same owner and day idempotent.
      const [result] = await this.pool.execute(
        `INSERT IGNORE INTO scheduled_reminders
         (id, owner_id, plan_id, title, due_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [payload.onceId, ownerId, planId, payload.title, payload.dueAt, now, now]
      );
      return result.affectedRows ? { id: payload.onceId } : null;
    }
    const connection = await this.pool.getConnection();
    const now = Date.now();
    const id = crypto.randomBytes(20).toString('hex');
    try {
      await connection.beginTransaction();
      await connection.execute(
        `UPDATE scheduled_reminders
         SET status = 'cancelled', cancelled_at = ?, updated_at = ?, lock_token = NULL, locked_at = 0
         WHERE owner_id = ? AND plan_id = ? AND status = 'pending'`,
        [now, now, ownerId, planId]
      );
      await connection.execute(
        `INSERT INTO scheduled_reminders
         (id, owner_id, plan_id, title, due_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [id, ownerId, planId, String(payload.title || ''), Number(payload.dueAt), now, now]
      );
      await connection.commit();
      return {
        id, ownerId, planId, title: String(payload.title || ''), dueAt: Number(payload.dueAt), status: 'pending',
        lockToken: '', lockedAt: 0, sentAt: 0, failedAt: 0, cancelledAt: 0, lastError: '', createdAt: now, updatedAt: now
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getReminder(id) {
    const [rows] = await this.pool.execute(
      `SELECT id, owner_id AS ownerId, plan_id AS planId, title, due_at AS dueAt, status,
              lock_token AS lockToken, locked_at AS lockedAt, sent_at AS sentAt, failed_at AS failedAt,
              cancelled_at AS cancelledAt, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt
       FROM scheduled_reminders WHERE id = ? LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  }

  async listDeletedMemories(owner, cutoff, offset) {
    const [rows] = await this.pool.execute(
      `SELECT record_id AS id, data, updated_at AS updatedAt, deleted_at AS deletedAt
       FROM records WHERE owner_id = ? AND collection = 'memories' AND deleted_at >= ?
       AND JSON_TYPE(JSON_EXTRACT(data, '$.content')) = 'STRING'
       ORDER BY deleted_at DESC, record_id LIMIT 21 OFFSET ?`, [owner, cutoff, offset]
    );
    return rows.map(normalizeRecord);
  }

  async listReminders(owner, pending, offset) {
    const [rows] = await this.pool.execute(
      `SELECT id, plan_id AS planId, title, due_at AS dueAt, status, updated_at AS updatedAt
       FROM scheduled_reminders WHERE owner_id = ? AND ${pending ? "status = 'pending'" : "status <> 'pending'"}
       ORDER BY ${pending ? 'due_at ASC' : 'updated_at DESC'}, id LIMIT 21 OFFSET ?`, [owner, offset]
    );
    return rows;
  }

  async getLatestReminderForPlan(ownerId, planId) {
    const [rows] = await this.pool.execute(
      `SELECT id, owner_id AS ownerId, plan_id AS planId, title, due_at AS dueAt, status,
              lock_token AS lockToken, locked_at AS lockedAt, sent_at AS sentAt, failed_at AS failedAt,
              cancelled_at AS cancelledAt, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt
       FROM scheduled_reminders WHERE owner_id = ? AND plan_id = ? ORDER BY created_at DESC LIMIT 1`,
      [ownerId, planId]
    );
    return rows[0] || null;
  }

  async cancelRemindersByPlan(ownerId, planId, reason = '') {
    const now = Date.now();
    const [result] = await this.pool.execute(
      `UPDATE scheduled_reminders
       SET status = 'cancelled', cancelled_at = ?, updated_at = ?, last_error = ?, lock_token = NULL, locked_at = 0
       WHERE owner_id = ? AND plan_id = ?
         AND (status = 'pending' OR (? = '' AND status = 'cancelled' AND last_error = 'plan_completed'))`,
      [now, now, reason, ownerId, planId, reason]
    );
    return result.affectedRows;
  }

  async resumeCancelledReminder(ownerId, id, reason, title, dueAt) {
    const [result] = await this.pool.execute(
      `UPDATE scheduled_reminders
       SET status = 'pending', title = ?, last_error = '', cancelled_at = 0, updated_at = ?
       WHERE owner_id = ? AND id = ? AND status = 'cancelled' AND last_error = ? AND due_at = ?`,
      [title, Date.now(), ownerId, id, reason, dueAt]
    );
    return result.affectedRows > 0;
  }

  async claimDueReminders(now, limit, lockToken) {
    const connection = await this.pool.getConnection();
    const staleBefore = Number(now) - 5 * 60 * 1000;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT id, owner_id AS ownerId, plan_id AS planId, title, due_at AS dueAt, status,
                lock_token AS lockToken, locked_at AS lockedAt, sent_at AS sentAt, failed_at AS failedAt,
                cancelled_at AS cancelledAt, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt
         FROM scheduled_reminders
         WHERE status = 'pending' AND due_at <= ? AND (locked_at = 0 OR locked_at < ?)
         ORDER BY due_at ASC LIMIT ? FOR UPDATE`,
        [Number(now), staleBefore, Math.max(1, Number(limit) || 20)]
      );
      for (const row of rows) {
        await connection.execute(
          `UPDATE scheduled_reminders SET lock_token = ?, locked_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
          [lockToken, Number(now), Number(now), row.id]
        );
        row.lockToken = lockToken;
        row.lockedAt = Number(now);
        row.updatedAt = Number(now);
      }
      await connection.commit();
      return rows;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async finishReminder(id, lockToken, status, lastError) {
    if (!['sent', 'failed', 'cancelled'].includes(status)) throw new Error('bad_reminder_status');
    const now = Date.now();
    const [result] = await this.pool.execute(
      `UPDATE scheduled_reminders
       SET status = ?, sent_at = ?, failed_at = ?, cancelled_at = ?, last_error = ?, updated_at = ?, lock_token = NULL, locked_at = 0
       WHERE id = ? AND status = 'pending' AND lock_token = ?`,
      [status, status === 'sent' ? now : 0, status === 'failed' ? now : 0, status === 'cancelled' ? now : 0, String(lastError || '').slice(0, 255), now, id, lockToken]
    );
    return result.affectedRows > 0;
  }

  /* ---------- v2.11 提醒矩阵：额度 + 扫描数据原语（扫描语义与 file 驱动共用 ./reminder-scan.js） ---------- */

  parseRecordData(value) {
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch (error) { return {}; }
    }
    return value || {};
  }

  async getReminderCredits(ownerId) {
    const [rows] = await this.pool.execute(
      'SELECT kind, credits FROM reminder_credits WHERE owner_id = ?',
      [ownerId]
    );
    const result = { habit: 0, bill: 0 };
    for (const row of rows) {
      if (row.kind in result) result[row.kind] = Math.max(0, Number(row.credits) || 0);
    }
    return result;
  }

  async addReminderCredit(ownerId, kind, delta) {
    if (!REMINDER_CREDIT_KINDS.includes(kind)) throw new Error('bad_reminder_kind');
    const step = Math.trunc(Number(delta) || 0);
    const now = Date.now();
    await this.pool.execute(
      `INSERT INTO reminder_credits (owner_id, kind, credits, updated_at)
       VALUES (?, ?, GREATEST(0, ?), ?)
       ON DUPLICATE KEY UPDATE credits = GREATEST(0, credits + ?), updated_at = VALUES(updated_at)`,
      [ownerId, kind, step, now, step]
    );
    const credits = await this.getReminderCredits(ownerId);
    return credits[kind];
  }

  async listReminderSettings() {
    const [rows] = await this.pool.execute(
      `SELECT owner_id AS ownerId, data FROM records WHERE collection = 'settings' AND record_id = 'app' AND deleted_at = 0`
    );
    return rows.map((row) => ({ ownerId: row.ownerId, data: this.parseRecordData(row.data) }));
  }

  async listHabitReminderRecords(today) {
    const [rows] = await this.pool.execute(
      `SELECT owner_id AS ownerId, record_id AS id, data, updated_at AS updatedAt FROM records
       WHERE collection = 'habit' AND deleted_at = 0
         AND (JSON_UNQUOTE(JSON_EXTRACT(data, '$.kind')) = 'def'
              OR JSON_UNQUOTE(JSON_EXTRACT(data, '$.date')) = ?)`,
      [String(today)]
    );
    return rows.map((row) => ({ ...row, data: this.parseRecordData(row.data) }));
  }

  async listBillRepayments(ownerId) {
    const [rows] = await this.pool.execute(
      `SELECT record_id AS id, data, updated_at AS updatedAt
       FROM records WHERE owner_id = ? AND collection = 'money' AND record_id LIKE 'repay-%' AND deleted_at = 0`,
      [ownerId]
    );
    return rows.map(normalizeRecord);
  }

  async listLiabilityAccounts() {
    const [rows] = await this.pool.execute(
      `SELECT owner_id AS ownerId, record_id AS id, data FROM records WHERE collection = 'accounts' AND deleted_at = 0`
    );
    return rows.map((row) => ({ ownerId: row.ownerId, id: row.id, data: this.parseRecordData(row.data) }));
  }

  async reminderExistsFor(ownerId, planId) {
    return Boolean(await this.getLatestReminderForPlan(ownerId, planId));
  }

  async scanHabitReminders(today, now) {
    return scanHabitRemindersShared(this, today, now);
  }

  async scanBillReminders(today, now) {
    return scanBillRemindersShared(this, today, now);
  }

  async deleteAccount(ownerId) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('DELETE FROM records WHERE owner_id = ?', [ownerId]);
      await connection.execute('DELETE FROM sessions WHERE openid = ?', [ownerId]);
      await connection.execute('DELETE FROM scheduled_reminders WHERE owner_id = ?', [ownerId]);
      await connection.execute('DELETE FROM ai_insights WHERE owner_id = ?', [ownerId]);
      await connection.execute('DELETE FROM reminder_credits WHERE owner_id = ?', [ownerId]);
      // v2.12：变更序号头一并清除（复核修复：否则已注销身份仍残留 owner_id 与递增序号）
      await connection.execute('DELETE FROM owner_seq WHERE owner_id = ?', [ownerId]);
      await connection.execute('DELETE FROM users WHERE owner_id = ?', [ownerId]);
      if (this.legacyUploadsAvailable) await connection.execute('DELETE FROM uploads WHERE owner_id = ?', [ownerId]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async close() {
    if (this.pool) await this.pool.end();
  }
}

module.exports = { MySqlStore, COLLECTIONS };
