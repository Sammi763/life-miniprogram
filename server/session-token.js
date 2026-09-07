/* 会话令牌只以 SHA-256 指纹持久化；客户端拿到的原始令牌不会落入数据库。 */
const crypto = require('crypto');

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function isTokenHash(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''));
}

module.exports = { hashSessionToken, isTokenHash };
