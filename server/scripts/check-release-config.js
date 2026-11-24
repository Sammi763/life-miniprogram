/* 手动发布闸门：不输出密钥或域名，只验证正式配置是否已收口。 */
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../config');

const root = path.resolve(__dirname, '..', '..');
const config = loadConfig();
const failures = [];

function requireCondition(condition, label) {
  if (!condition) failures.push(label);
}

const runtimeSource = fs.readFileSync(path.join(root, 'miniprogram/config/runtime.js'), 'utf8');
const runtimeMatch = runtimeSource.match(/const PRODUCTION_API_BASE_URL\s*=\s*['"]([^'"]*)['"]/);
const apiBase = runtimeMatch ? runtimeMatch[1] : '';

requireCondition(config.devMode === false, 'DEV_MODE must be 0');
requireCondition(config.storageDriver === 'mysql', 'STORAGE_DRIVER must be mysql');
requireCondition(config.bindHost === '127.0.0.1' || config.bindHost === '::1', 'BIND_HOST must be loopback-only');
requireCondition(config.requireHttps === true, 'REQUIRE_HTTPS must be enabled');
requireCondition(config.healthDetails === false, 'HEALTH_DETAILS must be disabled');
requireCondition(config.trustProxy === true, 'TRUST_PROXY must be enabled behind HTTPS proxy');
requireCondition(config.db && config.db.autoCreate === false, 'DB_AUTO_CREATE must be disabled for the service user');
requireCondition(config.db && config.db.runMigrations === false, 'DB_RUN_MIGRATIONS must be disabled for the service user');
requireCondition(Boolean(config.wxAppId && config.wxSecret && config.wxReminderTemplateId), 'WeChat production credentials/template are incomplete');
requireCondition(Number(config.apiRateLimit) > 0 && Number(config.recordWriteRateLimit) > 0, 'API rate limits must be configured');
requireCondition(Number(config.reminderRetentionDays) >= 7, 'REMINDER_RETENTION_DAYS must be at least 7');
requireCondition(config.ai && config.ai.enabled === false, 'Personalized AI must be disabled for the first release');
requireCondition(/^https:\/\/[A-Za-z0-9.-]+(?:\/|$)/.test(apiBase) && !/example\.com|localhost|\d+\.\d+\.\d+\.\d+/.test(apiBase), 'PRODUCTION_API_BASE_URL must be a real HTTPS domain');

const legalSource = fs.readFileSync(path.join(root, 'miniprogram/pages/legal/legal.js'), 'utf8');
requireCondition(!/【[^】]+】/.test(legalSource), 'Replace all legal operator/contact/third-party placeholders in pages/legal/legal.js');

if (failures.length) {
  console.error('RELEASE_CONFIGURATION_INCOMPLETE');
  failures.forEach((failure) => console.error('- ' + failure));
  process.exitCode = 1;
} else {
  console.log('RELEASE_CONFIGURATION_CHECK_PASSED');
}
