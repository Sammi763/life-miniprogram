/* 服务端密钥仓库：数据库只保存 AES-GCM 密文，解密材料来自运行环境，不进入代码库。 */
const crypto = require('crypto');

const VERSION = 'v1';

function deriveKey(masterSecret) {
  const value = String(masterSecret || '').trim();
  return value ? crypto.createHash('sha256').update(value).digest() : null;
}

function encode(buffer) {
  return buffer.toString('base64url');
}

function decode(value) {
  return Buffer.from(String(value || ''), 'base64url');
}

function encryptSecret(value, masterSecret) {
  const key = deriveKey(masterSecret);
  if (!key) throw new Error('secret_encryption_key_missing');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value || ''), 'utf8'), cipher.final()]);
  return [VERSION, encode(iv), encode(cipher.getAuthTag()), encode(encrypted)].join(':');
}

function decryptSecret(value, masterSecret) {
  const stored = String(value || '');
  if (!stored) return '';
  // 兼容迁移前的人工配置；新写入值始终使用密文。
  if (!stored.startsWith(VERSION + ':')) return stored;
  const key = deriveKey(masterSecret);
  if (!key) throw new Error('secret_encryption_key_missing');
  const parts = stored.split(':');
  if (parts.length !== 4) throw new Error('secret_decrypt_failed');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, decode(parts[1]));
    decipher.setAuthTag(decode(parts[2]));
    return Buffer.concat([decipher.update(decode(parts[3])), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new Error('secret_decrypt_failed');
  }
}

function createSecretManager(store, config) {
  if (!store || typeof store.getSecret !== 'function' || typeof store.setSecret !== 'function') {
    throw new Error('secret_store_not_supported');
  }
  const options = config || {};
  const masterSecret = options.aiSecretEncryptionKey || (options.db && options.db.password) || '';
  return {
    async get(name) {
      const value = await store.getSecret(String(name || ''));
      return decryptSecret(value, masterSecret);
    },
    async set(name, value) {
      const secretName = String(name || '').trim();
      if (!secretName || !String(value || '').trim()) throw new Error('secret_value_missing');
      await store.setSecret(secretName, encryptSecret(String(value).trim(), masterSecret));
      return true;
    }
  };
}

module.exports = { createSecretManager, decryptSecret, deriveKey, encryptSecret };
