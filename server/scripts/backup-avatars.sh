#!/usr/bin/env bash
set -euo pipefail
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
backup_dir="$script_dir/../db/backups"
avatar_dir="${AVATAR_DIR:-${DATA_DIR:-$script_dir/../data}/avatars}"
retention_days="${BACKUP_RETENTION_DAYS:-30}"
[[ "$retention_days" =~ ^[0-9]+$ ]] && (( retention_days >= 7 && retention_days <= 365 ))
if [[ ! -d "$avatar_dir" ]]; then exit 0; fi
umask 077
mkdir -p "$backup_dir"
temporary="$(mktemp "$backup_dir/.avatars_XXXXXX.tar.gz")"
trap 'rm -f "$temporary"' EXIT
tar -czf "$temporary" --exclude='*.tmp' -C "$avatar_dir" .
gzip -t "$temporary"
mv "$temporary" "$backup_dir/avatars_$(date +%Y%m%d_%H%M%S).tar.gz"
find "$backup_dir" -maxdepth 1 -type f -name 'avatars_*.tar.gz' -mtime +"$retention_days" -delete
