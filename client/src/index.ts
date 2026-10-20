/**
 * ReleaseDock 客户端更新库（核心，纯 Web API 实现）。
 *
 * 职责边界（开发文档 8.5）：只负责查询、下载、SHA-256 校验与进度回调；
 * 不包含业务逻辑，安装阶段由各软件通过回调自行处理。
 */

export interface ChangelogEntry {
  version: string;
  items: string[];
}

export interface UpdateClientConfig {
  /** 服务地址，如 https://update.yourdomain.com */
  baseUrl: string;
  /** 应用标识，如 com.yourco.product-a */
  appId: string;
  /** 通道，默认 stable */
  channel?: string;
  /** 客户端当前版本，如 1.2.0 */
  currentVersion: string;
  /** 灰度分流标识，建议首次启动生成 UUID 并持久化 */
  clientId?: string;
  /** 是否返回 Changelog，默认 true */
  includeChangelog?: boolean;
  /** 查询与下载超时毫秒数，默认 15000 */
  timeoutMs?: number;
  /** 注入 fetch 实现（测试或特殊运行时用），默认全局 fetch */
  fetchImpl?: typeof fetch;
}

export interface UpdateInfo {
  updateAvailable: boolean;
  /** 低于服务端 min_supported_version 时为 true，客户端应强制更新 */
  mandatory: boolean;
  /** 服务端最新版本 */
  latest: string;
  current: string;
  changelog: ChangelogEntry[];
  changelogTruncated: boolean;
  /**
   * 下载并校验更新包。仅 updateAvailable 时存在。
   * 校验失败抛 ChecksumMismatchError，成功返回字节与已验证的 sha256。
   */
  download: ((options?: DownloadOptions) => Promise<DownloadResult>) | undefined;
}

export interface DownloadOptions {
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

export interface DownloadResult {
  bytes: Uint8Array;
  /** 校验通过的十六进制 SHA-256 */
  sha256: string;
}

export class UpdateError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "UpdateError";
  }
}

export class ChecksumMismatchError extends UpdateError {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`SHA-256 校验失败：期望 ${expected}，实际 ${actual}`, undefined, "CHECKSUM_MISMATCH");
    this.name = "ChecksumMismatchError";
  }
}

const DEFAULT_TIMEOUT_MS = 15000;
const HEX_DIGEST = /^[0-9a-f]{64}$/;

export async function checkForUpdate(config: UpdateClientConfig): Promise<UpdateInfo> {
  const channel = config.channel ?? "stable";
  const includeChangelog = config.includeChangelog ?? true;
  const query = new URLSearchParams({ current: config.currentVersion });
  if (config.clientId) query.set("client_id", config.clientId);
  if (!includeChangelog) query.set("include_changelog", "false");

  const body = await requestJson(
    `${config.baseUrl.replace(/\/$/, "")}/v1/updates/${config.appId}/${channel}?${query}`,
    config,
  );

  const downloadUrl = typeof body.download_url === "string" ? body.download_url : undefined;
  const sha256 = typeof body.sha256 === "string" ? body.sha256 : undefined;

  return {
    updateAvailable: body.update_available === true,
    mandatory: body.mandatory === true,
    latest: String(body.latest ?? config.currentVersion),
    current: String(body.current ?? config.currentVersion),
    changelog: Array.isArray(body.changelog) ? body.changelog : [],
    changelogTruncated: body.changelog_truncated === true,
    download:
      body.update_available === true && downloadUrl && sha256
        ? (options) =>
            downloadUpdate(
              downloadUrl,
              { sha256: sha256.toLowerCase(), fetchImpl: config.fetchImpl, timeoutMs: config.timeoutMs },
              options,
            )
        : undefined,
  };
}

// ---------- 内部实现 ----------

async function requestJson(url: string, config: UpdateClientConfig): Promise<any> {
  const res = await doFetch(url, {}, config.fetchImpl, config.timeoutMs).catch((err: unknown) => {
    throw toNetworkError(err);
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new UpdateError(`响应不是合法 JSON（HTTP ${res.status}）`, res.status);
  }
  if (!res.ok) {
    const err = (body as any)?.error;
    throw new UpdateError(err?.message ?? `查询失败（HTTP ${res.status}）`, res.status, err?.code);
  }
  return body;
}

async function downloadUpdate(
  url: string,
  expect: { sha256: string; fetchImpl?: typeof fetch; timeoutMs?: number },
  options?: DownloadOptions,
): Promise<DownloadResult> {
  const res = await doFetch(url, { signal: options?.signal }, expect.fetchImpl, expect.timeoutMs).catch(
    (err: unknown) => {
      throw toNetworkError(err);
    },
  );
  if (!res.ok || !res.body) {
    throw new UpdateError(`下载失败（HTTP ${res.status}）`, res.status);
  }

  const total = Number(res.headers.get("Content-Length")) || 0;
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      options?.onProgress?.(loaded, total);
    }
  }

  const bytes = mergeChunks(chunks, loaded);
  // 响应无 Content-Length（chunked 传输）时，最终以实际字节数补发一次进度
  if (total === 0 && loaded > 0) options?.onProgress?.(loaded, loaded);
  const actual = await toHex(await crypto.subtle.digest("SHA-256", bytes));
  if (!HEX_DIGEST.test(expect.sha256)) {
    throw new UpdateError("服务端返回的 sha256 格式非法", undefined, "INVALID_RESPONSE");
  }
  if (actual !== expect.sha256) {
    throw new ChecksumMismatchError(expect.sha256, actual);
  }
  return { bytes, sha256: actual };
}

async function doFetch(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch | undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new UpdateError("请求超时")), timeoutMs);
  const external = init.signal;
  if (external) external.addEventListener("abort", () => controller.abort(external.reason), { once: true });
  try {
    return await (fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function toNetworkError(err: unknown): UpdateError {
  if (err instanceof UpdateError) return err;
  return new UpdateError(`网络请求失败：${err instanceof Error ? err.message : String(err)}`);
}

function mergeChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function toHex(buffer: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
