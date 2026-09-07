# 生活记忆 life — 微信小程序版（自建服务器方案）

小程序端 + Node.js 同步后端。开发环境使用 Docker MySQL，数据可通过 `mysqldump` 迁移到你自己的境内云服务器，小程序与未来网页版可共用同一后端。

当前代码为 **v2.1「文字优先的生活账本与记忆」**：日/周重复日程、单次订阅提醒、纯文字随记与时间线、私密周/月复盘、收入/支出/转账账本、资产/负债账户、分类预算、四套可同步切换的界面主题、账户数据删除和每日数据库备份均已实现；不接收图片、音频或其他文件，也不接入第三方金融数据。个性化 AI 默认关闭，只有用户主动开启后才会由服务端发送裁剪摘要生成文案；密钥不进入代码。正式发布前仍须填入真实 HTTPS 域名、微信凭证、运营主体与联系信息，并执行 [发布检查表](docs/RELEASE_CHECKLIST.md)。

> 📋 **功能点清单与迭代路线**（开发需求基线）：[docs/FEATURES.md](docs/FEATURES.md)

```
life-miniprogram/
├── server/          # 同步后端（Express + ws，默认 Docker MySQL）
│   ├── server.js
│   ├── db/schema.sql      # MySQL 表结构
│   ├── db/migrate.js      # 建库 / 建表
│   ├── package.json
│   ├── .env.example
│   └── deploy/life-sync.service   # systemd 部署文件
└── miniprogram/     # 小程序端（微信开发者工具可直接导入项目根目录）
```

---

## 一、先跑起来（今天就能做，不需要域名和备案）

1. **后端本地试跑**（本机已验证页面、接口、同步等 9 项回归测试）：
   ```bash
   cd server
   npm install
   npm run db:migrate:docker # 首次或更新表结构时执行；自动读取 je-mysql 容器密码
   npm run dev:docker  # 推荐：自动读取本机 je-mysql Docker 容器的密码并启动后端
   ```
   若你的 MySQL 容器不是 `je-mysql`，先设置 `LIFE_MYSQL_CONTAINER=容器名` 再运行该命令。
   或者手动配置 `.env`：
   ```bash
   cp .env.example .env   # 填 DB_PASSWORD；默认连接 Docker MySQL
   npm install
   npm run db:migrate
   node server.js
   # 看到「生活记忆 life 同步后端已启动」即成功，数据写入 Docker MySQL 的 life_workbench 库
   ```
2. **微信开发者工具**：下载安装（https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html ），直接导入项目根目录即可；根目录 `project.config.json` 已将小程序源码指向 `miniprogram/`。也可以只导入 `miniprogram/` 目录。AppID 用测试号（或填你注册的 AppID）。
3. 开发者工具右上角「详情 → 本地设置」勾选 **「不校验合法域名…」**（project.config.json 里已预置 `urlCheck: false`）。
4. 编译运行：首次启动先进入登录页，阅读并同意协议后点击「微信登录并开始」，可填写昵称并按需授权手机号；昵称会生成稳定的文字头像。开发版可使用示例数据辅助调试，体验版和正式版会从干净的个人空间开始。服务端地址由 `runtime.js` 管理，用户页面不提供地址输入。
5. 真机预览：点「预览」扫码，手机上打开右上角「…→ 开发调试」开启调试模式即可访问本机 IP。

## 二、正式发布前需要确认的事项

| 步骤 | 去哪办 | 花费 | 耗时 |
|---|---|---|---|
| ① 确认小程序主体与可发布范围 | 微信公众平台与实际运营主体 | 以平台为准 | 以平台审核为准 |
| ② 绑定正式 HTTPS 域名 | 域名注册商、服务器接入商 | 以服务商为准 | DNS、生效与证书时间各异 |
| ③ 确认备案/许可要求 | 服务器所在地、接入商与主管部门指引 | 以实际情况为准 | 以实际流程为准 |

不要根据本文假定主体、地区或备案周期。正式发布前请逐项完成 [发布检查表](docs/RELEASE_CHECKLIST.md)，并以接入商和主管部门/微信后台的当期要求为准。

## 三、部署到你的云服务器

```bash
# 1. 上传 server/ 目录到服务器，如 /opt/life-sync-server
# 2. 服务器上（需 Node.js ≥ 18）
cd /opt/life-sync-server && npm install
cp .env.production.example .env   # 填 WX_APPID / WX_SECRET / WX_REMINDER_TEMPLATE_ID 和服务器 DB 参数
# 首次迁移使用受控迁移账号；常驻 life_sync 账号不应拥有 DDL 权限
DB_RUN_MIGRATIONS=1 npm run db:migrate
# systemd 示例以 www-data 运行，先创建它可写的本地文件存储兜底与备份目录
sudo install -d -o www-data -g www-data /opt/life-sync-server/data /opt/life-sync-server/db/backups
# 3. systemd 常驻
sudo cp deploy/life-sync.service /etc/systemd/system/   # 按注释改路径
sudo cp deploy/life-backup.service deploy/life-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now life-sync
sudo systemctl enable --now life-backup.timer
# 4. HTTPS：安装 Caddy 后复制仓库提供的安全反代模板，替换正式域名并校验后重载
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile  # 将 api.example.com 改成你的已备案域名
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
# Caddy 自动签发/续期 HTTPS，并自动透传 /ws 的 WebSocket Upgrade。
```

### 从本机 Docker MySQL 迁移数据

本机和服务器使用同一份 `server/db/schema.sql`。首次部署服务器时，先在服务器执行 `npm run db:migrate` 建库建表；需要把本机数据一起带过去时，可导出 `life_workbench` 后导入服务器：

```bash
# 本机：把 Docker 容器中的库导出为 SQL；密码只在容器内部读取，不会写进文件
docker exec je-mysql sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --events life_workbench' > life_workbench.sql

# 将 life_workbench.sql 安全传到服务器后，在服务器导入
mysql -h 127.0.0.1 -u <数据库用户> -p life_workbench < life_workbench.sql
```

如果本机容器名不是 `je-mysql`，替换为实际容器名。导入前建议先保留服务器现有备份；迁移完成后在 `miniprogram/config/runtime.js` 填入正式 HTTPS 域名，再重新编译小程序。

## 四、上线前配置清单

1. **小程序后台**（开发 → 开发设置 → 服务器域名）只需配置 request 和 socket 两类合法域名，全部填你的备案域名（不带端口、不带路径）：
   - request 合法域名：`https://api.你的域名.com`
   - socket 合法域名：`wss://api.你的域名.com`
2. **server/.env**：`DEV_MODE=0`，填 `WX_APPID`、`WX_SECRET`、`WX_REMINDER_TEMPLATE_ID`、独立 `AI_SECRET_ENCRYPTION_KEY`、服务器 DB 参数，并保持 `BIND_HOST=127.0.0.1`、`REQUIRE_HTTPS=1`、`DB_AUTO_CREATE=0`、`DB_RUN_MIGRATIONS=0`；使用下方 Caddy/nginx 反代模板时同时设 `TRUST_PROXY=1`，再重启服务。手机号授权还要求后端能访问微信接口；服务端会用手机号授权 code 调用 `getuserphonenumber`，不会信任前端直接提交的号码。生产配置缺少 AppID、Secret 或提醒模板时，服务会拒绝启动。
3. 在 `server/` 中执行 `npm run secret:set`（生产）或 `npm run secret:set:docker`（本机），按提示把 DeepSeek API Key 写入 `app_secrets`；不要把 API Key 写进代码或 `.env`。
4. 在 `miniprogram/config/runtime.js` 填 `PRODUCTION_API_BASE_URL=https://api.你的域名.com`，重新编译。服务端地址仅由运行配置管理，不会出现在用户界面；正式版也不读取本地地址缓存。
5. 在微信后台填写隐私指引（可直接使用 [docs/PRIVACY.md](docs/PRIVACY.md) 的内容）、订阅消息模板和 request / socket 合法域名，再提交审核。小程序内的运营主体、联系信息、第三方说明也必须替换为真实值。上线前请实际运行一次 `scripts/backup-mysql.sh` 并从生成的 SQL 恢复到空库，确认备份可用；最后执行 `npm run release:check`。

## 五、同步协议（给未来网页版复用）

- 客户端时间戳 `updatedAt` 做 LWW（last-write-wins），旧写入被服务端拒绝并回传最新值
- 删除为软删 tombstone，增量同步时其他设备能收到删除事件
- `GET /api/sync?since=<本地见过的最大 updatedAt>` 增量拉取；`PUT /api/records/:collection/:id` 幂等 upsert；WebSocket `/ws` 收到变更通知后增量拉取
- 网页版数据迁移：把现有工作台导出的 JSON 按集合灌入 `PUT` 接口即可（或后续我帮你写导入脚本）

## 六、当前版本与迭代计划

- ✅ 已实现：今日概览（生活指数、AI 轻提醒、写下此刻、最重要一件事、统一待处理、还款提示）/ 记账理财 / 习惯健康 / 日程统筹 / 待买清单 / 书影音 / 减脂健身
- ✅ v1.6：周日历、日/周重复日程、单日完成/跳过覆盖、单次订阅提醒、私密月度报告、账户删除、每日 MySQL 备份（30 天保留）
- ✅ v1.6.1：纯文字书影音、昵称文字头像、记录卡片按压反馈；不接收图片或其他文件
- ✅ v1.7：一天多条纯文字随记、生活时间线、本机草稿、筛选/统一搜索、月报本月记忆
- ✅ v1.8：账户归属流水、转账、期初余额＋流水＋校准、账单还款提示、分类预算
- ✅ v1.9：今日统一待处理与置顶、每周复盘、最近分类/账户/标签，CI 自动语法检查、全量测试与依赖审计
- ✅ v2.0：今日主视觉与自定义导航、DeepSeek v4-flash 服务端轻提醒、月报 AI 一句话、数据库密钥密文存储和用户级洞察缓存
- ✅ v2.1：正式发布收口：用户协议/隐私政策/第三方说明入口、AI 明确同意、会话哈希、手机号最小化存储、生产端口与迁移权限收紧、备份校验和发布闸门；新增雾林、暖纸、月白、暮紫四套可同步主题
- ✅ 后端：Docker MySQL、用户隔离、微信登录、手机号授权换取、同步协议、云端 JSON 导出、接口限流与字段白名单
- 说明：小程序与资料库网页版目前是两套数据；等网页版切到本后端后即彻底打通
