import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  adminApi,
  createApp,
  promote,
  publicApi,
  publicApiFrom,
  registerRelease,
} from "./helpers";

async function queryJson(appId: string, query: string): Promise<any> {
  const res = await publicApi(`/v1/updates/${appId}/stable?${query}`);
  return res.json();
}

describe("回滚接口", () => {
  it("回滚到旧版本：指针移动、状态翻转、客户端可见回退", async () => {
    const appId = "com.test.rb";
    await createApp(appId);
    const v1 = await registerRelease({ appId, version: "1.0.0" });
    const v2 = await registerRelease({ appId, version: "1.1.0" });
    await promote(v1.body.release_id, null);
    await promote(v2.body.release_id, v1.body.release_id);

    const res = await adminApi(`/v1/admin/releases/${v1.body.release_id}/rollback`, {
      method: "POST",
      body: JSON.stringify({
        expected_current_release_id: v2.body.release_id,
        reason: "1.1.0 出现崩溃，回滚",
      }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.current_release_id).toBe(v1.body.release_id);

    // 已升级到 1.1.0 的客户端：服务端最新是 1.0.0，不应要求降级
    const qb = await queryJson(appId, "current=1.1.0");
    expect(qb.update_available).toBe(false);
    expect(qb.latest).toBe("1.0.0");

    const list = await adminApi(`/v1/admin/releases?app_id=${appId}`);
    const lb: any = await list.json();
    const byId = Object.fromEntries(lb.releases.map((r: any) => [r.id, r.status]));
    expect(byId[v1.body.release_id]).toBe("live");
    expect(byId[v2.body.release_id]).toBe("archived");
  });

  it("expected 指针不匹配返回 409", async () => {
    const appId = "com.test.rb-conflict";
    await createApp(appId);
    const v1 = await registerRelease({ appId, version: "1.0.0" });
    const v2 = await registerRelease({ appId, version: "1.1.0" });
    await promote(v1.body.release_id, null);
    await promote(v2.body.release_id, v1.body.release_id);

    const res = await adminApi(`/v1/admin/releases/${v1.body.release_id}/rollback`, {
      method: "POST",
      body: JSON.stringify({ expected_current_release_id: v1.body.release_id }),
    });
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.error.code).toBe("POINTER_CONFLICT");
  });

  it.each([
    ["缺少 expected_current_release_id", {}],
    ["回滚目标为 draft", { targetDraft: true }],
  ])("%s 返回 400", async (_label, opts: any) => {
    const appId = `com.test.rb-bad-${_label.length}`;
    await createApp(appId);
    const v1 = await registerRelease({ appId, version: "1.0.0" });
    await promote(v1.body.release_id, null);
    const v2 = await registerRelease({ appId, version: "1.1.0" });
    if (!opts.targetDraft) await promote(v2.body.release_id, v1.body.release_id);

    const target = opts.targetDraft ? v2.body.release_id : v1.body.release_id;
    const res = await adminApi(`/v1/admin/releases/${target}/rollback`, {
      method: "POST",
      body: JSON.stringify(opts.targetDraft ? { expected_current_release_id: v1.body.release_id } : {}),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("回滚动作写入审计日志", async () => {
    const appId = "com.test.rb-audit";
    await createApp(appId);
    const v1 = await registerRelease({ appId, version: "1.0.0" });
    const v2 = await registerRelease({ appId, version: "1.1.0" });
    await promote(v1.body.release_id, null);
    await promote(v2.body.release_id, v1.body.release_id);
    await adminApi(`/v1/admin/releases/${v1.body.release_id}/rollback`, {
      method: "POST",
      body: JSON.stringify({ expected_current_release_id: v2.body.release_id }),
    });

    const { results } = await env.DB.prepare(
      "SELECT action FROM audit_logs WHERE app_id = ? AND release_id = ? AND action = 'rollback'",
    )
      .bind(appId, v1.body.release_id)
      .all();
    expect(results).toHaveLength(1);
  });
});

describe("强制更新阈值接口", () => {
  it("设置阈值后低版本客户端 mandatory=true，达到阈值 mandatory=false", async () => {
    const appId = "com.test.msv";
    await createApp(appId);
    const v1 = await registerRelease({ appId, version: "1.0.0" });
    const v2 = await registerRelease({ appId, version: "1.1.0" });
    await promote(v1.body.release_id, null);
    await promote(v2.body.release_id, v1.body.release_id);

    const patch = await adminApi(`/v1/admin/apps/${appId}/channels/stable`, {
      method: "PATCH",
      body: JSON.stringify({ min_supported_version: "1.1.0" }),
    });
    expect(patch.status).toBe(200);

    const below = await queryJson(appId, "current=1.0.0");
    expect(below.mandatory).toBe(true);
    expect(below.update_available).toBe(true);

    const at = await queryJson(appId, "current=1.1.0");
    expect(at.mandatory).toBe(false);
  });

  it("阈值格式非法返回 400，通道不存在返回 404", async () => {
    const appId = "com.test.msv-bad";
    await createApp(appId);

    const bad = await adminApi(`/v1/admin/apps/${appId}/channels/stable`, {
      method: "PATCH",
      body: JSON.stringify({ min_supported_version: "abc" }),
    });
    expect(bad.status).toBe(400);

    const missing = await adminApi(`/v1/admin/apps/${appId}/channels/nightly`, {
      method: "PATCH",
      body: JSON.stringify({ min_supported_version: "1.0.0" }),
    });
    expect(missing.status).toBe(404);
    const body: any = await missing.json();
    expect(body.error.code).toBe("CHANNEL_NOT_FOUND");
  });
});

describe("灰度比例调整接口", () => {
  it("rollout 0→100 调整后同一客户端立即从不可见变为可见", async () => {
    const appId = "com.test.rollout";
    await createApp(appId);
    const v1 = await registerRelease({ appId, version: "1.0.0" });
    const v2 = await registerRelease({ appId, version: "1.1.0" });
    await promote(v1.body.release_id, null);
    await promote(v2.body.release_id, v1.body.release_id);

    const setZero = await adminApi(`/v1/admin/releases/${v2.body.release_id}`, {
      method: "PATCH",
      body: JSON.stringify({ rollout: 0, operator: "ci" }),
    });
    expect(setZero.status).toBe(200);

    const hidden = await queryJson(appId, "current=1.0.0&client_id=any-client");
    expect(hidden.update_available).toBe(false);
    expect(hidden.latest).toBe("1.0.0");

    const setFull = await adminApi(`/v1/admin/releases/${v2.body.release_id}`, {
      method: "PATCH",
      body: JSON.stringify({ rollout: 100 }),
    });
    expect(setFull.status).toBe(200);

    const visible = await queryJson(appId, "current=1.0.0&client_id=any-client");
    expect(visible.update_available).toBe(true);
    expect(visible.latest).toBe("1.1.0");
  });

  it("rollout 非法返回 400，release 不存在返回 404", async () => {
    const appId = "com.test.rollout-bad";
    await createApp(appId);
    const { body } = await registerRelease({ appId, version: "1.0.0" });

    const bad = await adminApi(`/v1/admin/releases/${body.release_id}`, {
      method: "PATCH",
      body: JSON.stringify({ rollout: 101 }),
    });
    expect(bad.status).toBe(400);

    const missing = await adminApi("/v1/admin/releases/rel_missing", {
      method: "PATCH",
      body: JSON.stringify({ rollout: 50 }),
    });
    expect(missing.status).toBe(404);
  });
});

describe("多软件 app_id 隔离", () => {
  it("两个软件各自发布与查询互不影响", async () => {
    const appA = "com.test.multi.app-a";
    const appB = "com.test.multi.app-b";
    await createApp(appA, "应用 A");
    await createApp(appB, "应用 B");

    const a1 = await registerRelease({ appId: appA, version: "1.5.0" });
    await promote(a1.body.release_id, null);
    const b1 = await registerRelease({ appId: appB, version: "2.0.0" });
    await promote(b1.body.release_id, null);

    const qa = await queryJson(appA, "current=1.0.0");
    expect(qa.update_available).toBe(true);
    expect(qa.latest).toBe("1.5.0");

    const qb = await queryJson(appB, "current=1.0.0");
    expect(qb.update_available).toBe(true);
    expect(qb.latest).toBe("2.0.0");

    // A 的 release_id 只服务 A 的文件；B 用 A 的 release_id 下载拿到的是 A 的包
    const dl = await publicApi(`/v1/download/${a1.body.release_id}`);
    expect(await dl.text()).toBe(`content-of-${appA}-stable-1.5.0`);
  });
});

describe("速率限制", () => {
  it("下载接口超过 30 次/分返回 429 RATE_LIMITED", async () => {
    if (!env.RATE_LIMIT_DOWNLOAD) {
      console.log("测试环境未配置限流绑定，跳过");
      return;
    }
    const appId = "com.test.ratelimit";
    await createApp(appId);
    const { body } = await registerRelease({ appId, version: "1.0.0" });
    await promote(body.release_id, null);

    let lastStatus = 0;
    let lastBody: any = null;
    for (let i = 0; i < 31; i++) {
      const res = await publicApiFrom("203.0.113.66", `/v1/download/${body.release_id}`);
      lastStatus = res.status;
      if (res.status === 429) lastBody = await res.json();
    }
    expect(lastStatus).toBe(429);
    expect(lastBody.error.code).toBe("RATE_LIMITED");
  });
});
