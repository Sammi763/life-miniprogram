const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const helperPath = path.join(root, 'server', 'scripts', 'start-docker-local.js');
const packagePath = path.join(root, 'server', 'package.json');
const loginPagePath = path.join(root, 'miniprogram', 'pages', 'login', 'login.js');
const loginTemplatePath = path.join(root, 'miniprogram', 'pages', 'login', 'login.wxml');

assert.ok(fs.existsSync(helperPath), '本地 Docker 启动脚本必须存在');

const { resolveDatabasePassword } = require(helperPath);
assert.strictEqual(
  resolveDatabasePassword({ DB_PASSWORD: 'provided-password' }, () => { throw new Error('should not run'); }),
  'provided-password',
  '显式 DB_PASSWORD 应优先于 Docker 容器密码'
);
assert.strictEqual(
  resolveDatabasePassword({ LIFE_MYSQL_CONTAINER: 'custom-mysql' }, (containerName) => {
    assert.strictEqual(containerName, 'custom-mysql');
    return 'docker-password';
  }),
  'docker-password',
  '未提供 DB_PASSWORD 时应读取指定 Docker 容器的密码'
);

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
assert.strictEqual(packageJson.scripts['dev:docker'], 'node scripts/start-docker-local.js');

const loginPage = fs.readFileSync(loginPagePath, 'utf8');
const loginTemplate = fs.readFileSync(loginTemplatePath, 'utf8');
assert.match(loginPage, /serverError/, '登录页应保留可读的服务连接错误状态');
assert.match(loginTemplate, /server-error/, '登录页应渲染服务连接错误提示');

console.log('LOCAL_START_TEST_PASSED');
