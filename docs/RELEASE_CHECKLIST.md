# 生活记忆 life · 正式发布检查表

项目已经预留域名、HTTPS、数据库迁移、备份和审核所需结构；目前未绑定域名/IP，因此不能将以下人工项视为已完成。执行完本清单后再提交微信审核。

## 1. 先补齐不可由代码代填的信息

- [ ] 确定运营主体名称、联系邮箱、个人信息保护联系方式、生效日期；替换 `miniprogram/pages/legal/legal.js` 中全部 `【…】` 占位符。
- [ ] 确定实际调用的 DeepSeek 服务主体与隐私政策链接，替换第三方说明中的占位符。
- [ ] 确定域名、服务器地区、接入商和部署用户。若在中国大陆境内提供互联网信息服务，按实际主体和接入地完成适用的备案/变更流程；不要在未完成前开放正式服务。
- [ ] 在 `miniprogram/config/runtime.js` 填入唯一正式 `https://api.你的域名`；不要使用 IP、端口、HTTP、`localhost` 或示例域名。

## 2. 生产基础设施

- [ ] 从 `server/.env.production.example` 创建仅服务器可读的 `.env`，设置 `DEV_MODE=0`、`BIND_HOST=127.0.0.1`、`REQUIRE_HTTPS=1`、`HEALTH_DETAILS=0`。
- [ ] 配置正式 `WX_APPID`、`WX_SECRET`、订阅模板 ID、独立随机 `AI_SECRET_ENCRYPTION_KEY`、数据库密码；这些值不得进入 Git、日志、截图或客服消息。
- [ ] 使用 [Caddyfile.example](../server/deploy/Caddyfile.example) 配置 HTTPS，先验证证书、`/api/health`、`/api/*` 和 `/ws`；Node 的 8787 端口只允许本机反代访问。
- [ ] 在微信后台配置 request/socket 合法域名以及业务域名（如后续实际使用）；不配置 IP 和本地地址。
- [ ] 使用 [mysql-production-init.sql.example](../server/deploy/mysql-production-init.sql.example) 创建低权限运行账号。由独立迁移账号执行 `npm run db:migrate`，生产服务保持 `DB_AUTO_CREATE=0` 和 `DB_RUN_MIGRATIONS=0`。
- [ ] 安装并启用 `life-sync.service`、`life-backup.service`、`life-backup.timer`；确认 `systemctl status` 和 `systemctl list-timers` 正常。

## 3. 数据安全与恢复

- [ ] 运行一次 `server/scripts/backup-mysql.sh`，确认输出的 `.sql.gz` 能通过 `gzip -t`。
- [ ] 在隔离空库做一次恢复演练：`gzip -dc backup.sql.gz | mysql ...`，核对记录数后销毁演练库。
- [ ] 确认备份目录权限仅限运维账号；默认 30 天保留策略符合实际运维安排。
- [ ] 确认账户删除会删除资料、记录、会话、提醒和 AI 缓存；导出接口只允许当前登录用户读取自己的记录。

## 4. 小程序审核与隐私

- [ ] 微信后台《用户隐私保护指引》逐项与 [PRIVACY.md](PRIVACY.md) 一致，并在体验版真机验证手机号与订阅消息的授权/拒绝路径。
- [ ] 小程序内可从登录页和「我的」页看到用户协议、隐私政策、第三方说明、JSON 导出和永久删除入口。
- [ ] 审核说明明确：这是手工记录工具；不读取真实银行/支付/征信数据，不含图片、文件或音频上传；个性化 AI 默认关闭且须用户主动开启。
- [ ] 审核账号可以完成登录并抵达所有核心页；正式/体验版不会写入开发演示数据。
- [ ] 上传前检查小程序名称、类目、简介、截图、客服联系方式和功能描述与实际产品一致，不把财务统计表述为投资、借贷或专业建议。

## 5. 自动检查与真机验收

- [ ] CI `Verify life miniprogram` 通过：语法检查、全量测试、依赖审计和源代码密钥扫描。
- [ ] 本地运行 `npm run security:scan --prefix server` 与 `npm run release:check --prefix server`；后者必须通过才允许上传正式版。
- [ ] 真机 HTTPS 登录、编辑昵称、手机号同意/拒绝、退出/重新登录、账户导出和账户删除。
- [ ] 新建未来一次性定时日程，验证订阅同意、到点跳转；拒绝订阅时日程仍保存。
- [ ] 断网新增记录后恢复网络，确认队列只同步一次；再验证历史月报、随记搜索和时间线。
- [ ] 开启 AI 后验证提示文案；关闭后确认不再请求 AI、缓存文案被清除且本机规则文案仍正常显示。
- [ ] 使用 `curl -fsS https://api.你的域名/api/health` 检查健康状态；生产响应不得泄漏数据库名、开发模式或密钥。

## 6. 发布与回滚

- [ ] 先小范围体验版验收，再提交审核；不要在审核中临时改变数据收集范围、域名或第三方 AI 行为。
- [ ] 记录当前可用版本、数据库迁移时间和备份文件名；保留上一版小程序代码和上一版服务端构建物。
- [ ] 若发布后异常：先将流量切回上一稳定服务端版本，必要时回退小程序版本；数据库只通过已演练的备份恢复，不使用破坏性 Git 命令覆盖用户数据。

此清单提高可发布性，但备案、平台审核和具体法律义务仍以主管部门、接入商和微信后台的实时要求为准。
