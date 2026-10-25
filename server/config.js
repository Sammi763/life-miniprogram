const fs = require('fs');
const path = require('path');

function readEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const values = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function numberFrom(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function booleanFrom(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === '1' || String(value).toLowerCase() === 'true';
}

function listFrom(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter((item) => /^https:\/\//.test(item));
}

function loadConfig() {
  const fileEnv = readEnvFile(path.join(__dirname, '.env'));
  const env = { ...fileEnv, ...process.env };
  const devMode = booleanFrom(env.DEV_MODE, true);
  const dedicatedEncryptionKey = env.AI_SECRET_ENCRYPTION_KEY || env.SECRET_ENCRYPTION_KEY || '';
  return {
    port: numberFrom(env.PORT, 8787),
    bindHost: env.BIND_HOST || (devMode ? '0.0.0.0' : '127.0.0.1'),
    releaseVersion: String(env.RELEASE_VERSION || 'unversioned').slice(0, 80),
    dataDir: env.DATA_DIR || path.join(__dirname, 'data'),
    storageDriver: env.STORAGE_DRIVER || 'mysql',
    tokenTtlDays: numberFrom(env.TOKEN_TTL_DAYS, 30),
    devPhoneNumber: env.DEV_PHONE_NUMBER || '',
    wxAppId: env.WX_APPID || '',
    wxSecret: env.WX_SECRET || '',
    wxReminderTemplateId: env.WX_REMINDER_TEMPLATE_ID || '',
    wxReminderPage: env.WX_REMINDER_PAGE || 'pages/plan/plan',
    // v2.11 提醒矩阵：习惯打卡提醒与账单还款提醒各自独立模板；未配置的 kind 静默停用
    wxHabitReminderTemplateId: env.WX_HABIT_REMINDER_TEMPLATE_ID || '',
    wxBillReminderTemplateId: env.WX_BILL_REMINDER_TEMPLATE_ID || '',
    // 习惯提醒的兜底发送小时（用户在设置里未填 habitReminderTime 时使用），默认 20:00
    habitReminderHour: numberFrom(env.HABIT_REMINDER_HOUR, 20),
    reminderWorkerIntervalMs: numberFrom(env.REMINDER_WORKER_INTERVAL_MS, 60000),
    reminderRetentionDays: numberFrom(env.REMINDER_RETENTION_DAYS, 90),
    wxHttpTimeoutMs: numberFrom(env.WX_HTTP_TIMEOUT_MS, 10000),
    aiSecretEncryptionKey: dedicatedEncryptionKey || (devMode ? env.DB_PASSWORD || '' : ''),
    hasDedicatedAiEncryptionKey: Boolean(dedicatedEncryptionKey),
    aiInsightRateLimit: numberFrom(env.AI_INSIGHT_RATE_LIMIT, 10),
    ai: {
      enabled: booleanFrom(env.AI_ENABLED, true),
      provider: env.AI_PROVIDER || 'deepseek',
      baseUrl: env.AI_BASE_URL || 'https://api.deepseek.com',
      model: env.AI_MODEL || 'deepseek-flash',
      maxTokens: numberFrom(env.AI_MAX_TOKENS, 160),
      timeoutMs: numberFrom(env.AI_TIMEOUT_MS, 12000)
    },
    allowedOrigins: listFrom(env.CORS_ALLOWED_ORIGINS),
    requestBodyLimit: env.REQUEST_BODY_LIMIT || '128kb',
    apiRateLimit: numberFrom(env.API_RATE_LIMIT, 240),
    recordWriteRateLimit: numberFrom(env.RECORD_WRITE_RATE_LIMIT, 120),
    loginRateLimit: numberFrom(env.LOGIN_RATE_LIMIT, 30),
    reminderRateLimit: numberFrom(env.REMINDER_RATE_LIMIT, 30),
    accountDeleteRateLimit: numberFrom(env.ACCOUNT_DELETE_RATE_LIMIT, 5),
    trustProxy: booleanFrom(env.TRUST_PROXY, false),
    requireHttps: booleanFrom(env.REQUIRE_HTTPS, !devMode),
    healthDetails: booleanFrom(env.HEALTH_DETAILS, devMode),
    db: {
      host: env.DB_HOST || '127.0.0.1',
      port: numberFrom(env.DB_PORT, 13306),
      name: env.DB_NAME || 'life_workbench',
      user: env.DB_USER || 'root',
      password: env.DB_PASSWORD || '',
      connectionLimit: numberFrom(env.DB_POOL_SIZE, 5),
      autoCreate: booleanFrom(env.DB_AUTO_CREATE, devMode),
      runMigrations: booleanFrom(env.DB_RUN_MIGRATIONS, devMode)
    },
    devMode
  };
}

module.exports = { booleanFrom, loadConfig };
