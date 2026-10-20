import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { adminApi, createApp, promote, rawApi, registerRelease } from "./helpers";

describe("管理接口鉴权", () => {
  it("缺少 Token 返回 401", async () => {
    const res = await rawApi("/v1/admin/apps", { method: "POST" });
    expect(res.status).toBe(401);
    const body: any = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("错误 Token 返回 401", async () => {
    const res = await rawApi("/v1/admin/apps", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });
});

describe("应用管理", () => {
  it("创建应用成功，重复创建返回 409", async () => {
    const first = await createApp("com.test.app-dup", "重复应用");
    expect(first.res.status).toBe(201);
    expect(first.body.app_id).toBe("com.test.app-dup");

    const again = await createApp("com.test.app-dup", "重复应用");
    expect(again.res.status).toBe(409);
    expect(again.body.error.code).toBe("APP_ALREADY_EXISTS");
  });

  it("app_id 格式非法返回 400", async () => {
    const res = await adminApi("/v1/admin/apps", {
      method: "POST",
      body: JSON.stringify({ app_id: "非法 id!", name: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("应用列表包含已创建的应用", async () => {
    await createApp("com.test.app-list", "列表应用");
    const res = await adminApi("/v1/admin/apps");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.apps.some((a: any) => a.app_id === "com.test.app-list")).toBe(true);
  });
});

describe("登记版本", () => {
  const appId = "com.test.register";

  it("登记成功返回 draft 状态", async () => {
    await createApp(appId);
    const { res, body } = await registerRelease({ appId, version: "1.0.0" });
    expect(res.status).toBe(201);
    expect(body.status).toBe("draft");
    expect(body.release_id).toMatch(/^rel_/);
  });

  it("同一 app+channel+version 重复登记返回 409", async () => {
    await createApp(`${appId}-dup2`);
    await registerRelease({ appId: `${appId}-dup2`, version: "1.0.0" });
    const { res, body } = await registerRelease({ appId: `${appId}-dup2`, version: "1.0.0" });
    expect(res.status).toBe(409);
    expect(body.error.code).toBe("VERSION_ALREADY_EXISTS");
  });

  it("应用不存在返回 404", async () => {
    const { res, body } = await registerRelease({
      appId: "com.test.no-such-app",
      version: "1.0.0",
    });
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("APP_NOT_FOUND");
  });

  it.each([
    ["sha256 格式非法", { sha256: "nothex" }],
    ["size 非法", { sizeOverride: 0 }],
    ["changelog 为空数组", { changelog: [] }],
    ["changelog 含非字符串", { changelog: [123] }],
  ])("%s 返回 400", async (_label, override: any) => {
    await createApp(`${appId}-bad`);
    const payload = {
      app_id: `${appId}-bad`,
      channel: "stable",
      version: "1.0.0",
      r2_key: "k/setup.bin",
      sha256: "a".repeat(64),
      size: 10,
      changelog: ["item"],
      ...override,
    };
    if (override.sizeOverride !== undefined) {
      payload.size = override.sizeOverride;
      delete payload.sizeOverride;
    }
    const res = await adminApi("/v1/admin/releases", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("版本号格式非法返回 400", async () => {
    await createApp(`${appId}-ver`);
    const { res } = await registerRelease({ appId: `${appId}-ver`, version: "not-a-version" });
    expect(res.status).toBe(400);
  });

  it("channel 命名非法返回 400", async () => {
    await createApp(`${appId}-ch`);
    const { res } = await registerRelease({ appId: `${appId}-ch`, channel: "Stable!", version: "1.0.0" });
    expect(res.status).toBe(400);
  });

  it("rollout 超出范围返回 400", async () => {
    await createApp(`${appId}-roll`);
    const { res } = await registerRelease({ appId: `${appId}-roll`, version: "1.0.0", rollout: 101 });
    expect(res.status).toBe(400);
  });
});

describe("上线版本", () => {
  const appId = "com.test.promote";

  it("首次上线：登记并按 expected=null 上线，旧版本归档", async () => {
    const id = `${appId}-first`;
    await createApp(id);
    const v1 = await registerRelease({ appId: id, version: "1.0.0" });
    const v2 = await registerRelease({ appId: id, version: "1.1.0" });

    const p1 = await promote(v1.body.release_id, null);
    expect(p1.status).toBe(200);
    const p1Body: any = await p1.json();
    expect(p1Body.current_release_id).toBe(v1.body.release_id);

    // 二次上线必须携带期望指针
    const p2Wrong = await promote(v2.body.release_id, null);
    expect(p2Wrong.status).toBe(409);
    const p2WrongBody: any = await p2Wrong.json();
    expect(p2WrongBody.error.code).toBe("POINTER_CONFLICT");

    const p2 = await promote(v2.body.release_id, v1.body.release_id);
    expect(p2.status).toBe(200);

    // 旧版本应变为 archived
    const list = await adminApi(`/v1/admin/releases?app_id=${id}&channel=stable`);
    const body: any = await list.json();
    const byId = Object.fromEntries(body.releases.map((r: any) => [r.id, r.status]));
    expect(byId[v1.body.release_id]).toBe("archived");
    expect(byId[v2.body.release_id]).toBe("live");
  });

  it("live 状态不可重复上线", async () => {
    const id = `${appId}-live`;
    await createApp(id);
    const { body } = await registerRelease({ appId: id, version: "1.0.0" });
    await promote(body.release_id, null);
    const res = await promote(body.release_id, body.release_id);
    expect(res.status).toBe(409);
    const errBody: any = await res.json();
    expect(errBody.error.code).toBe("RELEASE_NOT_PROMOTABLE");
  });

  it("R2 缺少更新包文件时拒绝上线", async () => {
    const id = `${appId}-nor2`;
    await createApp(id);
    const { body } = await registerRelease({ appId: id, version: "1.0.0", uploadFile: false });
    const res = await promote(body.release_id, null);
    expect(res.status).toBe(404);
    const errBody: any = await res.json();
    expect(errBody.error.code).toBe("R2_OBJECT_NOT_FOUND");
  });

  it("不存在的 release 返回 404", async () => {
    const res = await promote("rel_does_not_exist", null);
    expect(res.status).toBe(404);
  });
});

describe("版本列表", () => {
  const appId = "com.test.list";

  it("支持按 channel 与 status 过滤", async () => {
    await createApp(appId);
    const stable = await registerRelease({ appId, channel: "stable", version: "1.0.0" });
    const beta = await registerRelease({ appId, channel: "beta", version: "1.1.0" });

    const byChannel = await adminApi(`/v1/admin/releases?app_id=${appId}&channel=beta`);
    const byChannelBody: any = await byChannel.json();
    expect(byChannelBody.releases).toHaveLength(1);
    expect(byChannelBody.releases[0].id).toBe(beta.body.release_id);
    expect(byChannelBody.releases[0].changelog).toEqual(["变更条目 1.1.0"]);

    await promote(stable.body.release_id, null);
    const byStatus = await adminApi(`/v1/admin/releases?app_id=${appId}&status=live`);
    const byStatusBody: any = await byStatus.json();
    expect(byStatusBody.releases).toHaveLength(1);
    expect(byStatusBody.releases[0].version).toBe("1.0.0");
  });

  it("缺少 app_id 返回 400", async () => {
    const res = await adminApi("/v1/admin/releases");
    expect(res.status).toBe(400);
  });
});

describe("审计日志", () => {
  it("登记与上线都写入审计日志", async () => {
    const appId = "com.test.audit";
    await createApp(appId);
    const { body } = await registerRelease({ appId, version: "1.0.0" });
    await promote(body.release_id, null);

    const { results } = await env.DB.prepare(
      "SELECT action, app_id, release_id FROM audit_logs WHERE app_id = ? ORDER BY created_at ASC",
    )
      .bind(appId)
      .all();
    expect(results.map((r: any) => r.action)).toEqual(["register_release", "promote"]);
  });
});
