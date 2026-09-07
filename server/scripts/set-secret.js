/* 一次性写入数据库密钥；从 stdin 读取，不回显、不打印密钥。 */
const { loadConfig } = require('../config');
const { createStore } = require('../db/store');
const { createSecretManager } = require('../secret-store');
const { resolveDatabasePassword } = require('./start-docker-local');

function readSecret() {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += String(chunk || '');
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      process.stdin.removeListener('data', onData);
      resolve(buffer.slice(0, end).replace(/\r$/, '').trim());
    };
    process.stdin.on('data', onData);
    process.stdin.once('error', reject);
    process.stdin.resume();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const docker = args.includes('--docker');
  const name = args.find((item) => !item.startsWith('--')) || 'deepseek_api_key';
  const config = loadConfig();
  if (docker && config.storageDriver === 'mysql' && !config.db.password) {
    config.db.password = resolveDatabasePassword(process.env);
    config.aiSecretEncryptionKey = config.aiSecretEncryptionKey || config.db.password;
  }
  process.stderr.write('请输入要保存到数据库的密钥（输入不会回显）：');
  const secret = await readSecret();
  if (!secret) throw new Error('secret_value_missing');
  const store = createStore(config);
  await store.init();
  try {
    await createSecretManager(store, config).set(name, secret);
    process.stdout.write('密钥已写入数据库（仅保存加密值）。\n');
  } finally {
    await store.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write('密钥写入失败：' + error.message + '\n');
    process.exitCode = 1;
  });
}

module.exports = { readSecret };
