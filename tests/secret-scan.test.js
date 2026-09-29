/*
 * 发布前密钥扫描器的回归测试。
 *
 * 背景：扫描器原先只匹配 `sk-` 与 `Authorization: Bearer`，
 * 于是 `server/.env.example` 与 `server/.env.production.example` 先后被写进
 * 共 9 组真实凭证（AppSecret / 订阅消息模板 ID / 数据库密码 / AI 加密密钥），
 * 两次都报 `SOURCE_SECRET_SCAN_PASSED`。本测试锁住两件事：
 *   1. 当前仓库必须扫描干净（否则发布闸门形同虚设）；
 *   2. 扫描器必须真的能检出「env 模板里敏感键被赋了非空值」。
 * 只输出文件:行号，不回显任何值，临时文件在 finally 中删除。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const scanner = path.join(root, 'server', 'scripts', 'check-source-secrets.js');

function runScanner() {
  try {
    const stdout = execFileSync(process.execPath, [scanner], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status === undefined ? 1 : error.status, stdout: String(error.stdout || '') + String(error.stderr || '') };
  }
}

/* ---------- 1. 当前仓库必须干净 ---------- */

const clean = runScanner();
assert.strictEqual(clean.code, 0, '当前仓库不应存在疑似入库密钥：\n' + clean.stdout);
assert.ok(clean.stdout.includes('SOURCE_SECRET_SCAN_PASSED'), '扫描通过时应打印 SOURCE_SECRET_SCAN_PASSED');

/* ---------- 2. 两个 env 模板的敏感键必须留空 ---------- */

const SENSITIVE = ['WX_APPID', 'WX_SECRET', 'WX_REMINDER_TEMPLATE_ID', 'DB_PASSWORD', 'AI_SECRET_ENCRYPTION_KEY'];
['server/.env.example', 'server/.env.production.example'].forEach((relative) => {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  SENSITIVE.forEach((key) => {
    const matched = source.match(new RegExp('^' + key + '=(.*)$', 'm'));
    if (!matched) return;
    assert.strictEqual(
      matched[1].trim(),
      '',
      `${relative} 的 ${key} 必须留空占位；模板文件入库，填真实值等于泄露`
    );
  });
});

/* ---------- 3. 扫描器必须能检出被赋值的敏感键 ---------- */

const fixture = path.join(root, 'server', '.env.testfixture.example');
try {
  fs.writeFileSync(
    fixture,
    ['# 临时测试夹具：模拟被写进模板的敏感键', 'WX_SECRET=  definitely-not-a-real-secret', 'DB_PASSWORD=  also-not-real'].join('\n') + '\n',
    'utf8'
  );

  const dirty = runScanner();
  assert.strictEqual(dirty.code, 1, 'env 模板里敏感键非空时扫描器必须失败');
  assert.ok(
    /server\/\.env\.testfixture\.example:2/.test(dirty.stdout),
    '扫描器应报出 WX_SECRET 所在行，实际输出：' + dirty.stdout
  );
  assert.ok(
    /server\/\.env\.testfixture\.example:3/.test(dirty.stdout),
    '扫描器应报出 DB_PASSWORD 所在行，实际输出：' + dirty.stdout
  );
  /* 只报位置，不回显值——避免扫描日志本身成为二次泄露 */
  assert.ok(
    !dirty.stdout.includes('definitely-not-a-real-secret') && !dirty.stdout.includes('also-not-real'),
    '扫描结果不得回显疑似密钥的值'
  );
} finally {
  if (fs.existsSync(fixture)) fs.unlinkSync(fixture);
}

/* 清理后必须恢复干净，避免测试自身污染仓库 */
const restored = runScanner();
assert.strictEqual(restored.code, 0, '夹具清理后扫描应恢复通过：\n' + restored.stdout);
assert.ok(!fs.existsSync(fixture), '测试夹具必须被删除');

console.log('secret-scan.test.js  OK（仓库干净 / 模板留空 / 检出能力 / 不回显值 / 自清理）');
