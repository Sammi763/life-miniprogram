/*
 * 发布前仅需在此处填入已备案、已配置到微信后台的 HTTPS API 域名。
 * 真机正式版不会读取本地地址缓存，避免用户将微信登录请求指向任意服务器。
 */
const DEVELOPMENT_API_BASE_URL = 'http://127.0.0.1:8787';
const PRODUCTION_API_BASE_URL = 'https://wx.yzflab.top';

function accountEnvironment() {
  try {
    const info = wx.getAccountInfoSync && wx.getAccountInfoSync();
    return info && info.miniProgram && info.miniProgram.envVersion || 'develop';
  } catch (error) {
    return 'develop';
  }
}

function getRuntimeConfig() {
  const envVersion = accountEnvironment();
  const isProduction = envVersion === 'release' || envVersion === 'trial';
  return {
    envVersion,
    isProduction,
    apiBaseUrl: (isProduction ? PRODUCTION_API_BASE_URL : DEVELOPMENT_API_BASE_URL).replace(/\/+$/, ''),
    allowServerOverride: !isProduction,
    apiConfigured: !isProduction || Boolean(PRODUCTION_API_BASE_URL)
  };
}

module.exports = { DEVELOPMENT_API_BASE_URL, PRODUCTION_API_BASE_URL, getRuntimeConfig };
