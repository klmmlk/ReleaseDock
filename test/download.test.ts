import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createApp, publicApi, registerRelease } from "./helpers";
import { promote } from "./helpers";

const downloadUrl = (releaseId: string) => `/v1/download/${releaseId}`;

describe("文件下载", () => {
  it("live 版本可下载，内容与校验头正确", async () => {
    const appId = "com.test.dl-live";
    await createApp(appId);
    const { body, r2Key } = await registerRelease({ appId, version: "1.0.0" });
    await promote(body.release_id, null);

    const res = await publicApi(downloadUrl(body.release_id));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`content-of-${appId}-stable-1.0.0`);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(res.headers.get("X-Checksum-Sha256")).toBeTruthy();
    expect(res.headers.get("Content-Disposition")).toContain("setup.bin");
    expect(r2Key).toBeTruthy();
  });

  it("draft 版本返回 404 且不泄露存在性", async () => {
    const appId = "com.test.dl-draft";
    await createApp(appId);
    const { body } = await registerRelease({ appId, version: "1.0.0" });
    const res = await publicApi(downloadUrl(body.release_id));
    expect(res.status).toBe(404);
    const errBody: any = await res.json();
    expect(errBody.error.code).toBe("RELEASE_NOT_FOUND");
  });

  it("archived 版本仍可下载（支持回滚后旧客户端）", async () => {
    const appId = "com.test.dl-arch";
    await createApp(appId);
    const v1 = await registerRelease({ appId, version: "1.0.0" });
    const v2 = await registerRelease({ appId, version: "1.1.0" });
    await promote(v1.body.release_id, null);
    await promote(v2.body.release_id, v1.body.release_id);

    const res = await publicApi(downloadUrl(v1.body.release_id));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`content-of-${appId}-stable-1.0.0`);
  });

  it("release_id 不存在返回 404", async () => {
    const res = await publicApi(downloadUrl("rel_missing"));
    expect(res.status).toBe(404);
    const errBody: any = await res.json();
    expect(errBody.error.code).toBe("RELEASE_NOT_FOUND");
  });

  it("记录存在但 R2 文件缺失返回 R2_OBJECT_NOT_FOUND", async () => {
    const appId = "com.test.dl-nor2";
    await createApp(appId);
    const { body } = await registerRelease({ appId, version: "1.0.0", uploadFile: false });
    // 绕过上线校验，直接把状态置为 live，模拟“文件被误删”的场景
    await env.DB.prepare("UPDATE releases SET status = 'live', promoted_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), body.release_id)
      .run();

    const res = await publicApi(downloadUrl(body.release_id));
    expect(res.status).toBe(404);
    const errBody: any = await res.json();
    expect(errBody.error.code).toBe("R2_OBJECT_NOT_FOUND");
  });
});
