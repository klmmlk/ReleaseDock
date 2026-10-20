-- ReleaseDock 初始表结构
-- 时间戳统一由应用层写入 ISO 8601 UTC 字符串，数据库不设默认值，保证格式一致。

CREATE TABLE apps (
  app_id     TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE releases (
  id          TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL REFERENCES apps (app_id),
  channel     TEXT NOT NULL,
  version     TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  changelog   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'archived')),
  rollout     INTEGER NOT NULL DEFAULT 100 CHECK (rollout BETWEEN 0 AND 100),
  created_at  TEXT NOT NULL,
  promoted_at TEXT,
  created_by  TEXT,
  UNIQUE (app_id, channel, version)
);

CREATE INDEX idx_releases_lookup ON releases (app_id, channel, status);

CREATE TABLE app_channels (
  app_id                TEXT NOT NULL REFERENCES apps (app_id),
  channel               TEXT NOT NULL,
  current_release_id    TEXT REFERENCES releases (id),
  min_supported_version TEXT NOT NULL DEFAULT '0.0.0',
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (app_id, channel)
);

CREATE TABLE audit_logs (
  id         TEXT PRIMARY KEY,
  action     TEXT NOT NULL,
  app_id     TEXT,
  channel    TEXT,
  release_id TEXT,
  operator   TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL
);
