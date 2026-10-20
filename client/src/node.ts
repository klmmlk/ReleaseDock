/**
 * Node.js 专用入口：流式下载到文件，边下边算哈希，校验失败自动删除临时文件。
 * 适合大体积安装包（不占用整包内存）。仅 Node 18+ / Electron 主进程可用。
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { once } from "node:events";
import { Readable } from "node:stream";
import { ChecksumMismatchError, UpdateError } from "./index.js";

export interface DownloadToFileOptions {
  /** 期望的十六进制 SHA-256（来自查询响应的 sha256 字段） */
  sha256: string;
  /** 保存路径，建议先下载到临时目录 */
  filePath: string;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface DownloadToFileResult {
  filePath: string;
  size: number;
  /** 校验通过的十六进制 SHA-256 */
  sha256: string;
}

export async function downloadToFile(
  url: string,
  options: DownloadToFileOptions,
): Promise<DownloadToFileResult> {
  const expected = options.sha256.toLowerCase();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new UpdateError("请求超时")),
    options.timeoutMs ?? 300000,
  );
  if (options.signal) {
    options.signal.addEventListener("abort", () => controller.abort(options.signal?.reason), {
      once: true,
    });
  }

  let res: Response;
  try {
    res = await (options.fetchImpl ?? fetch)(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw err instanceof UpdateError
      ? err
      : new UpdateError(`网络请求失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // 计时只覆盖响应头阶段；响应体 streaming 期间不设上限
    clearTimeout(timer);
  }

  if (!res.ok || !res.body) {
    throw new UpdateError(`下载失败（HTTP ${res.status}）`, res.status);
  }

  const total = Number(res.headers.get("Content-Length")) || 0;
  const hash = createHash("sha256");
  const out = createWriteStream(options.filePath);
  let loaded = 0;
  let cleanup = true;

  try {
    for await (const chunk of Readable.fromWeb(res.body as any)) {
      const bytes = chunk as Buffer;
      hash.update(bytes);
      loaded += bytes.byteLength;
      options.onProgress?.(loaded, total);
      if (!out.write(bytes)) {
        await once(out, "drain");
      }
    }
    out.end();
    await once(out, "finish");
    cleanup = false;
  } finally {
    out.destroy();
    if (cleanup) {
      await unlink(options.filePath).catch(() => {});
    }
  }

  const actual = hash.digest("hex");
  if (actual !== expected) {
    await unlink(options.filePath).catch(() => {});
    throw new ChecksumMismatchError(expected, actual);
  }
  return { filePath: options.filePath, size: loaded, sha256: actual };
}
