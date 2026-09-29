/* 发布前静态密钥扫描：只报告文件和行号，绝不回显疑似密钥。 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const scanRoots = ['miniprogram', 'server', 'docs', 'tests', '.github'];
const ignoredDirectories = new Set(['node_modules', '.git', 'data', 'backups']);
const allowedExtensions = new Set(['.js', '.json', '.md', '.wxml', '.wxss', '.yml', '.yaml', '.sql', '.sh', '.service', '.timer', '.example']);
const patterns = [
  { name: 'API key', expression: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Bearer token', expression: /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{32,}/gi }
];

/*
 * env 模板文件（*.example）里的敏感键必须留空。
 * 上一版只查 sk- 与 Bearer，于是 server/.env.example 与 server/.env.production.example
 * 各被写进 4~5 组真实凭证（AppSecret / 模板 ID / 库密码 / AI key），两次都报 PASSED。
 * 这里按「键名 + 非空值」判定，覆盖那两类盲区；只输出文件:行号，不回显任何值。
 */
const sensitiveEnvKeys = new Set([
  'WX_APPID',
  'WX_SECRET',
  'WX_REMINDER_TEMPLATE_ID',
  'DB_PASSWORD',
  'MYSQL_ROOT_PASSWORD',
  'MYSQL_PASSWORD',
  'AI_SECRET_ENCRYPTION_KEY',
  'SESSION_SECRET',
  'TOKEN_SECRET',
  'JWT_SECRET',
  'API_KEY'
]);
const envTemplateFile = /\.env(\.[A-Za-z0-9_-]+)*\.example$/;

function scanEnvTemplate(file, source, findings) {
  const lines = source.split('\n');
  lines.forEach((text, index) => {
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const separator = trimmed.indexOf('=');
    if (separator < 0) return;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!value) return;
    if (sensitiveEnvKeys.has(key)) {
      findings.push({ file: path.relative(root, file), line: index + 1, type: 'sensitive env value' });
    }
  });
}

function walk(directory, files) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) walk(path.join(directory, entry.name), files);
      continue;
    }
    if (entry.isFile() && allowedExtensions.has(path.extname(entry.name))) files.push(path.join(directory, entry.name));
  }
}

const files = [];
scanRoots.forEach((relative) => walk(path.join(root, relative), files));
const findings = [];
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const pattern of patterns) {
    pattern.expression.lastIndex = 0;
    let match;
    while ((match = pattern.expression.exec(source))) {
      const line = source.slice(0, match.index).split('\n').length;
      findings.push({ file: path.relative(root, file), line, type: pattern.name });
    }
  }
  if (envTemplateFile.test(path.basename(file))) scanEnvTemplate(file, source, findings);
}

if (findings.length) {
  findings.forEach((finding) => console.error(`possible ${finding.type}: ${finding.file}:${finding.line}`));
  console.error('Source secret scan failed. Move secrets to the encrypted server-side secret store.');
  process.exitCode = 1;
} else {
  console.log('SOURCE_SECRET_SCAN_PASSED');
}
