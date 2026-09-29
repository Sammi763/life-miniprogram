const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { hashSessionToken, isTokenHash } = require('../session-token');

const COLLECTIONS = ['money', 'habit', 'plan', 'fitness', 'shopping', 'media', 'accounts', 'settings', 'memories'];
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_]+$/;

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
    const [legacyTables] = await this.pool.execute(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'uploads' LIMIT 1"
    );
    this.legacyUploadsAvailable = legacyTables.length > 0;
  }

  async verifySchema() {
    const [rows] = await this.pool.execute(
      "SELECT table_name AS tableName FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('records', 'sessions', 'users', 'scheduled_reminders', 'app_secrets', 'ai_insights')"
    );
    const names = new Set(rows.map((row) => row.tableName));
    const required = ['records', 'sessions', 'users', 'scheduled_reminders', 'app_secrets', 'ai_insights'];
    const missing = required.filter((name) => !names.has(name));
    if (missing.length) throw new Error('Database schema missing: ' + missing.join(', '));
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

  async upsert(ownerId, collection, id, data, updatedAt, options) {
    // createOnly（导入恢复语义）：只要记录已存在（存活或墓碑）就拒绝写入并回传服务端现状。
    // 检查在 FOR UPDATE 事务内、且先于 LWW —— 并发导入/多设备写入由行锁串行化，没有竞态窗口。
    const createOnly = Boolean(options && options.createOnly);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT record_id AS id, data, updated_at AS updatedAt, deleted_at AS deletedAt
         FROM records WHERE owner_id = ? AND collection = ? AND record_id = ? FOR UPDATE`,
        [ownerId, collection, id]
      );
      if (createOnly && rows.length) {
        await connection.rollback();
        return { applied: false, reason: 'exists', record: normalizeRecord(rows[0]) };
      }
      if (rows.length && Number(rows[0].updatedAt) > updatedAt) {
        await connection.rollback();
        return { applied: false, reason: 'older', record: normalizeRecord(rows[0]) };
      }
      await connection.execute(
        `INSERT INTO records (owner_id, collection, record_id, data, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at), deleted_at = 0`,
        [ownerId, collection, id, JSON.stringify(data), updatedAt]
      );
      await connection.commit();
      return { applied: true, record: { id, data, updatedAt, deletedAt: 0 } };
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
      await connection.execute(
        `INSERT INTO records (owner_id, collection, record_id, data, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at), deleted_at = VALUES(deleted_at)`,
        [ownerId, collection, id, JSON.stringify(oldData), updatedAt, updatedAt]
      );
      await connection.commit();
      return { applied: true };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
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

  async saveAiInsight(ownerId, insightKey, contextHash, content) {
    const now = Date.now();
    await this.pool.execute(
      `INSERT INTO ai_insights (owner_id, insight_key, context_hash, content, generated_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE context_hash = VALUES(context_hash), content = VALUES(content), generated_at = VALUES(generated_at), updated_at = VALUES(updated_at)`,
      [ownerId, String(insightKey || ''), String(contextHash || ''), String(content || '').slice(0, 500), now, now]
    );
  }

  async deleteAiInsights(ownerId) {
    const [result] = await this.pool.execute('DELETE FROM ai_insights WHERE owner_id = ?', [ownerId]);
    return result.affectedRows;
  }

  async createReminder(ownerId, planId, payload) {
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

  async cancelRemindersByPlan(ownerId, planId) {
    const now = Date.now();
    const [result] = await this.pool.execute(
      `UPDATE scheduled_reminders
       SET status = 'cancelled', cancelled_at = ?, updated_at = ?, lock_token = NULL, locked_at = 0
       WHERE owner_id = ? AND plan_id = ? AND status = 'pending'`,
      [now, now, ownerId, planId]
    );
    return result.affectedRows;
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
    if (!['sent', 'failed'].includes(status)) throw new Error('bad_reminder_status');
    const now = Date.now();
    const [result] = await this.pool.execute(
      `UPDATE scheduled_reminders
       SET status = ?, sent_at = ?, failed_at = ?, last_error = ?, updated_at = ?, lock_token = NULL, locked_at = 0
       WHERE id = ? AND status = 'pending' AND lock_token = ?`,
      [status, status === 'sent' ? now : 0, status === 'failed' ? now : 0, String(lastError || '').slice(0, 255), now, id, lockToken]
    );
    return result.affectedRows > 0;
  }

  async deleteAccount(ownerId) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('DELETE FROM records WHERE owner_id = ?', [ownerId]);
      await connection.execute('DELETE FROM sessions WHERE openid = ?', [ownerId]);
      await connection.execute('DELETE FROM scheduled_reminders WHERE owner_id = ?', [ownerId]);
      await connection.execute('DELETE FROM ai_insights WHERE owner_id = ?', [ownerId]);
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
