import { createMiddleware } from "hono/factory";
import type { Env } from "../types";
import { Errors } from "../errors";

/** 客户端来源 IP；本地/测试无 CF 头时退化为固定键 */
function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  return c.req.header("CF-Connecting-IP") ?? "unknown";
}

/** 查询接口限流：按 client_id（灰度标识）优先，其次 IP；绑定未配置时跳过 */
export const rateLimitUpdates = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const limiter = c.env.RATE_LIMIT_UPDATES;
  if (!limiter) return next();
  const key = c.req.query("client_id") || clientIp(c);
  const { success } = await limiter.limit({ key });
  if (!success) throw Errors.rateLimited();
  await next();
});

/** 下载接口限流：按 IP；绑定未配置时跳过 */
export const rateLimitDownload = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const limiter = c.env.RATE_LIMIT_DOWNLOAD;
  if (!limiter) return next();
  const { success } = await limiter.limit({ key: clientIp(c) });
  if (!success) throw Errors.rateLimited();
  await next();
});
