const api = require('./api');

let cached;
let pending;

function removeTemp(path) {
  if (!path || !wx.getFileSystemManager) return;
  wx.getFileSystemManager().unlink({ filePath: path, fail() {} });
}

function clear() {
  if (cached) removeTemp(cached.path);
  cached = null;
  pending = null;
}

function load(profile) {
  const token = api.getToken();
  const base = api.getBaseUrl();
  const version = profile && profile.avatarVersion;
  if (!version || !token || !wx.downloadFile) {
    clear();
    return Promise.resolve('');
  }
  if (cached && cached.token === token && cached.version === version && cached.base === base) {
    return Promise.resolve(cached.path);
  }
  if (pending && pending.token === token && pending.version === version && pending.base === base) return pending.promise;
  clear();
  const entry = { token, version, base };
  pending = entry;
  entry.promise = new Promise((resolve) => wx.downloadFile({
    url: base + '/api/profile/avatar?v=' + encodeURIComponent(version),
    header: { Authorization: 'Bearer ' + token },
    success(result) {
      if (pending !== entry || result.statusCode !== 200 || token !== api.getToken() || base !== api.getBaseUrl() ||
          api.getProfile().avatarVersion !== version) {
        removeTemp(result.tempFilePath);
        return resolve('');
      }
      cached = { path: result.tempFilePath, token, version, base };
      resolve(cached.path);
    },
    fail: () => resolve('')
  })).finally(() => { if (pending === entry) pending = null; });
  return entry.promise;
}

function encode(path) {
  const fs = wx.getFileSystemManager();
  const read = (filePath) => new Promise((resolve, reject) => fs.readFile({ filePath, encoding: 'base64', success: (result) => resolve(result.data), fail: reject }));
  const compress = () => new Promise((resolve, reject) => {
    if (!wx.compressImage) return reject(new Error('头像文件过大'));
    wx.compressImage({ src: path, quality: 75, compressedWidth: 320, compressedHeight: 320, success: (result) => resolve(result.tempFilePath), fail: reject });
  });
  const fits = (data) => data.length <= Math.ceil(80 * 1024 / 3) * 4;
  return new Promise((resolve, reject) => fs.stat({
    path,
    success: (result) => resolve(result.stats.size <= 80 * 1024),
    fail: reject
  })).then((small) => small ? read(path) : compress().then(read)).then((data) => {
    if (!fits(data)) throw new Error('头像文件过大');
    return data;
  });
}

function save(path) {
  const token = api.getToken();
  const request = path ? encode(path).then((image) => api.request('PUT', '/api/profile/avatar', { image })) :
    api.request('DELETE', '/api/profile/avatar');
  return request.then(({ profile }) => {
    if (token !== api.getToken()) throw new Error('session_changed');
    clear();
    return api.saveProfile(profile);
  });
}

module.exports = { clear, load, save };
