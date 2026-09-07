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
}

if (findings.length) {
  findings.forEach((finding) => console.error(`possible ${finding.type}: ${finding.file}:${finding.line}`));
  console.error('Source secret scan failed. Move secrets to the encrypted server-side secret store.');
  process.exitCode = 1;
} else {
  console.log('SOURCE_SECRET_SCAN_PASSED');
}
