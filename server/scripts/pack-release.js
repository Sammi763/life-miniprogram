#!/usr/bin/env node
/*
 * 打包新版服务端发布 bundle。
 *
 * 背景：服务器上的 ai-insights 复用 miniprogram/utils、validation 复用
 * miniprogram/utils/record-validation —— 部署物必须包含「新版共享工具」。
 * 仓库根目录的 life-sync-*.tar.gz 是历史归档，不代表当前代码，严禁充当新版包；
 * 每次发布必须用本脚本现打，产物带 manifest（文件清单 + sha256）可核对。
 *
 * 用法：RELEASE_VERSION=20260929.1 node server/scripts/pack-release.js [--out <dir>]
 * 产物：<out>/life-sync-release-<version>.tar.gz + 同名 .manifest.json
 * 内容：server/**（排除 node_modules、data、.env*、备份与归档）+ miniprogram/utils/**
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const version = String(process.env.RELEASE_VERSION || '').trim() || 'dev-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const outArgIndex = process.argv.indexOf('--out');
const outDir = path.resolve(root, outArgIndex >= 0 ? process.argv[outArgIndex + 1] : 'dist');

const EXCLUDED_SERVER = new Set(['node_modules', 'data', 'dist']);
const EXCLUDED_SERVER_FILES = /^(?:\.env(\..+)?|life-sync-.*\.(?:tar\.gz|tgz))$/;

function listFiles(dir, base, predicate) {
  const output = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!predicate(entry.name, entry.isDirectory())) continue;
    const full = path.join(dir, entry.name);
    const relative = path.join(base, entry.name);
    if (entry.isDirectory()) output.push(...listFiles(full, relative, predicate));
    else if (entry.isFile()) output.push(relative);
  }
  return output;
}

function main() {
  const serverDir = path.join(root, 'server');
  const sharedDir = path.join(root, 'miniprogram', 'utils');
  if (!fs.existsSync(path.join(serverDir, 'server.js'))) throw new Error('找不到 server/server.js');
  if (!fs.existsSync(path.join(sharedDir, 'record-validation.js'))) throw new Error('找不到共享工具 miniprogram/utils/record-validation.js');

  const serverFiles = listFiles(serverDir, 'server', (name, isDir) => !(isDir ? EXCLUDED_SERVER.has(name) : EXCLUDED_SERVER_FILES.test(name)));
  const sharedFiles = listFiles(sharedDir, path.join('miniprogram', 'utils'), () => true);
  const files = serverFiles.concat(sharedFiles).sort();

  const staging = fs.mkdtempSync(path.join(outDir, 'pack-'));
  try {
    for (const relative of files) {
      const target = path.join(staging, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, relative), target);
    }
    const manifest = {
      version,
      createdAt: new Date().toISOString(),
      fileCount: files.length,
      files: files.map((relative) => {
        const buffer = fs.readFileSync(path.join(staging, relative));
        return { path: relative.split(path.sep).join('/'), bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
      })
    };
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const bundlePath = path.join(outDir, 'life-sync-release-' + version + '.tar.gz');
    execFileSync('tar', ['-czf', bundlePath, '-C', staging, '.']);
    fs.writeFileSync(bundlePath + '.manifest.json', JSON.stringify(manifest, null, 2));
    const sharedTouched = manifest.files.filter((file) => file.path.startsWith('miniprogram/utils/')).length;
    console.log('PACK_OK ' + bundlePath);
    console.log('files=' + manifest.fileCount + ' sharedUtils=' + sharedTouched + ' version=' + version);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

try { main(); } catch (error) { console.error('PACK_FAIL: ' + (error && error.message)); process.exit(1); }
