const api = require('./api');
const store = require('./store');

function focusDraftKey() {
  const { accountKey } = api.getProfile();
  return accountKey && api.getToken() ? 'wb_life_focus:' + api.getBaseUrl() + ':' + accountKey : '';
}

function readFocusDraft(key = focusDraftKey()) {
  if (!key) return null;
  try {
    const draft = wx.getStorageSync(key);
    if (!draft || !draft.id || !Number.isFinite(draft.targetAt)) return null;
    if (!(store.state.records.focusSessions || {})[draft.id]) return draft;
    wx.removeStorageSync(key);
  } catch (error) { /* Local storage may be unavailable. */ }
  return null;
}

module.exports = { focusDraftKey, readFocusDraft };
