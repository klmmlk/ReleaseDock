import { createMiddleware } from "hono/factory";
import type { Env } from "../types";
import { Errors } from "../errors";

/** 管理接口鉴权：校验 Authorization: Bearer <ADMIN_TOKEN> */
export const adminAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  const provided = match?.[1] ?? "";
  const expected = c.env.ADMIN_TOKEN ?? "";

  if (expected.length === 0 || !timingSafeEqualBytes(encodeUtf8(provided), encodeUtf8(expected))) {
    throw Errors.unauthorized();
  }
  await next();
  c.res.headers.set("Cache-Control", "no-store");
});

function encodeUtf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

/** 常量时间比较，避免通过响应耗时猜测 Token */
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
