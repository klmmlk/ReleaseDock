# ReleaseDock API 契约参考

通用约定：全部 HTTPS；JSON 请求/响应（下载除外）；时间为 ISO 8601 UTC；客户端接口不要求登录；管理接口必须带 `Authorization: Bearer <ADMIN_TOKEN>` 且不缓存。

## 1. 版本查询（客户端）

```
GET /v1/updates/{app_id}/{channel}?current=<semver>&client_id=<uuid>&include_changelog=<true|false>
```

| 参数 | 必填 | 说明 |
| :--- | :--- | :--- |
| `current` | 是 | 客户端当前版本，语义化版本号 `X.Y.Z`（可带 `-prerelease`），格式非法返回 400 |
| `client_id` | 建议 | 持久化 UUID，用于灰度分流；缺失则永不进入灰度 |
| `include_changelog` | 可选 | 默认 `true`；`false` 时响应不含 `changelog` 字段 |

响应头：`Cache-Control: public, max-age=60`。

**有更新时**：

```json
{
  "app_id": "com.yourco.app",
  "channel": "stable",
  "update_available": true,
  "latest": "1.5.0",
  "current": "1.2.0",
  "mandatory": false,
  "min_supported_version": "1.0.0",
  "download_url": "https://…/v1/download/rel_abc123",
  "sha256": "<64位十六进制，小写>",
  "size": 12345678,
  "changelog": [
    { "version": "1.3.0", "items": ["修复登录超时问题", "优化启动速度"] },
    { "version": "1.5.0", "items": ["新增离线模式"] }
  ],
  "changelog_truncated": true,
  "published_at": "2026-10-20T08:00:00.000Z"
}
```

**无更新时**只返回 `app_id / channel / update_available=false / latest / current / mandatory`。

规则要点：

- `mandatory = current < min_supported_version`，与是否有更新独立计算。
- `changelog` 为从 `current` 之后到最新版本的已发布版本（升序，最多 5 个）；超过 5 个置 `changelog_truncated=true`；`current` 不是已知已发布版本时只返回最新版一条。
- 灰度：服务端对 `client_id` 做 SHA-256 稳定哈希 mod 100，小于当前版本 `rollout` 的可见；未命中的客户端按"上一个已发布版本"作为有效最新版，表现为无更新。客户端无需感知。

## 2. 文件下载（客户端）

### 2.1 预签名直链（默认，`download_url`）

查询响应的 `download_url` 是 R2 S3 的 **AWS SigV4 预签名 GET URL**（path-style，默认有效期 1 小时）：

- 直接 GET，**不要附加任何自定义头**（`host` 由 HTTP 客户端自动处理）。
- 不经过本服务：由 R2 直接返回文件，**支持 Range 请求**（可断点续传）。
- 响应头由 R2 提供：`Content-Length`、`Content-Type: application/octet-stream`、`ETag`、`Last-Modified`、`Accept-Ranges: bytes`。
  **没有** `X-Checksum-Sha256` —— 校验用查询响应 JSON 里的 `sha256` 字段。
- 过期后返回 403 `Request has expired` → 重新查询 `/v1/updates/...` 换新链接；不要把直链长期缓存。
- 浏览器 / Electron 渲染进程跨域直连需要在 R2 桶上配置 CORS；桌面进程无此限制。

### 2.2 Worker 兜底（`download_api_url`）

```
GET {base_url}/v1/download/{release_id}
```

- 始终可用；未配置 R2 S3 凭据时它就是 `download_url`。
- 仅 `live` / `archived` 可下载；`draft` 与不存在的记录统一返回 404 `RELEASE_NOT_FOUND`。
- Worker 流式转发 R2 内容。响应头：`Content-Length`、`Content-Type: application/octet-stream`、`ETag`、`X-Checksum-Sha256`（与 JSON 的 `sha256` 一致）、`Content-Disposition: attachment; filename="…"`、`Cache-Control: public, max-age=31536000, immutable`。
- **不支持 Range**（恒 200 全量）。
- 记录存在但 R2 文件缺失返回 404 `R2_OBJECT_NOT_FOUND`。
- 下载限流 30 次/分（按 IP），超限 429 `RATE_LIMITED`。

### 2.3 查询响应中的下载字段

| 字段 | 说明 |
| :--- | :--- |
| `download_url` | 主下载地址：有 R2 凭据时为预签名直链，否则为 Worker 地址 |
| `download_expires_at` | 直链过期时间（ISO 8601）；Worker 地址时缺省 |
| `download_api_url` | Worker 兜底地址，始终返回 |
| `sha256` / `size` | 文件校验值与字节数，下载后必须比对 |

## 3. 管理接口（发布方，均需 Bearer Token，`Cache-Control: no-store`）

| 方法与路径 | 请求体 | 说明 |
| :--- | :--- | :--- |
| `POST /v1/admin/apps` | `{"app_id","name"}` | 创建应用；`app_id` 须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`；重复 409 `APP_ALREADY_EXISTS` |
| `GET /v1/admin/apps` | — | 应用列表 |
| `POST /v1/admin/uploads/presign` | `{"app_id","channel","version","filename","expires_seconds"?}` | 签发 R2 预签名 PUT URL（默认 15 分钟，60–86400 秒），返回 `upload_url/method/headers/r2_key/expires_at`。客户端对 `upload_url` 直接 PUT，**不要附加任何自定义头**；对象键固定为 `{app_id}/{channel}/{version}/{filename}`；已被 live/archived 占用的键返回 409 `KEY_ALREADY_LIVE`；服务端未配置 R2 凭据返回 503 `UPLOAD_NOT_CONFIGURED` |
| `POST /v1/admin/releases` | 见下 | 登记 draft 版本 |
| `POST /v1/admin/releases/{id}/promote` | `{"expected_current_release_id": <string\|null>, "reason"?, "operator"?}` | 上线；expected 缺省/null = 期望通道无生效版本（仅首次上线）；指针不符 409 `POINTER_CONFLICT`；已是 live 409 `RELEASE_NOT_PROMOTABLE` |
| `POST /v1/admin/releases/{id}/rollback` | `{"expected_current_release_id": <必填>, "reason"?}` | 回滚到该版本；目标不能是 draft |
| `PATCH /v1/admin/releases/{id}` | `{"rollout": 0-100, "operator"?}` | 调整灰度比例，随时生效 |
| `PATCH /v1/admin/apps/{app_id}/channels/{channel}` | `{"min_supported_version": "<semver>"}` | 强制更新阈值 |
| `GET /v1/admin/releases?app_id=&channel=&status=&limit=&offset=` | — | 版本列表（status ∈ draft/live/archived） |

**登记请求体**：

```json
{
  "app_id": "com.yourco.app",
  "channel": "stable",
  "version": "1.5.0",
  "r2_key": "com.yourco.app/stable/1.5.0/setup.exe",
  "sha256": "64位十六进制",
  "size": 12345678,
  "changelog": ["1-50 条非空字符串，每条 ≤500 字符"],
  "rollout": 100,
  "created_by": "ci"
}
```

约束：同 `app_id+channel+version` 唯一（409 `VERSION_ALREADY_EXISTS`）；`channel` 匹配 `^[a-z0-9][a-z0-9_-]{0,31}$`；`r2_key` 不以 `/` 开头；`size` 为正整数；应用须存在且 `active`。上线/回滚前服务端会校验 R2 对象存在，缺失返回 404 `R2_OBJECT_NOT_FOUND`。

R2 对象键约定：`{app_id}/{channel}/{version}/{filename}`；文件一经上线不要覆盖同键（上传预签名与登记接口都会拒绝）。

## 4. 错误格式与错误码

```json
{ "error": { "code": "RELEASE_NOT_FOUND", "message": "版本记录不存在" } }
```

| HTTP | code | 场景 |
| :--- | :--- | :--- |
| 400 | `INVALID_REQUEST` | 参数缺失/格式错误 |
| 401 | `UNAUTHORIZED` | 管理 Token 缺失或错误 |
| 403 | `FORBIDDEN` | 应用已停用等 |
| 404 | `APP_NOT_FOUND` / `CHANNEL_NOT_FOUND` / `RELEASE_NOT_FOUND` / `R2_OBJECT_NOT_FOUND` | 资源不存在 |
| 409 | `VERSION_ALREADY_EXISTS` / `POINTER_CONFLICT` / `RELEASE_NOT_PROMOTABLE` / `APP_ALREADY_EXISTS` / `KEY_ALREADY_LIVE` | 冲突与状态不允许 |
| 503 | `UPLOAD_NOT_CONFIGURED` | 服务端未配置 R2 S3 凭据，无法签发上传链接（改用 wrangler/S3 工具上传） |
| 429 | `RATE_LIMITED` | 超过限流，应退避 |
| 500 | `INTERNAL_ERROR` | 服务端错误 |

## 5. 审计

`register_release` / `promote` / `rollback` / `update_min_version` / `update_rollout` 全部写入审计日志（含操作者、原因、指针前后值），供发布方事后追溯。
