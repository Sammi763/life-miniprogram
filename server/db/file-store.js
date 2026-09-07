const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashSessionToken } = require('../session-token');

const COLLECTIONS = ['money', 'habit', 'plan', 'fitness', 'shopping', 'media', 'accounts', 'settings', 'memories'];

class FileStore {
  constructor(config) {
    this.config = config || {};
    this.file = path.join(config.dataDir, 'db.json');
    this.db = { records: {}, sessions: {}, users: {}, reminders: {}, secrets: {}, insights: {} };
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
    for (const collection of COLLECTIONS) if (!this.db.records[collection]) this.db.records[collection] = {};
    let changed = false;
    Object.keys(this.db.users).forEach((ownerId) => {
      const user = this.db.users[ownerId];
      if (user && /^\d{11}$/.test(String(user.phone || ''))) {
        user.phone = String(user.phone).slice(0, 3) + '****' + String(user.phone).slice(-4);
        changed = true;
      }
    });
    if (changed) this.scheduleSave();
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

  async getCollection(ownerId, collection) {
    return Object.fromEntries(this.recordsFor(ownerId, collection).map((record) => [record.id, {
      data: record.data,
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt || 0
    }]));
  }

  async upsert(ownerId, collection, id, data, updatedAt) {
    const old = this.recordsFor(ownerId, collection).find((record) => record.id === id);
    if (old && (old.updatedAt || 0) > updatedAt) {
      return { applied: false, reason: 'older', record: { id, data: old.data, updatedAt: old.updatedAt, deletedAt: old.deletedAt || 0 } };
    }
    this.db.records[collection][ownerId + '|' + id] = { id, ownerId, data, updatedAt, deletedAt: 0 };
    this.scheduleSave();
    return { applied: true, record: { id, data, updatedAt, deletedAt: 0 } };
  }

  async remove(ownerId, collection, id, updatedAt, fallbackData) {
    const old = this.recordsFor(ownerId, collection).find((record) => record.id === id);
    if (old && (old.updatedAt || 0) > updatedAt) {
      return { applied: false, reason: 'older', record: { id, data: old.data, updatedAt: old.updatedAt, deletedAt: old.deletedAt || 0 } };
    }
    this.db.records[collection][ownerId + '|' + id] = {
      id, ownerId, data: old ? old.data : (fallbackData || {}), updatedAt, deletedAt: updatedAt
    };
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

  async saveAiInsight(ownerId, insightKey, contextHash, content) {
    const now = Date.now();
    this.db.insights[String(ownerId) + '|' + String(insightKey || '')] = {
      ownerId: String(ownerId), insightKey: String(insightKey), contextHash: String(contextHash), content: String(content || ''), generatedAt: now, updatedAt: now
    };
    this.scheduleSave();
  }

  async deleteAiInsights(ownerId) {
    let removed = 0;
    Object.keys(this.db.insights).forEach((key) => {
      if (this.db.insights[key] && this.db.insights[key].ownerId === ownerId) {
        delete this.db.insights[key];
        removed++;
      }
    });
    if (removed) this.scheduleSave();
    return removed;
  }

  async createReminder(ownerId, planId, payload) {
    await this.cancelRemindersByPlan(ownerId, planId);
    const now = Date.now();
    const id = crypto.randomBytes(20).toString('hex');
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

  async getLatestReminderForPlan(ownerId, planId) {
    const reminders = Object.values(this.db.reminders)
      .filter((item) => item.ownerId === ownerId && item.planId === planId)
      .sort((a, b) => b.createdAt - a.createdAt);
    return reminders[0] ? { ...reminders[0] } : null;
  }

  async cancelRemindersByPlan(ownerId, planId) {
    const now = Date.now();
    let cancelled = 0;
    Object.values(this.db.reminders).forEach((reminder) => {
      if (reminder.ownerId !== ownerId || reminder.planId !== planId || reminder.status !== 'pending') return;
      reminder.status = 'cancelled';
      reminder.cancelledAt = now;
      reminder.updatedAt = now;
      reminder.lockToken = '';
      reminder.lockedAt = 0;
      cancelled++;
    });
    if (cancelled) this.scheduleSave();
    return cancelled;
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
    if (!['sent', 'failed'].includes(status)) throw new Error('bad_reminder_status');
    const reminder = this.db.reminders[id];
    if (!reminder || reminder.status !== 'pending' || reminder.lockToken !== lockToken) return false;
    const now = Date.now();
    reminder.status = status;
    reminder.lastError = String(lastError || '').slice(0, 255);
    reminder.sentAt = status === 'sent' ? now : 0;
    reminder.failedAt = status === 'failed' ? now : 0;
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
      if (this.db.insights[key].ownerId === ownerId) delete this.db.insights[key];
    });
    if (this.db.uploads) {
      Object.keys(this.db.uploads).forEach((key) => {
        if (this.db.uploads[key].ownerId === ownerId) delete this.db.uploads[key];
      });
    }
    this.scheduleSave();
  }

  async close() {
    clearTimeout(this.saveTimer);
  }
}

module.exports = { FileStore, COLLECTIONS };
