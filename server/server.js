/*
 * 生活记忆 life · 生活工作台同步后端
 *
 * HTTP / WebSocket 协议保持兼容，存储层可切换：
 * - STORAGE_DRIVER=mysql：Docker / 服务器 MySQL，默认
 * - STORAGE_DRIVER=file：本地离线兜底与旧数据调试
 */
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { loadConfig } = require('./config');
const { createStore } = require('./db/store');
const { COLLECTIONS } = require('./db/mysql-store');
const { exchangeLoginCode, exchangePhoneCode, sendSubscriptionMessage } = require('./wechat');
const { getOneOffReminderPlan, ID_PATTERN, validateRecordData } = require('./validation');
const { createReminderWorker, getReminderCapabilities, startReminderWorker } = require('./reminders');
const { createInsightService } = require('./ai-insights');

const COLLECTION_SET = new Set(COLLECTIONS);

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function maskPhone(value) {
  const phone = String(value || '').trim();
  if (!phone) return '';
  if (phone.includes('****')) return phone;
  if (phone.length < 7) return '已绑定';
  return phone.slice(0, 3) + '****' + phone.slice(-4);
}

function publicProfile(profile) {
  const phone = String((profile && profile.phone) || '');
  return {
    nickname: String((profile && profile.nickname) || ''),
    phone: maskPhone(phone),
    hasPhone: Boolean(phone),
    updatedAt: Number((profile && profile.updatedAt) || 0)
  };
}

function validNickname(value) {
  return typeof value === 'string' && value.trim().length <= 32;
}

function parseUpdatedAt(value) {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : Date.now();
}

function formatDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function formatMonth(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
}

function validMonth(value) {
  return /^(\d{4})-(0[1-9]|1[0-2])$/.test(String(value || ''));
}

function validateCollection(req, res, next) {
  if (!COLLECTION_SET.has(req.params.collection)) return res.status(400).json({ error: 'bad_collection' });
  next();
}

function validateRecordId(req, res, next) {
  const id = req.params.id || req.params.planId || '';
  if (!ID_PATTERN.test(id)) return res.status(400).json({ error: 'bad_id' });
  next();
}

function createRateLimiter(maxRequests, windowMs, keyResolver) {
  const entries = new Map();
  let lastSweep = 0;
  return (req, res, next) => {
    const now = Date.now();
    const limit = Math.max(1, Number(maxRequests) || 1);
    const duration = Math.max(1000, Number(windowMs) || 60000);
    if (now - lastSweep >= duration) {
      for (const [entryKey, timestamps] of entries) {
        if (!timestamps.length || now - timestamps[timestamps.length - 1] >= duration) entries.delete(entryKey);
      }
      lastSweep = now;
    }
    const key = String(keyResolver ? keyResolver(req) : (req.ip || req.socket.remoteAddress || 'unknown')) || 'unknown';
    const recent = (entries.get(key) || []).filter((timestamp) => now - timestamp < duration);
    if (recent.length >= limit) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((duration - (now - recent[0])) / 1000)));
      return res.status(429).json({ error: 'rate_limit_exceeded' });
    }
    recent.push(now);
    entries.set(key, recent);
    next();
  };
}

function validateStartupConfig(config) {
  if (config.devMode) return;
  const required = [
    ['WX_APPID', config.wxAppId],
    ['WX_SECRET', config.wxSecret],
    ['WX_REMINDER_TEMPLATE_ID', config.wxReminderTemplateId]
  ].filter(([, value]) => !value).map(([name]) => name);
  if (required.length) throw new Error('Production configuration missing: ' + required.join(', '));
  if (config.storageDriver && config.storageDriver !== 'mysql') throw new Error('Production configuration requires STORAGE_DRIVER=mysql');
  if (config.ai && config.ai.enabled && !config.hasDedicatedAiEncryptionKey && !config.aiSecretEncryptionKey) {
    throw new Error('Production configuration missing: AI_SECRET_ENCRYPTION_KEY');
  }
}

async function reconcilePlanReminder(store, ownerId, planId, data) {
  const current = await store.getLatestReminderForPlan(ownerId, planId);
  if (!current || current.status !== 'pending') return;
  const eligible = getOneOffReminderPlan({ data });
  const enabled = eligible && eligible.reminder && eligible.reminder.enabled === true;
  if (!enabled || Number(eligible.reminder.dueAt) !== Number(eligible.dueAt)) {
    await store.cancelRemindersByPlan(ownerId, planId);
    return;
  }
  if (Number(current.dueAt) !== Number(eligible.dueAt) || current.title !== eligible.title) {
    await store.createReminder(ownerId, planId, { title: eligible.title, dueAt: eligible.dueAt });
  }
}

function createApp(store, config, sockets, services) {
  const app = express();
  const options = services || {};
  const aiService = options.aiService || createInsightService({ store, config });

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  if (config.requireHttps) {
    app.use((req, res, next) => {
      const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
      if (req.secure || forwardedProto === 'https') return next();
      return res.status(426).json({ error: 'https_required' });
    });
  }
  app.use((req, res, next) => {
    const origin = String(req.headers.origin || '');
    const allowedOrigins = Array.isArray(config.allowedOrigins) ? config.allowedOrigins : [];
    if (origin && !(config.devMode || allowedOrigins.includes(origin))) return res.status(403).json({ error: 'origin_not_allowed' });
    if (origin && (config.devMode || allowedOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: config.requestBodyLimit || '128kb' }));
  app.use('/api', createRateLimiter(Number(config.apiRateLimit) || 240, 60 * 1000));

  function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    store.getSession(token).then((session) => {
      if (!session) return res.status(401).json({ error: 'unauthorized' });
      req.token = token;
      req.openid = session.openid;
      next();
    }).catch(next);
  }

  app.get('/api/health', async (req, res) => {
    try {
      if (typeof store.ping === 'function') await store.ping();
      const payload = { ok: true, time: Date.now(), version: config.releaseVersion || 'unversioned' };
      if (config.healthDetails) {
        payload.storage = config.storageDriver;
        payload.database = config.storageDriver === 'mysql' && config.db ? config.db.name : null;
        payload.devMode = Boolean(config.devMode);
      }
      res.json(payload);
    } catch (error) {
      res.status(503).json({ ok: false, error: 'storage_unavailable' });
    }
  });

  app.post('/api/login', createRateLimiter(Number(config.loginRateLimit) || 30, 60 * 1000), async (req, res, next) => {
    try {
      const code = String((req.body && req.body.code) || '');
      let openid = 'dev-user';
      if (!config.devMode) {
        try {
          openid = await exchangeLoginCode(config, code);
        } catch (error) {
          return res.status(401).json({ error: 'code2session_failed' });
        }
      }
      const token = randomToken();
      await store.createSession(token, openid, Date.now() + config.tokenTtlDays * 24 * 3600 * 1000);
      await store.cleanupSessions();
      res.json({ token, openid, devMode: config.devMode, profile: publicProfile(await store.getProfile(openid)) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/profile', auth, async (req, res, next) => {
    try {
      res.json({ profile: publicProfile(await store.getProfile(req.openid)) });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/profile', auth, async (req, res, next) => {
    try {
      const body = req.body || {};
      const patch = {};
      if (body.nickname !== undefined) {
        if (!validNickname(body.nickname)) return res.status(422).json({ error: 'bad_nickname' });
        patch.nickname = body.nickname.trim();
      }
      if (body.phoneCode !== undefined) {
        if (typeof body.phoneCode !== 'string' || !body.phoneCode.trim()) {
          return res.status(422).json({ error: 'bad_phone_code' });
        }
        try {
          const phone = config.devMode && body.phoneCode === 'dev-phone' && config.devPhoneNumber
            ? config.devPhoneNumber
            : await exchangePhoneCode(config, body.phoneCode);
          // 原始手机号只在与微信交换的瞬间存在，落库前立即最小化为掩码。
          patch.phone = maskPhone(phone);
        } catch (error) {
          return res.status(502).json({ error: 'phone_exchange_failed' });
        }
      }
      if (!Object.keys(patch).length) return res.status(422).json({ error: 'empty_profile' });
      const profile = await store.updateProfile(req.openid, patch);
      res.json({ profile: publicProfile(profile) });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/account', auth, createRateLimiter(Number(config.accountDeleteRateLimit) || 5, 60 * 60 * 1000), async (req, res, next) => {
    try {
      const code = String((req.body && req.body.code) || '').trim();
      if (!code) return res.status(422).json({ error: 'fresh_login_required' });
      let verifiedOpenid = '';
      if (config.devMode) verifiedOpenid = 'dev-user';
      else {
        try { verifiedOpenid = await exchangeLoginCode(config, code); } catch (error) { return res.status(401).json({ error: 'fresh_login_failed' }); }
      }
      if (verifiedOpenid !== req.openid) return res.status(403).json({ error: 'fresh_login_mismatch' });
      await store.deleteAccount(req.openid);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sync', auth, async (req, res, next) => {
    try {
      const since = Math.max(0, Number(req.query.since) || 0);
      res.json({ serverTime: Date.now(), changes: await store.getChanges(req.openid, since) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/insights', auth, createRateLimiter(Number(config.aiInsightRateLimit) || 10, 10 * 60 * 1000), async (req, res, next) => {
    try {
      const scope = String(req.query.scope || 'today');
      if (!['today', 'month'].includes(scope)) return res.status(400).json({ error: 'bad_insight_scope' });
      const period = scope === 'today' ? formatDate(new Date()) : String(req.query.month || formatMonth(new Date()));
      if (scope === 'month' && (!validMonth(period) || period > formatMonth(new Date()))) return res.status(400).json({ error: 'bad_insight_month' });
      const result = await aiService.getInsight(req.openid, scope, period, new Date());
      res.json({ scope, period, content: result.content, source: result.source, generatedAt: result.generatedAt });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/records/:collection', auth, validateCollection, async (req, res, next) => {
    try {
      res.json({ records: await store.getCollection(req.openid, req.params.collection) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/reminders/capabilities', auth, (req, res) => {
    res.json(getReminderCapabilities(config));
  });

  app.get('/api/reminders/:planId', auth, validateRecordId, async (req, res, next) => {
    try {
      const reminder = await store.getLatestReminderForPlan(req.openid, req.params.planId);
      res.json({ reminder: reminder || null });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/reminders/:planId', auth, validateRecordId, createRateLimiter(Number(config.reminderRateLimit) || 30, 60 * 1000), async (req, res, next) => {
    try {
      const capability = getReminderCapabilities(config);
      if (!capability.enabled) return res.status(503).json({ error: 'reminders_unavailable' });
      const plans = await store.getCollection(req.openid, 'plan');
      const plan = plans[req.params.planId];
      const eligible = getOneOffReminderPlan(plan);
      const requestedDueAt = Number(req.body && req.body.dueAt);
      if (!eligible || !eligible.reminder || eligible.reminder.enabled !== true || requestedDueAt !== Number(eligible.reminder.dueAt)) {
        return res.status(422).json({ error: 'ineligible_reminder' });
      }
      if (eligible.dueAt <= Date.now() + 30 * 1000 || eligible.dueAt > Date.now() + 366 * 24 * 60 * 60 * 1000) {
        return res.status(422).json({ error: 'bad_reminder_time' });
      }
      const reminder = await store.createReminder(req.openid, req.params.planId, { title: eligible.title, dueAt: eligible.dueAt });
      res.status(201).json(reminder);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/reminders/:planId', auth, validateRecordId, async (req, res, next) => {
    try {
      const cancelled = await store.cancelRemindersByPlan(req.openid, req.params.planId);
      res.json({ cancelled });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/records/:collection/:id', auth, createRateLimiter(Number(config.recordWriteRateLimit) || 120, 60 * 1000, (req) => req.openid), validateCollection, validateRecordId, async (req, res, next) => {
    try {
      const body = req.body || {};
      const validationError = validateRecordData(req.params.collection, body.data);
      if (validationError) return res.status(422).json({ error: validationError });
      const updatedAt = parseUpdatedAt(body.updatedAt);
      const result = await store.upsert(req.openid, req.params.collection, req.params.id, body.data, updatedAt);
      if (result.applied && req.params.collection === 'plan') {
        await reconcilePlanReminder(store, req.openid, req.params.id, body.data);
      }
      if (result.applied && req.params.collection === 'settings' && req.params.id === 'app' && body.data.aiConsent !== true && typeof store.deleteAiInsights === 'function') {
        await store.deleteAiInsights(req.openid);
      }
      if (result.applied) broadcast(sockets, {
        type: 'change', collection: req.params.collection, id: req.params.id, ts: Date.now()
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/records/:collection/:id', auth, createRateLimiter(Number(config.recordWriteRateLimit) || 120, 60 * 1000, (req) => req.openid), validateCollection, validateRecordId, async (req, res, next) => {
    try {
      const updatedAt = parseUpdatedAt(req.query.updatedAt);
      const body = req.body || {};
      const result = await store.remove(req.openid, req.params.collection, req.params.id, updatedAt, body.data);
      if (result.applied && req.params.collection === 'plan') await store.cancelRemindersByPlan(req.openid, req.params.id);
      if (result.applied) broadcast(sockets, {
        type: 'change', collection: req.params.collection, id: req.params.id, ts: Date.now()
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/export', auth, async (req, res, next) => {
    try {
      res.json({ exportedAt: Date.now(), records: await store.exportRecords(req.openid) });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error && error.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    if (error && error.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json' });
    console.error('[api] unexpected error:', (error && error.name) || 'Error');
    res.status(500).json({ error: 'internal_error' });
  });
  return app;
}

function broadcast(sockets, payload) {
  const message = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === 1) {
      try { ws.send(message); } catch (error) { /* socket will be removed on close */ }
    }
  }
}

async function start() {
  const config = loadConfig();
  validateStartupConfig(config);
  const store = createStore(config);
  await store.init();
  await store.cleanupSessions();
  const cleanupIntervalMs = 6 * 60 * 60 * 1000;
  const retentionMs = Math.max(7, Number(config.reminderRetentionDays) || 90) * 24 * 60 * 60 * 1000;
  const cleanupOldData = () => Promise.all([
    store.cleanupSessions(),
    typeof store.cleanupReminders === 'function' ? store.cleanupReminders(Date.now() - retentionMs) : Promise.resolve(0)
  ]).catch((error) => console.error('[maintenance] cleanup failed:', (error && error.name) || 'Error'));
  cleanupOldData();
  const cleanupTimer = setInterval(cleanupOldData, cleanupIntervalMs);
  const sockets = new Set();
  const reminderWorker = createReminderWorker(store, config, sendSubscriptionMessage);
  const stopReminderWorker = startReminderWorker(reminderWorker, config);
  const app = createApp(store, config, sockets, { sendSubscriptionMessage });
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });

  wss.on('connection', (ws, req) => {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
    const authTimeout = setTimeout(() => {
      try { ws.close(4401, 'unauthorized'); } catch (error) { /* ignore */ }
    }, 5000);
    store.getSession(token).then((session) => {
      clearTimeout(authTimeout);
      if (!session) return ws.close(4401, 'unauthorized');
      sockets.add(ws);
      ws.isAlive = true;
      ws.on('message', () => ws.close(1008, 'read-only socket'));
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('close', () => sockets.delete(ws));
      ws.on('error', () => sockets.delete(ws));
    }).catch(() => {
      clearTimeout(authTimeout);
      ws.close(1011, 'internal error');
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (!ws.isAlive) {
        try { ws.terminate(); } catch (error) { /* ignore */ }
        sockets.delete(ws);
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (error) { /* ignore */ }
    }
  }, 30000);

  await new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.bindHost || '127.0.0.1');
  });
  {
    console.log('==============================================');
    console.log('  生活记忆 life 同步后端已启动');
    console.log('  监听地址  ' + config.bindHost + ':' + config.port);
    console.log('  存储模式  ' + config.storageDriver + (config.devMode && config.storageDriver === 'mysql' ? ' · ' + config.db.name : ''));
    console.log('  登录模式  ' + (config.devMode ? 'DEV（免微信校验，本地调试用）' : '正式（code2Session）'));
    console.log('==============================================');
  }

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    clearInterval(cleanupTimer);
    stopReminderWorker();
    for (const ws of wss.clients) {
      try { ws.terminate(); } catch (error) { /* ignore */ }
    }
    sockets.clear();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await store.close();
    console.log('已停止（' + signal + '）');
    process.exit(0);
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown(signal));
  return { app, server, store, reminderWorker };
}

if (require.main === module) {
  start().catch((error) => {
    console.error('服务启动失败：', error.message);
    process.exit(1);
  });
}

module.exports = { createApp, createRateLimiter, maskPhone, start, validateStartupConfig };
