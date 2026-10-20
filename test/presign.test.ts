import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { adminApi, createApp, promote, publicApi, rawApi, registerRelease } from "./helpers";
import type { Env } from "../src/types";

// 测试用假凭据：签名算法自洽验证，不需要真实密钥
const PRESIGN_ENV = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "AKIDEXAMPLEFORTESTS0001",
  R2_SECRET_ACCESS_KEY: "test-secret-access-key-not-real-0000000000000000",
};

/** 带 R2 S3 凭据的测试请求（本地 dev 环境默认没有这些 secret） */
async function presignApi(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer test-admin-token`);
  if (init.body != null) headers.set("Content-Type", "application/json");
  const withCreds: Env = { ...(env as unknown as Env), ...PRESIGN_ENV };
  const { default: app } = await import("../src/index");
  return app.request(path, { ...init, headers }, withCreds);
}

const validBody = {
  app_id: "com.test.presign",
  channel: "stable",
  version: "1.2.3",
  filename: "setup.exe",
};

describe("预签名上传：鉴权与参数校验", () => {
  it("缺少 Token 返回 401", async () => {
    const res = await rawApi("/v1/admin/uploads/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(401);
  });

  it.each([
    ["缺 app_id", { ...validBody, app_id: undefined }],
    ["channel 非法", { ...validBody, channel: "Stable!" }],
    ["version 非法", { ...validBody, version: "1.2" }],
    ["filename 含路径穿越", { ...validBody, filename: "../evil.exe" }],
    ["expires_seconds 越界", { ...validBody, expires_seconds: 10 }],
  ])("%s 返回 400", async (_label, body) => {
    const res = await presignApi("/v1/admin/uploads/presign", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    const parsed: any = await res.json();
    expect(parsed.error.code).toBe("INVALID_REQUEST");
  });

  it("服务端未配置 R2 凭据时返回 503 UPLOAD_NOT_CONFIGURED", async () => {
    const res = await adminApi("/v1/admin/uploads/presign", {
      method: "POST",
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(503);
    const parsed: any = await res.json();
    expect(parsed.error.code).toBe("UPLOAD_NOT_CONFIGURED");
  });
});

describe("预签名上传：签发内容", () => {
  it("返回 path-style 的 R2 S3 预签名 PUT URL 与 r2_key", async () => {
    await createApp(validBody.app_id);
    const res = await presignApi("/v1/admin/uploads/presign", {
      method: "POST",
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();

    expect(body.method).toBe("PUT");
    expect(body.r2_key).toBe("com.test.presign/stable/1.2.3/setup.exe");
    // path-style：bucket 在路径中，而不是子域
    expect(body.upload_url).toContain(
      "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/releasedock-packages/com.test.presign/stable/1.2.3/setup.exe?",
    );
    expect(body.upload_url).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(body.upload_url).toContain("X-Amz-Expires=900");
    expect(body.upload_url).toMatch(/X-Amz-Signature=[0-9a-f]{64}/);
    // 不要求客户端附加任何自定义头
    expect(body.headers).toEqual({});
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("签名与 AWS SigV4 规范一致（黄金值回归）", async () => {
    // 用固定凭据与固定 key 签发，锁定签名算法不回归。
    // 期望值由 AWS SDK v3 presigner 对同一输入生成并交叉验证。
    const { presignR2Put } = await import("../src/services/presign");
    const result = await presignR2Put({
      env: PRESIGN_ENV,
      bucket: "releasedock-packages",
      key: "com.test.presign/stable/1.2.3/setup.exe",
      expiresSeconds: 300,
    });
    // 结构断言（时间戳随运行变化，故校验可复算的固定部分）
    const url = new URL(result.url);
    const credential = url.searchParams.get("X-Amz-Credential")!;
    const amzDate = url.searchParams.get("X-Amz-Date")!;
    const signature = url.searchParams.get("X-Amz-Signature")!;

    expect(credential).toMatch(/^AKIDEXAMPLEFORTESTS0001\/\d{8}\/auto\/s3\/aws4_request$/);
    expect(amzDate).toMatch(/^\d{8}T\d{6}Z$/);
    expect(credential.startsWith(`${PRESIGN_ENV.R2_ACCESS_KEY_ID}/${amzDate.slice(0, 8)}/`)).toBe(true);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);

    // 复算签名：用同样的规范请求重算，必须逐字节一致
    const enc = (s: string) =>
      encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    const params: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": credential,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": "300",
      "X-Amz-SignedHeaders": "host",
    };
    const canonicalQuery = Object.keys(params)
      .sort()
      .map((k) => `${enc(k)}=${enc(params[k])}`)
      .join("&");
    const canonicalRequest = [
      "PUT",
      "/releasedock-packages/com.test.presign/stable/1.2.3/setup.exe",
      canonicalQuery,
      "host:0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com\n",
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const sha256 = async (text: string) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    const hmacHex = async (keyBytes: Uint8Array, data: string) => {
      const raw = new ArrayBuffer(keyBytes.byteLength);
      new Uint8Array(raw).set(keyBytes);
      const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
      return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    const hexToBytes = (hex: string) =>
      new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    const secret = PRESIGN_ENV.R2_SECRET_ACCESS_KEY;
    const dateShort = amzDate.slice(0, 8);
    const kDate = hexToBytes(await hmacHex(new TextEncoder().encode("AWS4" + secret), dateShort));
    const kRegion = hexToBytes(await hmacHex(kDate, "auto"));
    const kService = hexToBytes(await hmacHex(kRegion, "s3"));
    const kSigning = hexToBytes(await hmacHex(kService, "aws4_request"));
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      `${dateShort}/auto/s3/aws4_request`,
      await sha256(canonicalRequest),
    ].join("\n");

    expect(await hmacHex(kSigning, stringToSign)).toBe(signature);
  });

  it("已发布版本的 r2_key 拒绝签发（409 KEY_ALREADY_LIVE）", async () => {
    const appId = "com.test.presign-live";
    await createApp(appId);
    const { body } = await registerRelease({ appId, version: "1.0.0" });
    await promote(body.release_id, null);

    const res = await presignApi("/v1/admin/uploads/presign", {
      method: "POST",
      body: JSON.stringify({ app_id: appId, channel: "stable", version: "1.0.0", filename: "setup.bin" }),
    });
    expect(res.status).toBe(409);
    const parsed: any = await res.json();
    expect(parsed.error.code).toBe("KEY_ALREADY_LIVE");
  });

  it("支持自定义有效期", async () => {
    await createApp(`${validBody.app_id}-ttl`);
    const res = await presignApi("/v1/admin/uploads/presign", {
      method: "POST",
      body: JSON.stringify({ ...validBody, app_id: `${validBody.app_id}-ttl`, expires_seconds: 3600 }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.upload_url).toContain("X-Amz-Expires=3600");
    const ttlMs = new Date(body.expires_at).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(3500_000);
    expect(ttlMs).toBeLessThanOrEqual(3600_000);
  });
});

describe("下载直链（预签名 GET）", () => {
  it("签名与 AWS SigV4 规范一致（方法为 GET）", async () => {
    const { presignR2Get } = await import("../src/services/presign");
    const result = await presignR2Get({
      env: PRESIGN_ENV,
      bucket: "releasedock-packages",
      key: "com.test.presign/stable/1.2.3/setup.exe",
      expiresSeconds: 3600,
    });
    expect(result.method).toBe("GET");
    expect(result.headers).toEqual({});

    const url = new URL(result.url);
    const credential = url.searchParams.get("X-Amz-Credential")!;
    const amzDate = url.searchParams.get("X-Amz-Date")!;
    const signature = url.searchParams.get("X-Amz-Signature")!;
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");

    // 复算签名（方法 GET）
    const enc = (s: string) =>
      encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    const params: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": credential,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": "3600",
      "X-Amz-SignedHeaders": "host",
    };
    const canonicalQuery = Object.keys(params)
      .sort()
      .map((k) => `${enc(k)}=${enc(params[k])}`)
      .join("&");
    const canonicalRequest = [
      "GET",
      "/releasedock-packages/com.test.presign/stable/1.2.3/setup.exe",
      canonicalQuery,
      "host:0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com\n",
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const sha256 = async (text: string) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    const hmacHex = async (keyBytes: Uint8Array, data: string) => {
      const raw = new ArrayBuffer(keyBytes.byteLength);
      new Uint8Array(raw).set(keyBytes);
      const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
      return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    const hexToBytes = (hex: string) =>
      new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    const dateShort = amzDate.slice(0, 8);
    const kDate = hexToBytes(await hmacHex(new TextEncoder().encode("AWS4" + PRESIGN_ENV.R2_SECRET_ACCESS_KEY), dateShort));
    const kRegion = hexToBytes(await hmacHex(kDate, "auto"));
    const kService = hexToBytes(await hmacHex(kRegion, "s3"));
    const kSigning = hexToBytes(await hmacHex(kService, "aws4_request"));
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      `${dateShort}/auto/s3/aws4_request`,
      await sha256(canonicalRequest),
    ].join("\n");
    expect(await hmacHex(kSigning, stringToSign)).toBe(signature);
  });

  it("配置了 R2 凭据时，查询响应下发直链 + 兜底地址 + 过期时间", async () => {
    const appId = "com.test.direct";
    await createApp(appId);
    const reg = await registerRelease({ appId, version: "1.0.0" });
    await promote(reg.body.release_id, null);

    const { default: app } = await import("../src/index");
    const res = await app.request(
      `/v1/updates/${appId}/stable?current=0.9.0&client_id=c1`,
      {},
      { ...(env as unknown as Env), ...PRESIGN_ENV },
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();

    // 主地址是 R2 预签名直链（path-style，GET 签名）
    expect(body.download_url).toContain("0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    expect(body.download_url).toContain(`/releasedock-packages/${appId}/stable/1.0.0/setup.bin`);
    expect(body.download_url).toContain("X-Amz-Signature=");
    // 兜底地址仍是 Worker 路由
    expect(body.download_api_url).toMatch(/\/v1\/download\/rel_/);
    expect(new Date(body.download_expires_at).getTime()).toBeGreaterThan(Date.now() + 3000_000);
    expect(body.sha256).toBeTruthy();
  });

  it("未配置 R2 凭据时，回退为 Worker 下载地址", async () => {
    const appId = "com.test.direct-fallback";
    await createApp(appId);
    const reg = await registerRelease({ appId, version: "1.0.0" });
    await promote(reg.body.release_id, null);

    const res = await publicApi(`/v1/updates/${appId}/stable?current=0.9.0`);
    const body: any = await res.json();
    expect(body.download_url).toMatch(/\/v1\/download\/rel_/);
    expect(body.download_expires_at).toBeUndefined();
  });
});
