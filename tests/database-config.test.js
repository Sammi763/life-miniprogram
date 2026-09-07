/* 数据库契约：本地 Docker MySQL 与未来服务器迁移共用同一份 schema。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8');
const envExample = fs.readFileSync(path.join(ROOT, 'server/.env.example'), 'utf8');

assert.match(schema, /CREATE TABLE IF NOT EXISTS records/i, 'schema 缺少 records 表');
assert.match(schema, /CREATE TABLE IF NOT EXISTS sessions/i, 'schema 缺少 sessions 表');
assert.match(schema, /CREATE TABLE IF NOT EXISTS users/i, 'schema 缺少 users 表');
assert.match(schema, /owner_id/i, 'records 必须按用户隔离');
assert.match(schema, /updated_at/i, 'records 必须保留 LWW 时间戳');
assert.match(schema, /JSON/i, '业务数据必须使用 JSON 字段');
assert.match(envExample, /STORAGE_DRIVER=mysql/, '默认存储驱动应为 MySQL');
assert.match(envExample, /DB_NAME=life_workbench/, '必须约定项目数据库名');
console.log('DATABASE_CONFIG_TEST_PASSED');
