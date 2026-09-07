const { execFileSync, spawn } = require('child_process');
const path = require('path');

const DEFAULT_MYSQL_CONTAINER = 'je-mysql';

function readDockerPassword(containerName) {
  try {
    return execFileSync(
      'docker',
      ['exec', containerName, 'printenv', 'MYSQL_ROOT_PASSWORD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
  } catch (error) {
    throw new Error(`无法读取 Docker 容器 ${containerName} 的数据库密码。请确认容器已启动，或设置 DB_PASSWORD。`);
  }
}

function resolveDatabasePassword(environment, getDockerPassword = readDockerPassword) {
  if (environment.DB_PASSWORD) return environment.DB_PASSWORD;
  const containerName = environment.LIFE_MYSQL_CONTAINER || DEFAULT_MYSQL_CONTAINER;
  const password = getDockerPassword(containerName);
  if (!password) throw new Error('Docker MySQL 未设置 MYSQL_ROOT_PASSWORD，请设置 DB_PASSWORD 后重试。');
  return password;
}

function startLocalServer() {
  const databasePassword = resolveDatabasePassword(process.env);
  const serverDirectory = path.resolve(__dirname, '..');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: serverDirectory,
    env: {
      ...process.env,
      DB_PASSWORD: databasePassword,
      DEV_MODE: process.env.DEV_MODE || '1'
    },
    stdio: 'inherit'
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
  child.on('exit', (code) => { process.exitCode = code || 0; });
  child.on('error', () => { process.exitCode = 1; });
}

if (require.main === module) {
  try {
    startLocalServer();
  } catch (error) {
    console.error('本地后端启动失败：' + error.message);
    process.exitCode = 1;
  }
}

module.exports = { resolveDatabasePassword, startLocalServer };
