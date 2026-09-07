/* 微信开放接口：只在服务端使用 AppSecret，客户端永远不接触它。 */
let accessTokenCache = { appId: '', value: '', expiresAt: 0 };

async function requestJson(url, options, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => controller && controller.abort(), Math.max(3000, Number(timeoutMs) || 10000));
  try {
    const response = await fetch(url, { ...(options || {}), ...(controller ? { signal: controller.signal } : {}) });
    let result;
    try { result = await response.json(); } catch (error) { throw new Error('wechat_api_invalid_response'); }
    if (!response.ok || (result && Number(result.errcode || 0) !== 0)) {
      throw new Error('wechat_api_failed');
    }
    return result;
  } catch (error) {
    // 统一错误类型，避免将上游 URL、令牌或响应正文写入调用方/日志。
    throw new Error('wechat_api_failed');
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken(config) {
  if (!config.wxAppId || !config.wxSecret) throw new Error('wechat_not_configured');
  if (accessTokenCache.appId === config.wxAppId && accessTokenCache.value && accessTokenCache.expiresAt > Date.now()) {
    return accessTokenCache.value;
  }
  const query = new URLSearchParams({
    grant_type: 'client_credential',
    appid: config.wxAppId,
    secret: config.wxSecret
  });
  const result = await requestJson('https://api.weixin.qq.com/cgi-bin/token?' + query.toString(), undefined, config.wxHttpTimeoutMs);
  if (!result.access_token) throw new Error('wechat_token_missing');
  accessTokenCache = {
    appId: config.wxAppId,
    value: result.access_token,
    expiresAt: Date.now() + Math.max(60, Number(result.expires_in || 7200) - 300) * 1000
  };
  return accessTokenCache.value;
}

async function exchangeLoginCode(config, code) {
  const loginCode = String(code || '').trim();
  if (!loginCode || loginCode.length > 512) throw new Error('bad_login_code');
  if (!config.wxAppId || !config.wxSecret) throw new Error('wechat_not_configured');
  const query = new URLSearchParams({
    appid: config.wxAppId,
    secret: config.wxSecret,
    js_code: loginCode,
    grant_type: 'authorization_code'
  });
  const result = await requestJson('https://api.weixin.qq.com/sns/jscode2session?' + query.toString(), undefined, config.wxHttpTimeoutMs);
  if (!result.openid) throw new Error('wechat_openid_missing');
  return String(result.openid);
}

async function exchangePhoneCode(config, code) {
  const phoneCode = String(code || '').trim();
  if (!phoneCode || phoneCode.length > 512) throw new Error('bad_phone_code');
  const accessToken = await getAccessToken(config);
  const result = await requestJson(
    'https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=' + encodeURIComponent(accessToken),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: phoneCode })
    },
    config.wxHttpTimeoutMs
  );
  const phone = result.phone_info && result.phone_info.phoneNumber;
  if (!phone) throw new Error('wechat_phone_missing');
  return String(phone);
}

async function sendSubscriptionMessage(config, message) {
  const accessToken = await getAccessToken(config);
  return requestJson(
    'https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + encodeURIComponent(accessToken),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message)
    },
    config.wxHttpTimeoutMs
  );
}

module.exports = { exchangeLoginCode, exchangePhoneCode, getAccessToken, requestJson, sendSubscriptionMessage };
