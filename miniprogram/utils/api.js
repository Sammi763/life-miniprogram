/* HTTP 层：baseUrl/token 管理 + Promise 封装；登录入口由用户主动触发 */
const BASE_KEY = 'wb_life_baseurl';
const TOKEN_KEY = 'wb_life_token';
const PROFILE_KEY = 'wb_life_profile';
const runtime = require('../config/runtime');
const { BUILD_VERSION } = require('../config/build');
const DEFAULT_BASE = runtime.DEVELOPMENT_API_BASE_URL;
const LOGIN_REQUEST_TIMEOUT_MS = 10000;
/* 登录是唯一可能的入口，对间歇性传输失败给足重试预算：共 5 次尝试、退避约 8.2 秒 */
const LOGIN_MAX_RETRIES = 4;
const LOGIN_RETRY_DELAYS_MS = [500, 1200, 2500, 4000];
const REQUEST_MAX_RETRIES = 1;
const REQUEST_RETRY_DELAY_MS = 500;
const HEALTH_REQUEST_TIMEOUT_MS = 6000;

function getBaseUrl() {
  const config = runtime.getRuntimeConfig();
  if (!config.allowServerOverride) return config.apiBaseUrl;
  try { return wx.getStorageSync(BASE_KEY) || config.apiBaseUrl || DEFAULT_BASE; } catch (e) { return config.apiBaseUrl || DEFAULT_BASE; }
}
function setBaseUrl(url) {
  if (!runtime.getRuntimeConfig().allowServerOverride) return false;
  url = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(url)) return false;
  try { wx.setStorageSync(BASE_KEY, url); } catch (e) { /* ignore */ }
  return true;
}
function getToken() {
  try { return wx.getStorageSync(TOKEN_KEY) || ''; } catch (e) { return ''; }
}

function getProfile() {
  try { return wx.getStorageSync(PROFILE_KEY) || {}; } catch (e) { return {}; }
}

function saveProfile(profile) {
  try { wx.setStorageSync(PROFILE_KEY, profile || {}); } catch (e) { /* ignore */ }
  return profile || {};
}

function clearLogin() {
  try {
    wx.removeStorageSync(TOKEN_KEY);
    wx.removeStorageSync(PROFILE_KEY);
  } catch (e) { /* ignore */ }
}

const LOGIN_SERVER_PHASES = new Set([
  'request_validation', 'wechat_code2session', 'session_persist', 'profile_load'
]);

function loginLog(event, attempt, category, phase, durationMs, details) {
  const entry = {
    event,
    at: new Date().toISOString(),
    buildVersion: BUILD_VERSION,
    attempt,
    category,
    phase,
    durationMs: Math.max(0, durationMs)
  };
  if (details && details.statusCode !== undefined) entry.statusCode = details.statusCode;
  if (details && details.serverPhase) entry.serverPhase = details.serverPhase;
  try { console.info('[life-login] ' + JSON.stringify(entry)); } catch (error) { /* logging is best effort */ }
}

function loginError(category, details) {
  const error = new Error(category);
  error.category = category;
  Object.assign(error, details || {});
  return error;
}

/*
 * 传输层错误分类。
 * 微信 errMsg 通常同时带 cronet 数字码与符号名（如 `errcode:-101 ... error_msg:net::ERR_CONNECTION_RESET`），
 * 符号名语义唯一，因此先按符号名判定，只有拿不到符号名时才回退到数字码。
 * cronet 码语义：-101 RESET / -102 REFUSED / -118 TIMED_OUT，两者不可混用。
 */
function classifyLoginTransportError(error) {
  const message = String((error && error.errMsg) || '');
  if (/ERR_CONNECTION_RESET|ECONNRESET|connection reset/i.test(message)) return 'network_reset';
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED|connection refused/i.test(message)) return 'network_refused';
  if (/ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|timed out|\btimeout\b/i.test(message)) return 'network_timeout';
  if (/(?:^|\D)-101(?:\D|$)/.test(message)) return 'network_reset';
  if (/(?:^|\D)-102(?:\D|$)/.test(message)) return 'network_refused';
  if (/(?:^|\D)-118(?:\D|$)/.test(message)) return 'network_timeout';
  return 'network_error';
}

/* 只有「无 HTTP 响应」的传输类失败才重试；拿到状态码的错误（401/429/5xx）一律不重试 */
const RETRYABLE_TRANSPORT_CATEGORIES = new Set(['network_reset', 'network_refused', 'network_timeout']);

function isRetryableTransportError(error) {
  return Boolean(error && !error.statusCode && RETRYABLE_TRANSPORT_CATEGORIES.has(error.category));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestLog(event, operation, method, attempt, durationMs, error) {
  const entry = {
    event,
    at: new Date().toISOString(),
    buildVersion: BUILD_VERSION,
    operation,
    method,
    attempt,
    category: error && error.category || 'request_error',
    durationMs: Math.max(0, durationMs)
  };
  if (error && error.statusCode !== undefined) entry.statusCode = error.statusCode;
  try { console.info('[life-api] ' + JSON.stringify(entry)); } catch (logError) { /* logging is best effort */ }
}

function doRequestWithRetry(method, path, data, token, operation, maxRetries) {
  let attempt = 0;
  function send() {
    attempt++;
    const startedAt = Date.now();
    return doRequest(method, path, data, token).catch((error) => {
      if (attempt <= maxRetries && isRetryableTransportError(error)) {
        requestLog('request_retry', operation, method, attempt, Date.now() - startedAt, error);
        return delay(REQUEST_RETRY_DELAY_MS).then(send);
      }
      if (error && (error.statusCode !== undefined || error.category)) {
        requestLog('request_failure', operation, method, attempt, Date.now() - startedAt, error);
      }
      throw error;
    });
  }
  return send();
}

function requestLoginCode(attempt, startedAt) {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (result) => {
        if (result && result.code) return resolve(result.code);
        const error = loginError('wx_login_failed', { phase: 'wx_login' });
        loginLog('login_attempt', attempt, error.category, error.phase, Date.now() - startedAt);
        reject(error);
      },
      fail: () => {
        const error = loginError('wx_login_failed', { phase: 'wx_login' });
        loginLog('login_attempt', attempt, error.category, error.phase, Date.now() - startedAt);
        reject(error);
      }
    });
  });
}

function requestLogin(code, attempt, startedAt) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: getBaseUrl() + '/api/login',
      method: 'POST',
      data: { code },
      header: { 'Content-Type': 'application/json', 'X-Client-Build': BUILD_VERSION },
      timeout: LOGIN_REQUEST_TIMEOUT_MS,
      success: (response) => {
        const statusCode = Number(response && response.statusCode) || 0;
        if (statusCode === 200 && response.data && response.data.token) {
          try { wx.setStorageSync(TOKEN_KEY, response.data.token); } catch (error) { /* ignore */ }
          if (response.data.profile) saveProfile(response.data.profile);
          loginLog('login_attempt', attempt, 'ok', 'http_response', Date.now() - startedAt, { statusCode });
          return resolve(response.data.token);
        }
        const suppliedPhase = response.data && response.data.phase;
        const serverPhase = LOGIN_SERVER_PHASES.has(suppliedPhase) ? suppliedPhase : '';
        const category = statusCode ? 'http_' + statusCode : 'invalid_http_response';
        const error = loginError(category, {
          phase: 'http_response',
          statusCode,
          serverPhase
        });
        loginLog('login_attempt', attempt, category, 'http_response', Date.now() - startedAt, {
          statusCode,
          serverPhase
        });
        reject(error);
      },
      fail: (transportError) => {
        const category = classifyLoginTransportError(transportError);
        const error = loginError(category, { phase: 'request_transport' });
        loginLog('login_attempt', attempt, category, error.phase, Date.now() - startedAt);
        reject(error);
      }
    });
  });
}

function rawLogin(options) {
  const settings = options || {};
  if (!getBaseUrl()) {
    const error = loginError('api_not_configured', { phase: 'client_configuration' });
    loginLog('login_attempt', 1, error.category, error.phase, 0);
    return Promise.reject(error);
  }

  function attemptLogin(attempt) {
    const startedAt = Date.now();
    return requestLoginCode(attempt, startedAt)
      .then((code) => requestLogin(code, attempt, startedAt))
      .catch((error) => {
        if (attempt > LOGIN_MAX_RETRIES || !isRetryableTransportError(error)) throw error;
        loginLog('login_retry', attempt, error.category, 'request_transport', Date.now() - startedAt);
        if (typeof settings.onRetry === 'function') {
          try { settings.onRetry({ retry: attempt, maxRetries: LOGIN_MAX_RETRIES, category: error.category }); } catch (callbackError) { /* UI status is best effort */ }
        }
        const retryDelay = LOGIN_RETRY_DELAYS_MS[Math.min(attempt - 1, LOGIN_RETRY_DELAYS_MS.length - 1)];
        return delay(retryDelay).then(() => attemptLogin(attempt + 1));
      });
  }

  return attemptLogin(1);
}

let loginPromise = null;
function ensureLogin() {
  if (getToken()) return Promise.resolve(getToken());
  if (!loginPromise) {
    loginPromise = rawLogin().finally(() => { loginPromise = null; });
  }
  return loginPromise;
}

function login(options) {
  return rawLogin(options).then(() => getProfile());
}

function request(method, path, data) {
  return ensureLogin().then((token) => {
    if (String(method).toUpperCase() === 'GET') {
      return doRequestWithRetry(method, path, data, token, 'read', REQUEST_MAX_RETRIES);
    }
    return doRequest(method, path, data, token);
  });
}

function requestIdempotent(method, path, data, operation) {
  return ensureLogin().then((token) =>
    doRequestWithRetry(method, path, data, token, operation, REQUEST_MAX_RETRIES));
}

function doRequest(method, path, data, token) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: getBaseUrl() + path,
      method,
      data,
      header: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      timeout: 10000,
      success: (res) => {
        if (res.statusCode === 401) clearLogin();
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data);
        else {
          const error = new Error('http ' + res.statusCode + (res.data && res.data.error ? ' ' + res.data.error : ''));
          error.statusCode = res.statusCode;
          error.category = 'http_' + res.statusCode;
          error.code = res.data && res.data.error;
          reject(error);
        }
      },
      fail: (e) => {
        const error = new Error((e && e.errMsg) || 'request fail');
        error.category = classifyLoginTransportError(e);
        reject(error);
      }
    });
  });
}

function validateSession() {
  const token = getToken();
  if (!token) return Promise.reject(new Error('not_logged_in'));
  return doRequestWithRetry('GET', '/api/profile', undefined, token, 'profile_read', REQUEST_MAX_RETRIES)
    .then((result) => saveProfile(result.profile || {}))
    .catch((error) => {
      if (error.statusCode === 401) clearLogin();
      throw error;
    });
}

/*
 * 登录失败后的只读自检：只请求 /api/health，不带 token、不写任何本地状态。
 * 用于把「整个域名/服务不可达」与「仅登录接口失败」区分开，给用户可执行的下一步。
 */
function checkHealth() {
  const base = getBaseUrl();
  if (!base) return Promise.reject(loginError('api_not_configured', { phase: 'health_probe' }));
  return new Promise((resolve, reject) => {
    wx.request({
      url: base + '/api/health',
      method: 'GET',
      header: { 'X-Client-Build': BUILD_VERSION },
      timeout: HEALTH_REQUEST_TIMEOUT_MS,
      success: (response) => {
        const statusCode = Number(response && response.statusCode) || 0;
        if (statusCode >= 200 && statusCode < 300) return resolve({ statusCode, ok: true });
        reject(loginError('http_' + statusCode, { phase: 'health_probe', statusCode }));
      },
      fail: (transportError) => {
        reject(loginError(classifyLoginTransportError(transportError), { phase: 'health_probe' }));
      }
    });
  });
}

function updateProfile(patch) {
  return requestIdempotent('PUT', '/api/profile', patch, 'profile_update')
    .then((result) => saveProfile(result.profile || {}));
}

const apiSync = (since) => request('GET', '/api/sync?since=' + encodeURIComponent(since));
const apiPut = (collection, id, data, updatedAt, createOnly) =>
  requestIdempotent('PUT', '/api/records/' + collection + '/' + encodeURIComponent(id),
    createOnly ? { data, updatedAt, createOnly: true } : { data, updatedAt }, 'record_write');
const apiDelete = (collection, id, updatedAt) =>
  requestIdempotent('DELETE', '/api/records/' + collection + '/' + encodeURIComponent(id) + '?updatedAt=' + updatedAt, undefined, 'record_delete');

function getReminderCapabilities() {
  return request('GET', '/api/reminders/capabilities');
}

/* 订阅授权成功后上报 +1（一次订阅 = 一次触达）；kind: 'habit' | 'bill' */
function addReminderCredit(kind) {
  return request('PUT', '/api/reminders/credit', { kind });
}

function scheduleReminder(planId, dueAt) {
  return request('PUT', '/api/reminders/' + encodeURIComponent(planId), { dueAt: Number(dueAt) });
}

function cancelReminder(planId) {
  return request('DELETE', '/api/reminders/' + encodeURIComponent(planId));
}

function getInsight(scope, period) {
  const query = '?scope=' + encodeURIComponent(scope || 'today') + (period ? '&month=' + encodeURIComponent(period) : '');
  return request('GET', '/api/insights' + query);
}

function requestReminderSubscription(templateId) {
  if (!templateId || !wx.requestSubscribeMessage) return Promise.resolve(false);
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: (result) => resolve(result && result[templateId] === 'accept'),
      fail: () => resolve(false)
    });
  });
}

function requirePrivacyAuthorization() {
  if (!runtime.getRuntimeConfig().isProduction || !wx.requirePrivacyAuthorize) return Promise.resolve(true);
  return new Promise((resolve) => {
    wx.requirePrivacyAuthorize({
      success: () => resolve(true),
      fail: () => resolve(false)
    });
  });
}

function openPrivacyContract() {
  if (!wx.openPrivacyContract) return Promise.reject(new Error('privacy_contract_unavailable'));
  return new Promise((resolve, reject) => {
    wx.openPrivacyContract({ success: resolve, fail: reject });
  });
}

function deleteAccount() {
  const token = getToken();
  if (!token) return Promise.reject(new Error('not_logged_in'));
  return new Promise((resolve, reject) => {
    wx.login({
      success: (result) => {
        if (!result.code) return reject(new Error('fresh_login_failed'));
        doRequest('DELETE', '/api/account', { code: result.code }, token).then(resolve).catch(reject);
      },
      fail: () => reject(new Error('fresh_login_failed'))
    });
  });
}

module.exports = {
  getBaseUrl, setBaseUrl, getToken, getProfile, clearLogin, login, validateSession, checkHealth,
  updateProfile, ensureLogin, request, apiSync, apiPut, apiDelete,
  getReminderCapabilities, addReminderCredit, scheduleReminder, cancelReminder,
  requestReminderSubscription, requirePrivacyAuthorization, openPrivacyContract,
  getInsight, deleteAccount, getRuntimeConfig: runtime.getRuntimeConfig, DEFAULT_BASE
};
