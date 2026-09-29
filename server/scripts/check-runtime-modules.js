#!/usr/bin/env node
/*
 * 对解包后的服务端目录做模块加载检查（发布闸门，在启动服务之前执行）。
 *
 * 检查内容：
 *   1. 共享工具就位：miniprogram/utils/record-validation.js 等必须存在于解包目录
 *      （server/validation.js、server/ai-insights.js 都跨目录 require 它们）；
 *   2. 全部 server 运行期模块可加载 —— 任何一个 Cannot find module 都直接失败，
 *      避免用旧共享归档或缺文件的包启动出「能跑但不完整」的服务。
 *
 * 用法：node server/scripts/check-runtime-modules.js /path/to/unpacked/server
 * 前置：解包目录内已安装依赖（npm ci --omit=dev），因为 db/store 会 require mysql2。
 * 退出码：0 = 全部可加载；1 = 缺文件或加载失败。
 */
const path = require('path');

const target = path.resolve(String(process.argv[2] || ''));
const REQUIRED_SHARED = [
  'miniprogram/utils/record-validation.js',
  'miniprogram/utils/report-utils.js',
  'miniprogram/utils/daily-utils.js',
  'miniprogram/utils/memory-utils.js',
  'miniprogram/utils/plan-utils.js'
];
const MODULES = [
  './validation',
  './wechat',
  './session-token',
  './secret-store',
  './config',
  './reminders',
  './ai-insights',
  './db/store',
  './db/file-store',
  './db/mysql-store'
];

function main() {
  const fs = require('fs');
  let failed = false;
  for (const relative of REQUIRED_SHARED) {
    const full = path.join(target, '..', relative);
    if (!fs.existsSync(full)) {
      console.error('CHECK_FAIL missing shared file: ' + relative);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  // 模块内部互相 require 用的是相对自身路径，因此这里必须用「目标目录下的绝对路径」require，
  // 等价于把包原样放进该目录运行；process.chdir 只是让 config 之类的 cwd 相对读取也对。
  process.chdir(target);
  for (const name of MODULES) {
    try {
      require(path.join(target, name));
      console.log('CHECK_OK ' + name);
    } catch (error) {
      console.error('CHECK_FAIL ' + name + ': ' + (error && error.message));
      process.exit(1);
    }
  }
  console.log('RUNTIME_MODULES_OK');
}

main();
