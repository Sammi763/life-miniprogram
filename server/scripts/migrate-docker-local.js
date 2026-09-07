/* 使用本地 Docker MySQL 容器的密码执行迁移，避免把密码写入 .env。 */
const { spawnSync } = require('child_process');
const path = require('path');
const { resolveDatabasePassword } = require('./start-docker-local');

function migrateLocalDatabase() {
  const password = resolveDatabasePassword(process.env);
  const result = spawnSync(process.execPath, ['db/migrate.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DB_PASSWORD: password },
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  process.exitCode = result.status || 0;
}

if (require.main === module) {
  try { migrateLocalDatabase(); } catch (error) { console.error('本地数据库迁移失败：' + error.message); process.exitCode = 1; }
}

module.exports = { migrateLocalDatabase };
