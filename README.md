# 生活记忆 life — 微信小程序版（自建服务器方案）

小程序端 + Node.js 同步后端。开发环境使用 Docker MySQL，数据可通过 `mysqldump` 迁移到你自己的境内云服务器，小程序与未来网页版可共用同一后端。

当前代码为 **v2.10「设置信息架构收纳」**：日/周重复日程、单次订阅提醒、纯文字随记与时间线、私密周/月复盘、收入/支出/转账账本、资产/负债账户、分类预算、四套可同步切换的界面主题、账户数据删除和每日数据库备份均已实现；不接收图片、音频或其他文件，也不接入第三方金融数据。个性化 AI 默认关闭，只有用户主动开启后才会由服务端发送裁剪摘要生成文案；密钥不进入代码。v2.3 针对网络不稳定场景做了登录韧性收口：传输错误按 cronet 语义区分重置/拒绝/超时，登录最多 5 次尝试（退避约 8.2 秒），失败后可在登录页点「网络自检」判断服务端是否可达；主包体积由 1.4MB 降至约 0.65MB。v2.4 收口页面交互：离线重试有明确反馈、可点元素统一按压反馈、写入类操作防重复点击。v2.5 收口数据安全：本机缓存（单个 storage key 上限 1MB）超限前自动无损瘦身、写入失败在「我的」页可见并能一键重建、全局异常只在本机留痕且令牌打码。v2.6 补齐分享与渲染：12 个页面支持转发微信好友与分享到朋友圈，卡片只用固定中性文案并显式指定分享图，不把个人数据带出应用；随记时间线改为分批渲染加「加载更多」，不再一次性下发全部内容；`server/.env.production.example` 中误填的真实凭证已改回占位符。v2.7 依据微信开发者工具真机走查实测修掉三处存量布局缺陷：悬浮 tabBar 底部留白改为计入安全区（原先写死 190rpx，实测比导航条矮 2.3px，末卡片被压）、习惯卡片「管理」不再绝对定位到右上角（原先与打卡胶囊重叠 34×14px，且 `catchtap` 会吞掉该区域的打卡点击）、月度报告趋势日期不再被挤成两行。v2.8 修掉用户实测发现的「能打开弹层、能输入，却创建不了」与被服务端拒绝时无限重试造成的控制台刷屏：弹层底部原被悬浮导航整体压住（自定义 tabBar 与页面内容不在同一层叠上下文，z-index 无法逾越），改为弹层打开期间隐藏导航；写队列对 4xx 明确拒绝改为丢弃队首并在「我的」页给出可见原因与手动重试；金额显示统一为 `finance.formatMoney` 一处实现。v2.9 收口点击反馈与编译噪音：先用开发者工具把「不跟手」量化清楚——本地快照 8.7KB、落盘 1ms、页面 `render()` 2ms、`setData` 往返 5~10ms、`onShow` 6ms，迟钝并不在业务逻辑（`switchTab` 的 222ms 里业务代码只占约 16ms）；真实缺口是「点下去看不见反应」：157 个可点元素里 106 个没有 `hover-class`（微信 `view` 默认 `hover-class="none"`，`text` 组件完全不支持 `hover-class`，`button` 的默认按压态又被渐变背景盖住），而微信 `hover-stay-time` 默认 400ms、叠加 150ms 过渡后一次瞬时点击的按压态会持续约 550ms。现补齐 130 处按压反馈并把过渡压到 90ms；同时关闭开发者工具的「启用数据预拉取」——该开关打开而项目没有 `preloadRule` / 预拉取下载地址时，每次编译都会弹 `系统错误，错误码：6000100,unbind download url` 模态框，而该模态框会盖住模拟器、直接吞掉点击。v2.10 收纳「我的」页设置的信息架构：「数据与隐私」原先 10 行平铺且全部同一视觉权重，实测整卡 635px、占视口 84% 与整页 24%，其中既有全 App 唯一决定「数据出不出本机」的「个性化 AI 文案」开关，也有不可逆的「永久删除账户与数据」——前者藏着反而抬高隐私风险，后者与普通设置相邻则是真实误触风险。现按语义重排为一级三行（AI 开关 / 隐私与合规 / 数据管理）＋独立的「账号」卡（删除与退出），整卡 635px → 240px、整页 2624px → 2421px；合规三份文档合并为一行并复用 `pages/legal` 自带的三个 tab（不新增页面），四项低频运维收进底部弹层（`mine` 作为 Tab 页接入 `attachOverlayWatcher`，弹层打开时自动隐藏悬浮导航）。正式发布前仍须填入真实 HTTPS 域名、微信凭证、运营主体与联系信息，并执行 [发布检查表](docs/RELEASE_CHECKLIST.md)。

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
4. 编译运行：首次启动先进入登录页，阅读并同意协议后点击「微信登录并开始」；微信登录成功后即可继续，昵称可填写或留空跳过。每个当前小程序 AppID 下的微信账号对应独立数据空间。开发版可使用示例数据辅助调试，体验版和正式版会从干净的个人空间开始。服务端地址由 `runtime.js` 管理，用户页面不提供地址输入。
5. 真机预览：点「预览」扫码，手机上打开右上角「…→ 开发调试」开启调试模式即可访问本机 IP。

### 运行测试

仓库没有根 `package.json`，全部测试为自包含 Node 脚本，与 CI（`.github/workflows/ci.yml`）同款命令：

```bash
# 全量（与 CI 一致，任一失败即停止）
for f in $(find tests -name '*.test.js' | sort); do node "$f" || exit 1; done

# 单个测试
node tests/sync-rejection.test.js
```

CI 还会执行 `node --check` 全量语法检查、`node server/scripts/check-source-secrets.js` 密钥扫描和 `npm audit --prefix server`。发布前另需在已填好 `.env` 的环境执行 `npm run release:check --prefix server`。

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
2. **server/.env**：`DEV_MODE=0`，填 `WX_APPID`、`WX_SECRET`、`WX_REMINDER_TEMPLATE_ID`、独立 `AI_SECRET_ENCRYPTION_KEY`、服务器 DB 参数，并保持 `BIND_HOST=127.0.0.1`、`REQUIRE_HTTPS=1`、`DB_AUTO_CREATE=0`、`DB_RUN_MIGRATIONS=0`；使用下方 Caddy/nginx 反代模板时同时设 `TRUST_PROXY=1`，再重启服务。生产配置缺少 AppID、Secret 或提醒模板时，服务会拒绝启动。服务端以微信登录取得的 `openid` 隔离记录；资料接口拒绝新的手机号绑定请求并保留历史资料响应兼容性。
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
- ✅ v2.0：今日主视觉与自定义导航、DeepSeek V4.1 Flash（API 标识 `deepseek-flash`）服务端轻提醒、月报 AI 一句话、数据库密钥密文存储和用户级洞察缓存
- ✅ v2.1：正式发布收口：用户协议/隐私政策/第三方说明入口、AI 明确同意、会话哈希、手机号最小化存储、生产端口与迁移权限收紧、备份校验和发布闸门；新增雾林、暖纸、月白、暮紫四套可同步主题
- ✅ v2.2：体验版登录收口、手机号授权停用、受限网络重试与匿名登录诊断日志
- ✅ v2.3：登录韧性收口——传输错误按 cronet 语义分类（-101 重置 / -102 被拒绝 / -118 超时，符号名优先）、登录最多 5 次尝试约 8.2 秒退避、失败态只读「网络自检」与可执行指引、登录页展示构建版本、logo 由 887KB 压缩至 137KB（主包约 0.65MB）
- ✅ v2.4：页面交互收口——离线「重试」补加载态与成功/失败反馈、5 处悬浮按钮与各列表/设置行补按压反馈、底部弹层加高度上限与滚动、14 处写入与切换类操作防重复点击（计数型打卡不节流）
- ✅ v2.5：数据安全收口——本机缓存体量保护（单 key 上限 1MB，超限前无损瘦身、写失败可见可自救）、「我的」页展示缓存占用与「重建本机缓存」、全局异常本地留痕（令牌打码、不上报远端）
- ✅ v2.6：分享传播与渲染收口——12 个页面接入转发微信好友与分享到朋友圈（卡片文案静态化、显式指定包内分享图、不读取任何本机记录），「我的」页新增可见转发入口；随记时间线改为分批渲染（每批 60 条）+「加载更多」，此前是全部记录一次性 setData；补齐 search / review / shopping 三个页面的行为级测试；`server/.env.production.example` 中误填的真实凭证改回占位符
- ✅ v2.7：开发者工具真机走查修复——修复三处**存量**布局缺陷：① 悬浮 tabBar 底部留白写死 `190rpx`，未计入底部安全区，实测比导航条矮 2.3px（四页末卡片被压）；② 习惯卡片「管理」绝对定位到 `right:28rpx/top:20rpx`，与打卡胶囊重叠 34×14px 且 `catchtap` 吞掉该区域打卡点击；③ 月报「每日支出趋势」日期因绑定含空格 + 宽 54rpx 被挤成「23 / 日」两行。同时补上密钥扫描器盲区：`server/.env.example` 也被写进了真实凭证（AppSecret / 模板 ID / 库密码），而旧扫描器只匹配 `sk-` 与 `Bearer` 故两次都误报通过——现按「敏感键 + 非空值」判定，两个模板的敏感键已还原为空占位符。新增 `tests/layout-guards.test.js` 与 `tests/secret-scan.test.js` 固化上述不变式（均已做负向验证）
- ✅ v2.8：真机交互走查修复（用户实测反馈「能点开添加、能输入，但创建不了」+「控制台大量 422 报错」）——① **弹层被悬浮导航压住**：`.sheet`(z-index:10) 低于 `custom-tab-bar`(100)，「记一笔」的「保存」按钮实测落在 `[655,699]` 而 tabbar 占 `[653,753]`，按钮 100% 不可见；抬高 z-index 只能解决页面内的 `.fab`，截图证实自定义 tabBar 与页面内容不在同一层叠上下文，故改为**弹层打开期间整体隐藏悬浮导航**（`utils/tabbar.js` 包装 `setData` 自动感知所有含 Sheet 的开关，不依赖逐处手动通知）。② **被服务端拒绝的写入无限重试**：`sync.js` 的 `flush()` 严格 FIFO，旧实现对任何失败都「保留队首 + 15s 重试」，一条永久被拒的写入（实测 `PUT settings/app → 422 bad_settings`）会永久堵死整个队列并每 15 秒刷一次控制台，同时「待同步」永不归零；现改为 4xx（401/408/429 除外）**丢弃队首 + 记入可见状态**，并在「我的 → 数据状态」展示拒绝原因与「重试」入口。③ 金额显示统一到 `finance.formatMoney`（整数不带小数、小数去末尾 0），此前同屏并存 `¥89`/`¥54.5` 与 `¥143.50`/`¥8356.50` 三种写法；月报百分比也不再用 `toFixed(1)`（避免同屏 `0%` 与 `0.0%`）。新增 `tests/sync-rejection.test.js`、`tests/money-format.test.js`、`tests/strict-syntax.test.js`（均已做负向验证）
- ✅ v2.9：点击反馈与编译噪音收口——先量后判（本地快照 8.7KB / `setStorageSync` 1ms / `render()` 2ms / `setData` 往返 5~10ms / `onShow` 6ms；`switchTab` 的 222ms 里业务代码仅约 16ms），确认「不跟手」不来自业务逻辑；真实缺口是 157 个可点元素中 106 个没有 `hover-class`（`text` 组件不支持 `hover-class`、`button` 的默认 `button-hover` 被渐变背景盖住），且微信 `hover-stay-time` 默认 400ms 让按压态滞后约 550ms → 补齐 130 处按压反馈（59 个 `view`/`button` 补 `hover-class`、19 个 `text` 换 `view`、52 个补按压时长）、过渡 150ms→90ms；关闭「启用数据预拉取」消除每次编译必弹的 `6000100 unbind download url` 模态框（模态框会盖住模拟器吞掉点击）；新增 `tests/tap-feedback.test.js`（含 5 项负向验证）
- ✅ v2.10：「我的 → 数据与隐私」信息架构收纳——10 行同权重平铺（实测整卡 635px = 视口 84%、整页 24%、整页 3.5 屏）压成**一级三行**（个性化 AI 文案开关 / 隐私与合规 / 数据管理）＋独立「账号」卡（永久删除账户与数据、退出当前账号），整卡 **635px → 240px**、整页 **2624px → 2421px**；合规三份文档合并为一行、复用 `pages/legal` 自带的三个 tab（不新增页面）；「导出云端备份 / 复制本机备份 / 重建本机缓存 / 清理示例内容」收进底部弹层并在执行后自动收起；`mine` 作为 Tab 页接入 `attachOverlayWatcher`（实测弹层 bottom=753=windowHeight，未被悬浮导航压住）；新增 `tests/mine-settings.test.js` 钉住「一级三行」与「不可逆操作不得与普通设置同卡」两条不变量
- ✅ 后端：Docker MySQL、openid 用户隔离、微信登录、同步协议、云端 JSON 导出、接口限流与字段白名单
- 说明：小程序与资料库网页版目前是两套数据；等网页版切到本后端后即彻底打通
