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
/* v2.12 变更序号契约：seq 列、owner_seq 表与查询索引必须同在（mysql-store 依赖三者） */
assert.match(schema, /CREATE TABLE IF NOT EXISTS owner_seq/i, 'schema 缺少 owner_seq 表（变更序号头）');
assert.match(schema, /seq BIGINT UNSIGNED NOT NULL DEFAULT 0/i, 'records 必须带 seq 变更序号列');
assert.match(schema, /INDEX idx_records_owner_seq \(owner_id, seq\)/i, 'records 必须有 (owner_id, seq) 查询索引');
assert.match(fs.readFileSync(path.join(ROOT, 'server/db/mysql-store.js'), 'utf8'), /DELETE FROM owner_seq WHERE owner_id = \?/, '注销账号必须清除变更序号头');
assert.match(envExample, /STORAGE_DRIVER=mysql/, '默认存储驱动应为 MySQL');
assert.match(envExample, /DB_NAME=life_workbench/, '必须约定项目数据库名');
console.log('DATABASE_CONFIG_TEST_PASSED');
