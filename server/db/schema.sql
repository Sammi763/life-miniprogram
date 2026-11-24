CREATE TABLE IF NOT EXISTS records (
  owner_id VARCHAR(191) NOT NULL,
  collection VARCHAR(32) NOT NULL,
  record_id VARCHAR(64) NOT NULL,
  data JSON NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  deleted_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
  -- v2.12 单调变更序号：每次成功写入 +1（owner 内），作为下载游标（客户端 sinceSeq）。
  -- 与客户端业务时间戳（updated_at）分离：晚到上传的旧时间戳不会漏拉、本机写入不推进游标。
  seq BIGINT UNSIGNED NOT NULL DEFAULT 0,
  seq_fingerprint BINARY(32) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, collection, record_id),
  INDEX idx_records_owner_updated (owner_id, updated_at),
  INDEX idx_records_owner_collection (owner_id, collection),
  INDEX idx_records_owner_seq (owner_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- v2.12 每 owner 变更序号头：事务内以 LAST_INSERT_ID(seq+1) 原子自增，多设备并发安全
CREATE TABLE IF NOT EXISTS owner_seq (
  owner_id VARCHAR(191) NOT NULL,
  seq BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token CHAR(64) NOT NULL,
  openid VARCHAR(191) NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (token),
  INDEX idx_sessions_expires (expires_at),
  INDEX idx_sessions_openid (openid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  owner_id VARCHAR(191) NOT NULL,
  nickname VARCHAR(64) NOT NULL DEFAULT '',
  phone VARCHAR(32) NOT NULL DEFAULT '',
  phone_updated_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS scheduled_reminders (
  id CHAR(40) NOT NULL,
  owner_id VARCHAR(191) NOT NULL,
  plan_id VARCHAR(64) NOT NULL,
  title VARCHAR(80) NOT NULL,
  due_at BIGINT UNSIGNED NOT NULL,
  status ENUM('pending', 'sent', 'failed', 'cancelled') NOT NULL DEFAULT 'pending',
  lock_token CHAR(48) NULL,
  locked_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
  sent_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
  failed_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
  cancelled_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(255) NOT NULL DEFAULT '',
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_reminders_owner_plan (owner_id, plan_id),
  INDEX idx_reminders_due (status, due_at, locked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_secrets (
  secret_name VARCHAR(64) NOT NULL,
  secret_value TEXT NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (secret_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_insights (
  owner_id VARCHAR(191) NOT NULL,
  insight_key VARCHAR(80) NOT NULL,
  context_hash CHAR(64) NOT NULL,
  content VARCHAR(500) NOT NULL,
  generated_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (owner_id, insight_key),
  INDEX idx_ai_insights_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reminder_credits (
  owner_id VARCHAR(191) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  credits INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (owner_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
