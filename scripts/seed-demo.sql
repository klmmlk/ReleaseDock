-- 本地演示数据：只建应用与通道，不直接插版本记录。
-- 版本登记/上线请走管理 API，保证校验与审计一致。
-- 用法：npx wrangler d1 execute releasedock --local --file scripts/seed-demo.sql

INSERT INTO apps (app_id, name, status, created_at, updated_at)
VALUES (
  'com.example.demo',
  '演示应用',
  'active',
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
);

INSERT INTO app_channels (app_id, channel, current_release_id, min_supported_version, updated_at)
VALUES ('com.example.demo', 'stable', NULL, '0.0.0', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
       ('com.example.demo', 'beta', NULL, '0.0.0', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
