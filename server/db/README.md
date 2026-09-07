# 数据库迁移与复制

项目默认 MySQL 数据库名为 `life_workbench`。业务数据位于 `records.data` JSON 中，当前有 `money`、`habit`、`plan`、`fitness`、`shopping`、`media`、`accounts`、`settings`、`memories` 九个同步集合；资料、会话、提醒、加密密钥和 AI 缓存分别在独立表中。

## 空库直接导入

如果服务器还没有创建数据库，可以使用同目录下的 [life_workbench_init.sql](life_workbench_init.sql)。它会创建 `life_workbench` 数据库和当前完整表结构，但不会导入本地演示数据、用户资料、会话或密钥：

```bash
mysql -u root -p < life_workbench_init.sql
```

如果数据库管理工具已经让你选中了目标库，也可以先执行脚本中的 `CREATE DATABASE` 和 `USE`；不要把应用密码、微信 Secret 或 AI API Key 写入这个文件。

## 本地 Docker 开发

本地 Docker 容器通常映射到 `127.0.0.1:13306`。开发环境的 `.env.example` 默认允许自动建库和迁移：

```bash
cd server
cp .env.example .env
# 在 .env 中填写 DB_PASSWORD
npm install
npm run db:migrate
npm start
```

## 正式服务器首次迁移

常驻服务不应拥有 `CREATE`、`ALTER`、`DROP` 权限。先按 [mysql-production-init.sql.example](../deploy/mysql-production-init.sql.example) 创建数据库与低权限 `life_sync` 账号，再临时使用受控迁移账号执行：

```bash
cd /opt/life-sync-server
# .env 中临时使用迁移账号，或通过安全的环境变量注入其密码
DB_AUTO_CREATE=0 DB_RUN_MIGRATIONS=1 npm run db:migrate
```

验证完成后，恢复生产 `.env`：

```ini
DB_USER=life_sync
DB_AUTO_CREATE=0
DB_RUN_MIGRATIONS=0
```

服务启动时会校验必要表和会话列版本；若 schema 未迁移会安全退出，而不是让运行账号自行执行 DDL。

## 复制到服务器

在本地导出：

```bash
mysqldump -h 127.0.0.1 -P 13306 -u "$DB_USER" -p \
  --single-transaction --skip-lock-tables --no-tablespaces --default-character-set=utf8mb4 \
  "$DB_NAME" | gzip -c > life_workbench.sql.gz
```

传输时使用受控通道；不要把备份上传到公开网盘、Git 仓库或审核材料。导入到隔离环境验证后，再导入正式库：

```bash
gzip -dc life_workbench.sql.gz | mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p \
  --default-character-set=utf8mb4 "$DB_NAME"
```

若复制了 `app_secrets` 中的 AI 密文，目标服务器必须使用同一个 `AI_SECRET_ENCRYPTION_KEY`；否则请在目标服务器重新通过 `npm run secret:set` 写入密钥。原始 API Key 不要放在 SQL 导出、环境示例或源代码中。
