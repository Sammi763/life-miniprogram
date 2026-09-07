const assert = require('assert');
const { buildTextAvatar } = require('../miniprogram/utils/text-avatar');

const fallback = buildTextAvatar('');
assert.strictEqual(fallback.label, '生', '没有昵称时应有亲切的文字头像兜底');
assert.match(fallback.tone, /^avatar-tone-[0-4]$/, '文字头像应落在受控的配色范围内');

const first = buildTextAvatar('小林');
const second = buildTextAvatar('小林');
assert.deepStrictEqual(first, second, '同一昵称在不同页面应得到同一文字头像');
assert.strictEqual(first.label, '小林', '中文昵称应保留前两个字符作为头像文字');
assert.strictEqual(buildTextAvatar(' Alex  Chen ').label, 'Al', '英文昵称应去除首尾空格后取前两个字符');

console.log('TEXT_AVATAR_TEST_PASSED');
