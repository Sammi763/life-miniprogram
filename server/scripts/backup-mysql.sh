#!/usr/bin/env bash
# 每日逻辑备份：脚本目录下 server/db/backups，保留最近 30 天。
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
backup_dir="$(CDPATH= cd -- "$script_dir/../db" && pwd)/backups"
mkdir -p "$backup_dir"
umask 077

db_host="${DB_HOST:-127.0.0.1}"
db_port="${DB_PORT:-3306}"
db_name="${DB_NAME:-life_workbench}"
db_user="${DB_USER:-root}"
retention_days="${BACKUP_RETENTION_DAYS:-30}"
if ! [[ "$retention_days" =~ ^[0-9]+$ ]] || (( retention_days < 7 || retention_days > 365 )); then
  echo "BACKUP_RETENTION_DAYS must be an integer between 7 and 365" >&2
  exit 2
fi
stamp="$(date +%Y%m%d_%H%M%S)"
target="$backup_dir/life_${db_name}_${stamp}.sql.gz"
temporary="$(mktemp "$backup_dir/.life_backup_XXXXXX.sql.gz")"
trap 'rm -f "$temporary"' EXIT

export MYSQL_PWD="${DB_PASSWORD:-}"
mysqldump --host="$db_host" --port="$db_port" --user="$db_user" \
  --single-transaction --skip-lock-tables --no-tablespaces --routines --events --set-gtid-purged=OFF "$db_name" | gzip -c > "$temporary"
gzip -t "$temporary"
mv "$temporary" "$target"
trap - EXIT

# 目录由脚本固定计算，删除范围仅限本项目的备份文件。
find "$backup_dir" -maxdepth 1 -type f -name 'life_*.sql.gz' -mtime +"$retention_days" -delete
echo "backup written: $target"
