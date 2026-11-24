/* 发布安全契约：开发便利不得泄漏到正式小程序。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateStartupConfig } = require('../server/server');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const runtime = read('miniprogram/config/runtime.js');
const api = read('miniprogram/utils/api.js');
const login = read('miniprogram/pages/login/login.wxml');
const mine = read('miniprogram/pages/mine/mine.wxml');
const legal = read('miniprogram/pages/legal/legal.js');
const schema = read('server/db/schema.sql');
const server = read('server/server.js');
const env = read('server/.env.example');
const productionEnv = read('server/.env.production.example');

assert.match(runtime, /PRODUCTION_API_BASE_URL/, '正式 API 域名必须只有一个受控配置入口');
assert.match(runtime, /allowServerOverride: !isProduction/, '正式版不得允许用户覆盖 API 域名');
assert.doesNotMatch(login, /服务器地址|baseInput|showServerSettings|127\.0\.0\.1/, '登录页不应暴露服务端地址或可编辑入口');
assert.doesNotMatch(mine, /服务器地址|baseInput|showServerSettings|127\.0\.0\.1/, '设置页不应暴露服务端地址或可编辑入口');
assert.doesNotMatch(api, /uploadFile|resolveFileUrl|access_token=/, '文本优先客户端不应保留文件上传或私有图片凭证');
assert.match(schema, /CREATE TABLE IF NOT EXISTS scheduled_reminders/i, '提醒任务必须持久化');
assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS uploads/i, '新建数据库不应再建立上传文件表');
assert.doesNotMatch(server, /\/api\/upload|\/files\/:fileName/, '生产服务不应暴露文件上传或读取端点');
assert.match(server, /origin_not_allowed/, '生产 CORS 必须限制来源');
assert.match(server, /validateRecordData/, '同步数据必须使用字段白名单校验');
assert.match(server, /\/api\/account/, '必须提供受新登录校验保护的数据删除接口');
assert.match(env, /DEV_MODE=0/, '生产配置示例必须强调关闭开发模式');
assert.match(env, /WX_REMINDER_TEMPLATE_ID/, '生产配置必须包含订阅模板 ID');
assert.match(productionEnv, /^DEV_MODE=0$/m, '生产环境必须从默认关闭开发模式的模板开始');
assert.match(productionEnv, /^TRUST_PROXY=1$/m, '反代部署的生产模板必须正确识别真实客户端 IP');
assert.ok(fs.existsSync(path.join(root, 'server/scripts/backup-mysql.sh')), '必须提供每日 MySQL 备份脚本');
assert.ok(fs.existsSync(path.join(root, 'server/deploy/life-backup.timer')), '必须提供每日备份定时器');
assert.ok(fs.existsSync(path.join(root, 'server/deploy/Caddyfile.example')), '必须提供可复用的 HTTPS 反向代理配置');
const caddyfile = read('server/deploy/Caddyfile.example');
assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:8787/, 'HTTPS 代理必须指向本机 Node 服务');
assert.match(caddyfile, /handle \/ws/, 'HTTPS 代理必须覆盖 WebSocket 路径');
assert.ok(fs.existsSync(path.join(root, 'docs/PRIVACY.md')), '必须提供可配置到微信后台的隐私指引');
assert.ok(fs.existsSync(path.join(root, 'docs/USER_AGREEMENT.md')), '必须提供用户协议模板');
assert.match(legal, /不向外部 AI 服务发送生活记录/, '小程序内必须说明首发的 AI 数据处理范围');
/*
 * 「我的」页的合规入口。2026-09-24 做过信息架构收纳：原先三份法律文档各占一行，
 * 现合并为一行「隐私与合规」→ pages/legal/legal（该页自带三个 tab）。
 * 这里钉的是「意图」而不是措辞：必须仍能从「我的」页一步进入隐私政策，且入口文案要写明包含隐私政策。
 */
assert.match(mine, /bindtap="goLegal"[^>]*data-doc="privacy"/, '用户必须可从我的页一步进入隐私政策');
assert.match(mine, /隐私政策/, '「我的」页的合规入口必须标明包含隐私政策');
assert.ok(!/data-doc="service"/.test(mine) && !/data-doc="sharing"/.test(mine), '服务协议与第三方说明应合并进「隐私与合规」入口，不再各占一行');

assert.throws(() => validateStartupConfig({ devMode: false, wxAppId: '', wxSecret: '', wxReminderTemplateId: '' }), /Production configuration missing/);
assert.doesNotThrow(() => validateStartupConfig({ devMode: false, wxAppId: 'app', wxSecret: 'secret', wxReminderTemplateId: 'template' }));

console.log('RELEASE_SECURITY_TEST_PASSED');
