const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { preserveHabitSchedule } = require('../../miniprogram/utils/habit-utils');
const { validateRecordData, preservePlanDetails } = require('../validation');
const { TRIAL_INSIGHT_PREFIX, insightConsentField, aiConsentRevision } = require('../ai-consent');
const { hashSessionToken } = require('../session-token');
const { scanBillReminders: scanBillRemindersShared, scanHabitReminders: scanHabitRemindersShared } = require('./reminder-scan');

const COLLECTIONS = ['money', 'habit', 'plan', 'fitness', 'shopping', 'media', 'accounts', 'settings', 'memories', 'focusSessions', 'weeklyReviews', 'moneyRules'];
/* v2.11 提醒矩阵：订阅额度按 kind 记账（扫描语义见 ./reminder-scan.js） */
const REMINDER_CREDIT_KINDS = ['habit', 'bill'];

class FileStore {
  constructor(config) {
    this.config = config || {};
    this.file = path.join(config.dataDir, 'db.json');
    this.db = { records: {}, sessions: {}, users: {}, reminders: {}, secrets: {}, insights: {}, credits: {}, ownerSeqs: {} };
    for (const collection of COLLECTIONS) this.db.records[collection] = {};
    this.saveTimer = null;
  }

  async init() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (raw && raw.records) this.db = raw;
      }
    } catch (error) {
      console.error('[db] 读取文件库失败，使用空库：', error.message);
    }
    if (!this.db.sessions) this.db.sessions = {};
    if (!this.db.users) this.db.users = {};
    if (!this.db.reminders) this.db.reminders = {};
    if (!this.db.secrets) this.db.secrets = {};
    if (!this.db.insights) this.db.insights = {};
    if (!this.db.credits) this.db.credits = {};
    if (!this.db.ownerSeqs) this.db.ownerSeqs = {};
    for (const collection of COLLECTIONS) if (!this.db.records[collection]) this.db.records[collection] = {};
    let changed = false;
    Object.keys(this.db.users).forEach((ownerId) => {
      const user = this.db.users[ownerId];
      if (user && /^\d{11}$/.test(String(user.phone || ''))) {
        user.phone = String(user.phone).slice(0, 3) + '****' + String(user.phone).slice(-4);
        changed = true;
      }
    });
    if (this.migrateChangeSeq()) changed = true;
    if (changed) this.scheduleSave();
  }

  /*
   * v2.12 变更序号迁移：为缺少 seq 的历史记录按 owner 内 updated_at 升序补号，
   * 并把 owner_seq 头推到该 owner 的最大序号。重复调用安全（只补缺失的）。
   */
  migrateChangeSeq() {
    const byOwner = {};
    for (const collection of COLLECTIONS) {
      for (const row of Object.values(this.db.records[collection])) {
        if (!row) continue;
        const owner = row.ownerId || 'dev-user';
        (byOwner[owner] || (byOwner[owner] = [])).push(row);
      }
    }
    let changed = false;
    for (const [owner, rows] of Object.entries(byOwner)) {
      let head = Math.max(0, Number(this.db.ownerSeqs[owner]) || 0);
      rows.forEach((row) => { head = Math.max(head, Number(row.seq) || 0); });
      const missing = rows.filter((row) => !(Number(row.seq) > 0))
        .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0) || String(a.id).localeCompare(String(b.id)));
      for (const row of missing) { head += 1; row.seq = head; changed = true; }
      if (head !== (Number(this.db.ownerSeqs[owner]) || 0)) { this.db.ownerSeqs[owner] = head; changed = true; }
    }
    return changed;
  }

  /* owner 内单调序号：每次真实应用的写入 +1（LWW 拒绝不消耗） */
  nextChangeSeq(ownerId) {
    const next = (Number(this.db.ownerSeqs[ownerId]) || 0) + 1;
    this.db.ownerSeqs[ownerId] = next;
    return next;
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.db));
    }, 300);
  }

  async createSession(token, openid, expiresAt) {
    this.db.sessions[hashSessionToken(token)] = { openid, expiresAt };
    this.scheduleSave();
  }

  async getSession(token) {
    const tokenHash = hashSessionToken(token);
    let session = this.db.sessions[tokenHash] || this.db.sessions[token];
    if (session && !this.db.sessions[tokenHash]) {
      this.db.sessions[tokenHash] = session;
      delete this.db.sessions[token];
    }
    if (!session || session.expiresAt < Date.now()) {
      if (session) delete this.db.sessions[tokenHash];
      return null;
    }
    session.expiresAt = Date.now() + (Number(this.config.tokenTtlDays) || 30) * 24 * 3600 * 1000;
    this.scheduleSave();
    return session;
  }

  async cleanupSessions() {
    for (const token of Object.keys(this.db.sessions)) {
      if (this.db.sessions[token].expiresAt < Date.now()) delete this.db.sessions[token];
    }
    this.scheduleSave();
  }

  async cleanupReminders(before) {
    const threshold = Number(before) || Date.now();
    let removed = 0;
    Object.keys(this.db.reminders).forEach((id) => {
      const reminder = this.db.reminders[id];
      if (reminder && reminder.status !== 'pending' && Number(reminder.updatedAt) < threshold) {
        delete this.db.reminders[id];
        removed++;
      }
    });
    if (removed) this.scheduleSave();
    return removed;
  }

  async ping() { return true; }

  normalizeProfile(ownerId, profile) {
    const value = profile || {};
    return {
      ownerId,
      nickname: String(value.nickname || ''),
      phone: String(value.phone || ''),
      updatedAt: Number(value.updatedAt) || 0
    };
  }

  async getProfile(ownerId) {
    return this.normalizeProfile(ownerId, this.db.users[ownerId]);
  }

  async updateProfile(ownerId, patch) {
    const current = await this.getProfile(ownerId);
    const next = this.normalizeProfile(ownerId, {
      ...current,
      ...patch,
      updatedAt: Date.now()
    });
    this.db.users[ownerId] = next;
    this.scheduleSave();
    return next;
  }

  recordsFor(ownerId, collection) {
    return Object.entries(this.db.records[collection])
      .filter(([, record]) => (record.ownerId || 'dev-user') === ownerId)
      .map(([key, record]) => ({ id: record.id || key, ...record }));
  }

  async getChanges(ownerId, since) {
    const changes = {};
    for (const collection of COLLECTIONS) {
      const records = this.recordsFor(ownerId, collection)
        .filter((record) => (record.updatedAt || 0) > since)
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .map((record) => ({
          id: record.id,
          data: record.deletedAt ? null : record.data,
          updatedAt: record.updatedAt,
          deletedAt: record.deletedAt || 0
        }));
      if (records.length) changes[collection] = records;
    }
    return changes;
  }

  /*
   * 按变更序号拉取（v2.12 下载游标）：seq > sinceSeq 升序，cursor 取 owner 序号头。
   * 晚到上传的旧时间戳记录已分配 seq，不会因为客户端本机写入而漏拉。
   */
  async getChangesBySeq(ownerId, sinceSeq) {
    const requested = Math.max(0, Number(sinceSeq) || 0);
    const head = Math.max(0, Number(this.db.ownerSeqs[ownerId]) || 0);
    const reset = requested > head;
    const threshold = reset ? 0 : requested;
    const rows = [];
    for (const collection of COLLECTIONS) {
      this.recordsFor(ownerId, collection).forEach((record) => {
        if (Number(record.seq || 0) > threshold) rows.push({ ...record, collection });
      });
    }
    rows.sort((a, b) => (a.seq || 0) - (b.seq || 0));
    const changes = {};
    rows.forEach((row) => {
      (changes[row.collection] || (changes[row.collection] = [])).push({
        id: row.id,
        data: row.deletedAt ? null : row.data,
        updatedAt: row.updatedAt || 0,
        deletedAt: row.deletedAt || 0
      });
    });
    return { cursor: head, changes, reset };
  }

  async getRecord(ownerId, collection, id) {
    return this.recordsFor(ownerId, collection).find((row) => row.id === id) || null;
  }

  async getCollection(ownerId, collection) {
    return Object.fromEntries(this.recordsFor(ownerId, collection).map((record) => [record.id, {
      data: record.data,
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt || 0
    }]));
  }

  async upsert(ownerId, collection, id, data, updatedAt, options) {
    // createOnly（导入恢复语义）：记录已存在（存活或墓碑）即拒绝，检查先于 LWW 判断。
    const createOnly = Boolean(options && options.createOnly);
    const restore = options && options.restore;
    const replacesDeletedAt = options && options.replacesDeletedAt;
    const deletedAt = options && options.tombstone ? updatedAt : 0;
    const old = this.recordsFor(ownerId, collection).find((record) => record.id === id);
    if (restore) {
      if (!old || old.deletedAt !== restore.deletedAt || old.deletedAt < restore.cutoff ||
          validateRecordData('memories', old.data)) return { applied: false };
      data = old.data;
      updatedAt = Math.max(updatedAt, old.updatedAt + 1);
    }
    if (createOnly && old && !(replacesDeletedAt > 0 && old.deletedAt === replacesDeletedAt)) {
      return { applied: false, reason: 'exists', record: { id, data: old.data, updatedAt: old.updatedAt, deletedAt: old.deletedAt || 0 } };
    }
    if (old && (old.updatedAt || 0) > updatedAt) {
      return { applied: false, reason: 'older', record: { id, data: old.data, updatedAt: old.updatedAt, deletedAt: old.deletedAt || 0 } };
    }
    if (collection === 'plan' && old && !old.deletedAt) data = preservePlanDetails(old.data, data);
    if (collection === 'habit' && old && !old.deletedAt) data = preserveHabitSchedule(old.data, data);
    const seq = this.nextChangeSeq(ownerId);
    this.db.records[collection][ownerId + '|' + id] = { id, ownerId, data, updatedAt, deletedAt, seq };
    if (collection === 'settings' && id === 'app') this.clearDisabledAiInsights(ownerId, deletedAt ? {} : data);
    this.scheduleSave();
    return { applied: true, record: { id, data, updatedAt, deletedAt } };
  }

  async remove(ownerId, collection, id, updatedAt, fallbackData) {
    const old = this.recordsFor(ownerId, collection).find((record) => record.id === id);
    if (old && (old.updatedAt || 0) > updatedAt) {
      return { applied: false, reason: 'older', record: { id, data: old.data, updatedAt: old.updatedAt, deletedAt: old.deletedAt || 0 } };
    }
    const seq = this.nextChangeSeq(ownerId);
    this.db.records[collection][ownerId + '|' + id] = {
      id, ownerId, data: old ? old.data : (fallbackData || {}), updatedAt, deletedAt: updatedAt, seq
    };
    if (collection === 'settings' && id === 'app') this.clearDisabledAiInsights(ownerId, {});
    this.scheduleSave();
    return { applied: true };
  }

  async exportRecords(ownerId) {
    const exported = {};
    for (const collection of COLLECTIONS) exported[collection] = await this.getCollection(ownerId, collection);
    return exported;
  }

  async getSecret(name) {
    return this.db.secrets[String(name || '')] || '';
  }

  async setSecret(name, value) {
    this.db.secrets[String(name || '')] = String(value || '');
    this.scheduleSave();
  }

  async getAiInsight(ownerId, insightKey) {
    const value = this.db.insights[String(ownerId) + '|' + String(insightKey || '')];
    return value ? { ...value } : null;
  }

  async getAiConsentRevision(ownerId, isTrial) {
    return aiConsentRevision(this.db.records.settings[ownerId + '|app'], isTrial);
  }

  async saveAiInsight(ownerId, insightKey, contextHash, content, consentRevision) {
    const settings = this.db.records.settings[ownerId + '|app'];
    if (!consentRevision || aiConsentRevision(settings, insightKey.startsWith(TRIAL_INSIGHT_PREFIX)) !== consentRevision) return false;
    const now = Date.now();
    this.db.insights[String(ownerId) + '|' + String(insightKey || '')] = {
      ownerId: String(ownerId), insightKey: String(insightKey), contextHash: String(contextHash), content: String(content || ''), generatedAt: now, updatedAt: now
    };
    this.scheduleSave();
    return true;
  }

  clearDisabledAiInsights(ownerId, settings) {
    if (settings.aiConsent === true && settings.trialAiConsent === true) return;
    for (const [key, entry] of Object.entries(this.db.insights)) {
      if (!entry || entry.ownerId !== ownerId) continue;
      const consent = insightConsentField(String(entry.insightKey || '').startsWith(TRIAL_INSIGHT_PREFIX));
      if (settings[consent] !== true) delete this.db.insights[key];
    }
  }

  async createReminder(ownerId, planId, payload) {
    if (!payload.onceId) await this.cancelRemindersByPlan(ownerId, planId);
    const now = Date.now();
    const id = payload.onceId || crypto.randomBytes(20).toString('hex');
    if (payload.onceId && this.db.reminders[id]) return null;
    const reminder = {
      id,
      ownerId,
      planId,
      title: String(payload.title || ''),
      dueAt: Number(payload.dueAt),
      status: 'pending',
      lockToken: '',
      lockedAt: 0,
      sentAt: 0,
      failedAt: 0,
      cancelledAt: 0,
      lastError: '',
      createdAt: now,
      updatedAt: now
    };
    this.db.reminders[id] = reminder;
    this.scheduleSave();
    return { ...reminder };
  }

  async getReminder(id) {
    const reminder = this.db.reminders[id];
    return reminder ? { ...reminder } : null;
  }

  async listDeletedMemories(owner, cutoff, offset) {
    return this.recordsFor(owner, 'memories').filter((r) => r.deletedAt >= cutoff && !validateRecordData('memories', r.data))
      .sort((a, b) => b.deletedAt - a.deletedAt || a.id.localeCompare(b.id)).slice(offset, offset + 21);
  }

  async listReminders(owner, pending, offset) {
    return Object.values(this.db.reminders).filter((r) => r.ownerId === owner && (r.status === 'pending') === pending)
      .sort((a, b) => (pending ? a.dueAt - b.dueAt : b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id))
      .slice(offset, offset + 21);
  }

  async getLatestReminderForPlan(ownerId, planId) {
    const reminders = Object.values(this.db.reminders)
      .filter((item) => item.ownerId === ownerId && item.planId === planId)
      .sort((a, b) => b.createdAt - a.createdAt);
    return reminders[0] ? { ...reminders[0] } : null;
  }

  async cancelRemindersByPlan(ownerId, planId, reason = '') {
    const now = Date.now();
    let cancelled = 0;
    Object.values(this.db.reminders).forEach((reminder) => {
      if (reminder.ownerId !== ownerId || reminder.planId !== planId) return;
      if (reminder.status !== 'pending' &&
          !(reason === '' && reminder.status === 'cancelled' && reminder.lastError === 'plan_completed')) return;
      reminder.status = 'cancelled';
      reminder.cancelledAt = now;
      reminder.lastError = reason;
      reminder.updatedAt = now;
      reminder.lockToken = '';
      reminder.lockedAt = 0;
      cancelled++;
    });
    if (cancelled) this.scheduleSave();
    return cancelled;
  }

  async resumeCancelledReminder(ownerId, id, reason, title, dueAt) {
    const reminder = this.db.reminders[id];
    if (!reminder || reminder.ownerId !== ownerId || reminder.status !== 'cancelled' ||
        reminder.lastError !== reason || reminder.dueAt !== dueAt) return false;
    Object.assign(reminder, { status: 'pending', title, lastError: '', cancelledAt: 0, updatedAt: Date.now() });
    this.scheduleSave();
    return true;
  }

  async claimDueReminders(now, limit, lockToken) {
    const staleBefore = Number(now) - 5 * 60 * 1000;
    const selected = Object.values(this.db.reminders)
      .filter((item) => item.status === 'pending' && item.dueAt <= now && (!item.lockedAt || item.lockedAt < staleBefore))
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, Math.max(1, Number(limit) || 20));
    selected.forEach((reminder) => {
      reminder.lockToken = lockToken;
      reminder.lockedAt = Number(now);
      reminder.updatedAt = Number(now);
    });
    if (selected.length) this.scheduleSave();
    return selected.map((item) => ({ ...item }));
  }

  async finishReminder(id, lockToken, status, lastError) {
    if (!['sent', 'failed', 'cancelled'].includes(status)) throw new Error('bad_reminder_status');
    const reminder = this.db.reminders[id];
    if (!reminder || reminder.status !== 'pending' || reminder.lockToken !== lockToken) return false;
    const now = Date.now();
    reminder.status = status;
    reminder.lastError = String(lastError || '').slice(0, 255);
    reminder.sentAt = status === 'sent' ? now : 0;
    reminder.failedAt = status === 'failed' ? now : 0;
    reminder.cancelledAt = status === 'cancelled' ? now : 0;
    reminder.updatedAt = now;
    reminder.lockToken = '';
    reminder.lockedAt = 0;
    this.scheduleSave();
    return true;
  }

  async deleteAccount(ownerId) {
    for (const collection of COLLECTIONS) {
      Object.keys(this.db.records[collection]).forEach((key) => {
        if ((this.db.records[collection][key].ownerId || 'dev-user') === ownerId) delete this.db.records[collection][key];
      });
    }
    Object.keys(this.db.sessions).forEach((token) => {
      if (this.db.sessions[token].openid === ownerId) delete this.db.sessions[token];
    });
    delete this.db.users[ownerId];
    Object.keys(this.db.reminders).forEach((id) => {
      if (this.db.reminders[id].ownerId === ownerId) delete this.db.reminders[id];
    });
    Object.keys(this.db.insights).forEach((key) => {
      if (this.db.insights[key] && this.db.insights[key].ownerId === ownerId) delete this.db.insights[key];
    });
    Object.keys(this.db.credits).forEach((key) => {
      if (String(key).split('|')[0] === ownerId) delete this.db.credits[key];
    });
    // v2.12：变更序号头一并清除（与 mysql 驱动同语义）
    if (this.db.ownerSeqs) delete this.db.ownerSeqs[ownerId];
    if (this.db.uploads) {
      Object.keys(this.db.uploads).forEach((key) => {
        if (this.db.uploads[key].ownerId === ownerId) delete this.db.uploads[key];
      });
    }
    this.scheduleSave();
  }

  /* ---------- v2.11 提醒矩阵：额度 + 扫描生成（与 mysql-store 同语义） ---------- */

  creditKey(ownerId, kind) { return ownerId + '|' + kind; }

  async getReminderCredits(ownerId) {
    const read = (kind) => Math.max(0, Number(this.db.credits[this.creditKey(ownerId, kind)]) || 0);
    return { habit: read('habit'), bill: read('bill') };
  }

  async addReminderCredit(ownerId, kind, delta) {
    if (!REMINDER_CREDIT_KINDS.includes(kind)) throw new Error('bad_reminder_kind');
    const key = this.creditKey(ownerId, kind);
    const next = Math.max(0, Math.floor((Number(this.db.credits[key]) || 0) + (Number(delta) || 0)));
    this.db.credits[key] = next;
    this.scheduleSave();
    return next;
  }

  settingOwnerIds() {
    const owners = new Set();
    Object.values(this.db.records.settings).forEach((record) => {
      if (record && !record.deletedAt && record.data && record.ownerId) owners.add(record.ownerId);
    });
    return owners;
  }

  settingDataFor(ownerId) {
    const record = Object.values(this.db.records.settings).find((item) => item && (item.ownerId || 'dev-user') === ownerId && item.id === 'app');
    return record && !record.deletedAt && record.data ? record.data : null;
  }

  /* 扫描数据原语（与 mysql-store 同语义）：设置清单 / 习惯定义与当日打卡 / 负债账户 / 提醒是否已存在 */
  async listReminderSettings() {
    return Array.from(this.settingOwnerIds()).map((ownerId) => ({ ownerId, data: this.settingDataFor(ownerId) }));
  }

  async listHabitReminderRecords(today) {
    return Object.values(this.db.records.habit)
      .filter((record) => record && !record.deletedAt && record.data &&
        (record.data.kind === 'def' || record.data.date === today))
      .map((record) => ({ ...record, ownerId: record.ownerId || 'dev-user' }));
  }

  async listBillRepayments(ownerId) {
    return this.recordsFor(ownerId, 'money').filter((row) => !row.deletedAt && row.id.startsWith('repay-'));
  }

  async listLiabilityAccounts() {
    return Object.values(this.db.records.accounts)
      .filter((record) => record && !record.deletedAt && record.data)
      .map((record) => ({ ownerId: record.ownerId || 'dev-user', id: record.id, data: record.data }));
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

  async close() {
    clearTimeout(this.saveTimer);
  }
}

function pad2(value) { return String(value).padStart(2, '0'); }

module.exports = { FileStore, COLLECTIONS };
