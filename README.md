# 生活记忆 life

生活记忆是一个微信小程序，用来手工记账、打卡、安排日程和回顾生活。小程序配有自建 Node.js 同步后端，生产使用 MySQL，本地可用文件存储调试。

当前源码为 **v2.12**，小程序体验候选构建为 **1.0.4**。发布状态和本地验证结果见[版本说明](docs/release-v2.12-notes.md)。

| 功能 | 可以做什么 |
| --- | --- |
| 今日与计划 | 查看待办和提醒，继续专注计时，管理重复日程和子任务 |
| 记账 | 记录收支、转账、分类预算、周期账单和分次还款，按账户、类型、分类或日期查找流水 |
| 随记与复盘 | 写随记、搜索旧记录、回看往年今日、查看周复盘和月报 |
| 习惯与清单 | 按计划打卡，跟踪健身、待买和书影音 |
| 跨设备与数据管理 | 微信登录、个人头像、离线同步、剪贴板备份与恢复、账户删除 |

## 本地运行

需要 Node.js 20.9 或更高版本，建议使用与 CI 一致的 Node.js 24。

```bash
npm ci --prefix server
STORAGE_DRIVER=file DEV_MODE=1 PORT=8787 node server/server.js
```

在微信开发者工具中导入**仓库根目录**。本地 AppID 和开发者工具个人设置放在 `project.private.config.json`。开发版 API 默认使用 `http://127.0.0.1:8787`，体验版和正式版使用 [runtime.js](miniprogram/config/runtime.js) 中配置的 HTTPS 域名。

如果已有本地 Docker MySQL，可以改用下列命令。默认容器名为 `je-mysql`，可通过 `LIFE_MYSQL_CONTAINER` 指定实际容器。

```bash
npm run db:migrate:docker --prefix server
npm run dev:docker --prefix server
```

## 测试

在独立目录启动文件存储服务，再在另一个终端运行测试。全量测试中的接口用例需要本机 8787 端口上的调试服务。

```bash
STORAGE_DRIVER=file DATA_DIR="$(mktemp -d)" DEV_MODE=1 PORT=8787 node server/server.js
```

```bash
for test_file in tests/*.test.js; do node "$test_file" || exit 1; done
npm run security:scan --prefix server
```

[CI 工作流](.github/workflows/ci.yml)还检查 JavaScript 语法和生产依赖。

## 部署与发布

1. 按[版本说明](docs/release-v2.12-notes.md)准备服务端发布包，备份生产数据，执行 MySQL 迁移并验证新版服务。
2. 服务端确认健康后，用微信开发者工具上传小程序，在微信公众平台的版本管理中选为体验版。
3. 按[发布检查表](docs/RELEASE_CHECKLIST.md)完成真机验收，再走正式审核。

| 文档 | 内容 |
| --- | --- |
| [功能清单](docs/FEATURES.md) | 产品功能、记录模型与接口 |
| [v2.12 版本说明](docs/release-v2.12-notes.md) | 本版改动、迁移、备份和回退 |
| [部署与联调交接](docs/部署与联调交接说明.md) | 历次服务器部署和网络排查记录 |
| [隐私政策](docs/PRIVACY_POLICY.md) · [第三方处理说明](docs/THIRD_PARTY_PROCESSING.md) · [用户服务协议](docs/USER_AGREEMENT.md) | 用户协议与数据处理约定 |
