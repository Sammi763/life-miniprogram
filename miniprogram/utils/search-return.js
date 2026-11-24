const api = require('./api');

let savedSearch;

function rememberSearch(data, visibleResults) {
  savedSearch = { server: api.getBaseUrl(), token: api.getToken(), data, visibleResults };
}

function consumeSearch() {
  const saved = savedSearch;
  savedSearch = null;
  if (saved && saved.token === api.getToken() && saved.server === api.getBaseUrl()) return saved;
  return null;
}

function returnToSearch() {
  wx.navigateTo({ url: '/pages/search/search?resume=1' });
}

function clearSavedSearch() {
  savedSearch = null;
}

module.exports = { rememberSearch, consumeSearch, returnToSearch, clearSavedSearch };
