import { env } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import app from "../src/index";
import type { Env } from "../src/types";

export const ADMIN_TOKEN = "test-admin-token";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

/** 直接调用 Hono 应用，绕开 SELF 服务绑定通道，env 取自测试运行时绑定 */
const testEnv = env as unknown as Env;

export async function adminApi(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${ADMIN_TOKEN}`);
  if (init.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return app.request(path, { ...init, headers }, testEnv);
}

export async function publicApi(path: string): Promise<Response> {
  return app.request(path, {}, testEnv);
}

/** 指定来源 IP 的请求，用于限流相关测试 */
export async function publicApiFrom(ip: string, path: string): Promise<Response> {
  return app.request(path, { headers: { "CF-Connecting-IP": ip } }, testEnv);
}

/** 不带默认鉴权头的原始请求，用于测试 401 场景 */
export async function rawApi(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, init, testEnv);
}

export async function createApp(
  appId: string,
  name = "测试应用",
): Promise<{ res: Response; body: any }> {
  const res = await adminApi("/v1/admin/apps", {
    method: "POST",
    body: JSON.stringify({ app_id: appId, name }),
  });
  return { res, body: await res.json() };
}

export interface RegisterOptions {
  appId: string;
  channel?: string;
  version: string;
  changelog?: string[];
  rollout?: number;
  /** 默认 true：向 R2 写入对应对象 */
  uploadFile?: boolean;
}

export async function registerRelease(
  opts: RegisterOptions,
): Promise<{ res: Response; body: any; r2Key: string }> {
  const channel = opts.channel ?? "stable";
  const r2Key = `${opts.appId}/${channel}/${opts.version}/setup.bin`;
  if (opts.uploadFile !== false) {
    await env.BUCKET.put(r2Key, `content-of-${opts.appId}-${channel}-${opts.version}`);
  }
  const res = await adminApi("/v1/admin/releases", {
    method: "POST",
    body: JSON.stringify({
      app_id: opts.appId,
      channel,
      version: opts.version,
      r2_key: r2Key,
      sha256: "a".repeat(64),
      size: 1024,
      changelog: opts.changelog ?? [`变更条目 ${opts.version}`],
      ...(opts.rollout === undefined ? {} : { rollout: opts.rollout }),
    }),
  });
  return { res, body: await res.json(), r2Key };
}

/**
 * 上线一个版本。expected 传 undefined 表示期望通道无生效版本（首次上线）。
 * 每次上线前等待几毫秒，保证 promoted_at 时间戳可区分（灰度回退依赖该排序）。
 */
export async function promote(
  releaseId: string,
  expected?: string | null,
): Promise<Response> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  const body = expected === undefined ? {} : { expected_current_release_id: expected };
  return adminApi(`/v1/admin/releases/${releaseId}/promote`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** 建应用 + 依次登记并上线一组版本（按传入顺序提升） */
export async function seedPublishedReleases(
  appId: string,
  versions: string[],
  channel = "stable",
): Promise<string[]> {
  await createApp(appId);
  const ids: string[] = [];
  for (const version of versions) {
    const { body } = await registerRelease({ appId, channel, version });
    ids.push(body.release_id);
  }
  let previous: string | undefined;
  for (const id of ids) {
    const res = await promote(id, previous ?? null);
    if (res.status !== 200) throw new Error(`seed promote ${id} 失败: ${res.status}`);
    previous = id;
  }
  return ids;
}
