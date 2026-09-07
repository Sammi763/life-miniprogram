/* 密钥存储测试：数据库保存密文，应用层才能解密。 */
const assert = require('assert');
const { encryptSecret, decryptSecret, createSecretManager } = require('../server/secret-store');

const encoded = encryptSecret('deepseek-test-key', 'master-key');
assert.match(encoded, /^v1:/, '密钥必须以版本化密文保存');
assert.doesNotMatch(encoded, /deepseek-test-key/, '数据库值不得直接暴露原始密钥');
assert.strictEqual(decryptSecret(encoded, 'master-key'), 'deepseek-test-key');
assert.throws(() => decryptSecret(encoded, 'wrong-key'), /secret_decrypt_failed/);

(async () => {
  let stored = '';
  const manager = createSecretManager({
    getSecret: async () => stored,
    setSecret: async (_name, value) => { stored = value; }
  }, { aiSecretEncryptionKey: 'master-key' });
  await manager.set('deepseek_api_key', 'deepseek-test-key');
  assert.notStrictEqual(stored, 'deepseek-test-key');
  assert.strictEqual(await manager.get('deepseek_api_key'), 'deepseek-test-key');
  console.log('SECRET_STORE_TEST_PASSED');
})().catch((error) => {
  console.error('FAIL:', error.stack || error.message);
  process.exit(1);
});
