export type AppStatus = "active" | "disabled";
export type ReleaseStatus = "draft" | "live" | "archived";

export interface Env {
  /** D1 数据库绑定 */
  DB: D1Database;
  /** R2 存储桶绑定，存放更新包 */
  BUCKET: R2Bucket;
  /** 管理接口 Bearer Token（wrangler secret / .dev.vars） */
  ADMIN_TOKEN: string;
  /** Analytics Engine 数据集，基础监控（本地/测试缺省时可缺失） */
  METRICS?: AnalyticsEngineDataset;
  /** 速率限制绑定：查询接口 120 次/分（beta 绑定，未配置时跳过限流） */
  RATE_LIMIT_UPDATES?: RateLimit;
  /** 速率限制绑定：下载接口 30 次/分（beta 绑定，未配置时跳过限流） */
  RATE_LIMIT_DOWNLOAD?: RateLimit;
  /** R2 S3 凭据（管理 Token 控制上传发布，可选——未配置时上传接口返回 503） */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  /** 默认绑定的 R2 桶名（可省，路由代码会用 binding 名兜底） */
  R2_BUCKET_NAME?: string;
}

// ---------- D1 行类型 ----------

export interface AppRow {
  app_id: string;
  name: string;
  status: AppStatus;
  created_at: string;
  updated_at: string;
}

export interface ReleaseRow {
  id: string;
  app_id: string;
  channel: string;
  version: string;
  r2_key: string;
  sha256: string;
  size: number;
  /** JSON 序列化的 string[] */
  changelog: string;
  status: ReleaseStatus;
  rollout: number;
  created_at: string;
  promoted_at: string | null;
  created_by: string | null;
}

export interface AppChannelRow {
  app_id: string;
  channel: string;
  current_release_id: string | null;
  min_supported_version: string;
  updated_at: string;
}

// ---------- API DTO ----------

export interface ChangelogEntry {
  version: string;
  items: string[];
}

export interface UpdateResponse {
  app_id: string;
  channel: string;
  update_available: boolean;
  latest: string;
  current: string;
  mandatory: boolean;
  min_supported_version?: string;
  download_url?: string;
  /** 预签名直链过期时间；客户端若过期（R2 返回 403）应重新查询本接口 */
  download_expires_at?: string;
  /** Worker 兜底下载地址（直链不可用时使用，如预签名未配置或链接过期后重试） */
  download_api_url?: string;
  sha256?: string;
  size?: number;
  changelog?: ChangelogEntry[];
  changelog_truncated?: boolean;
  published_at?: string;
}

export interface CreateAppRequest {
  app_id: string;
  name: string;
}

export interface RegisterReleaseRequest {
  app_id: string;
  channel: string;
  version: string;
  r2_key: string;
  sha256: string;
  size: number;
  changelog: string[];
  rollout?: number;
  created_by?: string;
}

export interface PromoteRequest {
  /** 乐观并发控制：期望的当前指针；缺省视为“期望通道尚无生效版本”（首次上线） */
  expected_current_release_id?: string | null;
  reason?: string;
  operator?: string;
}
