/*
 * 严格模式语法护栏 —— 来自 2026-09-24 真机走查的一次真实翻车：
 *
 * miniprogram/utils/finance.js 里出现了两个 `function roundMoney(){}`。
 * 非严格模式下这是合法的（后者覆盖前者），所以 `node --check` 通过、`node tests/...` 全绿；
 * 但微信小程序的编译产物按严格模式处理，重复函数声明直接是 SyntaxError，
 * 结果是整个模块没被注入，运行时报
 *   module 'utils/finance.js' is not defined, require args is '../../utils/finance'
 * 记账页 / 待买页 / 月报页三页同时白屏。
 *
 * 所以：单元测试通过 ≠ 小程序能编译。这里把「同一文件里同名顶层声明只能出现一次」固化成断言。
 * 只检查第 0 列（模块顶层）的 function / const / let / var，避免误伤嵌套函数与块级作用域。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function collect(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { collect(full, out); continue; }
    if (/\.js$/.test(name)) out.push(full);
  }
  return out;
}

const files = [].concat(
  collect(path.join(root, 'miniprogram'), []),
  collect(path.join(root, 'server'), []),
  collect(path.join(root, 'tests'), [])
);

const problems = [];
files.forEach((file) => {
  const relative = path.relative(root, file);
  const source = fs.readFileSync(file, 'utf8');
  const seen = new Map();
  source.split('\n').forEach((line, index) => {
    /* 只看第 0 列声明；缩进过的都是函数体内或块级作用域，不算重复 */
    const match = line.match(/^(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)/);
    if (!match) return;
    const name = match[1] || match[3];
    if (!name) return;
    if (seen.has(name)) {
      problems.push(relative + ':' + seen.get(name) + ' 与 ' + (index + 1) + ' 重复声明了 `' + name + '`（严格模式下是语法错误）');
      return;
    }
    seen.set(name, index + 1);
  });
});

assert.deepStrictEqual(problems, [], '存在重复的顶层声明：\n  ' + problems.join('\n  '));

console.log('strict-syntax.test.js  OK（' + files.length + ' 个文件，无重复顶层声明 —— 避免小程序严格模式编译失败）');
