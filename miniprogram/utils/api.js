/* HTTP 层：baseUrl/token 管理 + Promise 封装；登录入口由用户主动触发 */
const BASE_KEY = 'wb_life_baseurl';
const TOKEN_KEY = 'wb_life_token';
const PROFILE_KEY = 'wb_life_profile';
const runtime = require('../config/runtime');
const DEFAULT_BASE = runtime.DEVELOPMENT_API_BASE_URL;

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

function rawLogin() {
  if (!getBaseUrl()) return Promise.reject(new Error('api_not_configured'));
  return new Promise((resolve, reject) => {
    wx.login({
      success: (r) => {
        wx.request({
          url: getBaseUrl() + '/api/login',
          method: 'POST',
          data: { code: r.code || 'dev' },
          success: (res) => {
            if (res.statusCode === 200 && res.data && res.data.token) {
              try { wx.setStorageSync(TOKEN_KEY, res.data.token); } catch (e) { /* ignore */ }
              if (res.data.profile) saveProfile(res.data.profile);
              resolve(res.data.token);
            } else {
              reject(new Error('login http ' + res.statusCode));
            }
          },
          fail: (e) => reject(e)
        });
      },
      fail: (e) => reject(e)
    });
  });
}

let loginPromise = null;
function ensureLogin() {
  if (getToken()) return Promise.resolve(getToken());
  if (!loginPromise) {
    loginPromise = rawLogin().finally(() => { loginPromise = null; });
  }
  return loginPromise;
}

function login() {
  return rawLogin().then(() => getProfile());
}

function request(method, path, data) {
  return ensureLogin().then((token) => doRequest(method, path, data, token));
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
          error.code = res.data && res.data.error;
          reject(error);
        }
      },
      fail: (e) => reject(new Error((e && e.errMsg) || 'request fail'))
    });
  });
}

function validateSession() {
  const token = getToken();
  if (!token) return Promise.reject(new Error('not_logged_in'));
  return doRequest('GET', '/api/profile', undefined, token)
    .then((result) => saveProfile(result.profile || {}))
    .catch((error) => {
      if (error.statusCode === 401) clearLogin();
      throw error;
    });
}

function updateProfile(patch) {
  return request('PUT', '/api/profile', patch).then((result) => saveProfile(result.profile || {}));
}

const apiSync = (since) => request('GET', '/api/sync?since=' + encodeURIComponent(since));
const apiPut = (collection, id, data, updatedAt) =>
  request('PUT', '/api/records/' + collection + '/' + encodeURIComponent(id), { data, updatedAt });
const apiDelete = (collection, id, updatedAt) =>
  request('DELETE', '/api/records/' + collection + '/' + encodeURIComponent(id) + '?updatedAt=' + updatedAt);

function getReminderCapabilities() {
  return request('GET', '/api/reminders/capabilities');
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
  getBaseUrl, setBaseUrl, getToken, getProfile, clearLogin, login, validateSession,
  updateProfile, ensureLogin, request, apiSync, apiPut, apiDelete,
  getReminderCapabilities, scheduleReminder, cancelReminder,
  requestReminderSubscription, requirePrivacyAuthorization, openPrivacyContract,
  getInsight, deleteAccount, getRuntimeConfig: runtime.getRuntimeConfig, DEFAULT_BASE
};
