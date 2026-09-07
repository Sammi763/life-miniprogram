const { loadConfig } = require('../config');
const { MySqlStore } = require('./mysql-store');

async function main() {
  const config = loadConfig();
  // 迁移命令显式执行 DDL；常驻生产服务默认仅校验既有 schema，不需要建库权限。
  config.db.runMigrations = true;
  if (process.argv.includes('--create-database')) config.db.autoCreate = true;
  const store = new MySqlStore(config);
  await store.init();
  await store.close();
  console.log(`数据库已就绪：${config.db.name} @ ${config.db.host}:${config.db.port}`);
}

main().catch((error) => {
  console.error('数据库迁移失败：', error.message);
  process.exitCode = 1;
});
