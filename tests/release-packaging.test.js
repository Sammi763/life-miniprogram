/*
 * 发布打包与模块加载检查 —— 共享工具（miniprogram/utils）必须随服务端包就位，
 * 解包后先过模块加载检查再启动；旧归档不得充当新版包。
 * 运行：node tests/release-packaging.test.js（依赖 server/node_modules，CI 在测试前 npm ci）
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const VERSION = 'test-' + Date.now();

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'life-pack-fixture-'));
  const outDir = path.join(fixture, 'actual-package');
  for (const relative of ['server/scripts/pack-release.js', 'server/server.js', 'miniprogram/utils/record-validation.js']) {
    const target = path.join(fixture, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, relative), target);
  }
  for (const relative of ['server/db/backups/fixture.sql.gz', 'server/data/avatars/fixture.jpg', 'server/.env', 'server/debug.log']) {
    const target = path.join(fixture, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'fixture');
  }
  execFileSync('node', ['server/scripts/pack-release.js'], {
    cwd: fixture,
    env: { ...process.env, RELEASE_VERSION: VERSION }
  });
  const fixtureManifest = JSON.parse(fs.readFileSync(path.join(fixture, 'dist', 'life-sync-release-' + VERSION + '.tar.gz.manifest.json')));
  assert.ok(!fixtureManifest.files.some(({ path }) => /backups|avatars|\.env|debug\.log/.test(path)));
  const unpackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-pack-unpack-'));

  /* ---------- 1. 现打新版包：产物、manifest、共享工具在列 ---------- */
  execFileSync('node', ['server/scripts/pack-release.js', '--out', outDir], {
    cwd: root,
    env: { ...process.env, RELEASE_VERSION: VERSION },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const bundle = path.join(outDir, 'life-sync-release-' + VERSION + '.tar.gz');
  const manifestPath = bundle + '.manifest.json';
  assert.ok(fs.existsSync(bundle), '必须产出 ' + path.basename(bundle));
  assert.ok(fs.existsSync(manifestPath), '必须产出 manifest');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(manifest.version, VERSION, 'manifest 版本必须来自本次 RELEASE_VERSION（防旧归档冒充）');
  const paths = manifest.files.map((file) => file.path);
  assert.ok(paths.includes('server/validation.js'), '包内必须有 server/validation.js');
  assert.ok(paths.includes('miniprogram/utils/record-validation.js'), '包内必须有共享的 record-validation.js');
  assert.ok(paths.includes('server/ai-insights.js'), '包内必须有 ai-insights（它 require miniprogram/utils）');
  assert.ok(!paths.some((file) => file.startsWith('server/node_modules/')), '包内不得包含 node_modules');
  const validationEntry = manifest.files.find((file) => file.path === 'miniprogram/utils/record-validation.js');
  assert.strictEqual(validationEntry.sha256, sha256(path.join(root, 'miniprogram', 'utils', 'record-validation.js')), 'manifest sha256 必须与源文件一致（可核对未用旧包）');

  /* ---------- 2. 解包 + 依赖就位后，模块加载检查必须通过 ---------- */
  execFileSync('tar', ['-xzf', bundle, '-C', unpackDir]);
  const unpackedServer = path.join(unpackDir, 'server');
  assert.ok(fs.existsSync(path.join(unpackDir, 'miniprogram', 'utils', 'record-validation.js')), '解包后共享工具必须就位');
  assert.ok(fs.existsSync(path.join(unpackedServer, 'validation.js')), '解包后 server/validation.js 必须就位');
  const nodeModules = path.join(root, 'server', 'node_modules');
  assert.ok(fs.existsSync(nodeModules), '本测试前置：server/node_modules 已安装（CI 先跑 npm ci --prefix server）');
  fs.symlinkSync(nodeModules, path.join(unpackedServer, 'node_modules'), 'dir');
  const check = execFileSync('node', [path.join(root, 'server', 'scripts', 'check-runtime-modules.js'), unpackedServer], { encoding: 'utf8' });
  assert.match(check, /RUNTIME_MODULES_OK/, '解包目录的模块加载检查必须全部通过');

  /* ---------- 3. 缺共享文件时检查必须失败（拦截旧共享包/缺文件启动） ---------- */
  fs.rmSync(path.join(unpackDir, 'miniprogram', 'utils', 'record-validation.js'));
  let failed = false;
  try {
    execFileSync('node', [path.join(root, 'server', 'scripts', 'check-runtime-modules.js'), unpackedServer], { encoding: 'utf8' });
  } catch (error) {
    failed = true;
    assert.match(String(error.stderr || error.message), /CHECK_FAIL/, '失败输出必须指明缺失文件');
  }
  assert.ok(failed, '缺少 record-validation.js 时模块检查必须非零退出');

  fs.rmSync(fixture, { recursive: true, force: true });
  fs.rmSync(unpackDir, { recursive: true, force: true });
  console.log('RELEASE_PACKAGING_TEST_PASSED');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
