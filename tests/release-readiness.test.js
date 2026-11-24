/* 正式发布收口契约：不允许把开发便利、未同意 AI 或敏感会话带入生产。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const config = read('server/config.js');
const server = read('server/server.js');
const mysql = read('server/db/mysql-store.js');
const sync = read('miniprogram/utils/sync.js');
const legal = read('miniprogram/pages/legal/legal.js');
const privacy = read('docs/PRIVACY.md');

assert.match(config, /bindHost/, '生产配置必须支持回环监听');
assert.match(config, /DB_AUTO_CREATE/, '生产配置必须能关闭自动建库');
assert.match(config, /DB_RUN_MIGRATIONS/, '生产配置必须能关闭运行时迁移');
assert.match(server, /https_required/, '生产环境必须可拒绝非 HTTPS 请求');
assert.match(server, /no-store, private/, '私有 API 响应必须禁止缓存');
assert.match(mysql, /hashSessionToken/, '会话令牌必须持久化为哈希');
assert.match(sync, /isProduction\) return/, '体验/正式版不得播种开发示例数据');
assert.match(legal, /不向外部 AI 服务发送生活记录/, '法律页应与首发数据范围一致');
assert.doesNotMatch(read('miniprogram/pages/mine/mine.js'), /chooseMessageFile|shareFileMessage/, '首发备份只走剪贴板');
assert.match(read('miniprogram/pages/mine/mine.wxml'), /wx:if="\{\{showPersonalizedAi\}\}" class="setting-row ai-setting"/, '个性化 AI 开关按环境控制');
const runtime = require('../miniprogram/config/runtime');
for (const [envVersion, consentKey] of [['trial', 'trialAiConsent'], ['release', ''], ['develop', 'aiConsent']]) {
  global.wx = { getAccountInfoSync: () => ({ miniProgram: { envVersion } }) };
  assert.strictEqual(runtime.getRuntimeConfig().aiConsentKey, consentKey);
}
delete global.wx;
assert.match(privacy, /剪贴板/, '隐私指引必须声明主动导出时的剪贴板使用');
assert.ok(fs.existsSync(path.join(root, 'server/scripts/check-release-config.js')), '必须提供人工配置完成后的发布闸门');
assert.ok(fs.existsSync(path.join(root, 'server/deploy/mysql-production-init.sql.example')), '必须提供低权限 MySQL 初始化模板');

console.log('RELEASE_READINESS_TEST_PASSED');
