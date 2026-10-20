import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { registerRelease, seedPublishedReleases } from "./helpers";
import { rolloutBucket } from "../src/utils/hash";
import { publicApi } from "./helpers";

const updatesUrl = (appId: string, channel: string, query: string) =>
  `/v1/updates/${appId}/${channel}${query}`;

async function queryUpdates(
  appId: string,
  channel: string,
  query: string,
): Promise<{ res: Response; body: any }> {
  const res = await publicApi(updatesUrl(appId, channel, query));
  return { res, body: await res.json() };
}

describe("版本查询：参数校验与存在性", () => {
  it("缺少 current 返回 400", async () => {
    const { res, body } = await queryUpdates("com.test.any", "stable", "");
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("current 版本号非法返回 400", async () => {
    const { res } = await queryUpdates("com.test.any", "stable", "?current=abc");
    expect(res.status).toBe(400);
  });

  it("应用不存在返回 404", async () => {
    const { res, body } = await queryUpdates(
      "com.test.up-noapp",
      "stable",
      "?current=1.0.0",
    );
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("APP_NOT_FOUND");
  });

  it("通道不存在返回 404", async () => {
    await seedPublishedReleases("com.test.up-chan", ["1.0.0"]);
    const { res, body } = await queryUpdates("com.test.up-chan", "nightly", "?current=1.0.0");
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("CHANNEL_NOT_FOUND");
  });

  it("查询接口带 60 秒缓存头", async () => {
    await seedPublishedReleases("com.test.up-cache", ["1.0.0"]);
    const { res } = await queryUpdates("com.test.up-cache", "stable", "?current=1.0.0");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
  });
});

describe("版本查询：更新判定与 Changelog", () => {
  it("已最新时返回无更新，且不含 changelog", async () => {
    await seedPublishedReleases("com.test.up-latest", ["1.1.0", "1.2.0"]);
    const { res, body } = await queryUpdates(
      "com.test.up-latest",
      "stable",
      "?current=1.2.0",
    );
    expect(res.status).toBe(200);
    expect(body.update_available).toBe(false);
    expect(body.latest).toBe("1.2.0");
    expect(body.mandatory).toBe(false);
    expect(body.changelog).toBeUndefined();
    expect(body.download_url).toBeUndefined();
  });

  it("有更新时返回拼接后的 changelog、下载信息与缓存头", async () => {
    const appId = "com.test.up-update";
    await seedPublishedReleases(appId, ["1.0.0", "1.1.0", "1.2.0"]);
    const { body } = await queryUpdates(appId, "stable", "?current=1.0.0");

    expect(body.update_available).toBe(true);
    expect(body.latest).toBe("1.2.0");
    expect(body.mandatory).toBe(false);
    expect(body.min_supported_version).toBe("0.0.0");
    expect(body.changelog.map((e: any) => e.version)).toEqual(["1.1.0", "1.2.0"]);
    expect(body.changelog[0].items).toEqual(["变更条目 1.1.0"]);
    expect(body.sha256).toBeTruthy();
    expect(body.size).toBe(1024);
    expect(body.published_at).toBeTruthy();
    expect(body.download_url).toMatch(/\/v1\/download\/rel_/);
  });

  it("include_changelog=false 时不返回 changelog", async () => {
    await seedPublishedReleases("com.test.up-nocl", ["1.0.0", "1.1.0"]);
    const { body } = await queryUpdates(
      "com.test.up-nocl",
      "stable",
      "?current=1.0.0&include_changelog=false",
    );
    expect(body.update_available).toBe(true);
    expect(body.changelog).toBeUndefined();
  });

  it("current 不在已发布版本中时只返回最新版本 changelog", async () => {
    await seedPublishedReleases("com.test.up-unknown", ["1.0.0", "1.1.0"]);
    const { body } = await queryUpdates(
      "com.test.up-unknown",
      "stable",
      "?current=0.9.0",
    );
    expect(body.update_available).toBe(true);
    expect(body.changelog).toHaveLength(1);
    expect(body.changelog[0].version).toBe("1.1.0");
  });

  it("超过 5 个版本时只保留最近 5 个并标记截断", async () => {
    const appId = "com.test.up-trunc";
    await seedPublishedReleases(appId, [
      "1.0.0",
      "1.1.0",
      "1.2.0",
      "1.3.0",
      "1.4.0",
      "1.5.0",
      "1.6.0",
      "1.7.0",
    ]);
    const { body } = await queryUpdates(appId, "stable", "?current=1.0.0");
    expect(body.changelog.map((e: any) => e.version)).toEqual([
      "1.3.0",
      "1.4.0",
      "1.5.0",
      "1.6.0",
      "1.7.0",
    ]);
    expect(body.changelog_truncated).toBe(true);
  });

  it("draft 版本对客户端不可见", async () => {
    const appId = "com.test.up-draft";
    await seedPublishedReleases(appId, ["1.0.0", "1.1.0"]);
    await registerRelease({ appId, version: "1.2.0" }); // 只登记不上线
    const { body } = await queryUpdates(appId, "stable", "?current=1.0.0");
    expect(body.latest).toBe("1.1.0");
    expect(body.update_available).toBe(true);
    expect(body.changelog.map((e: any) => e.version)).toEqual(["1.1.0"]);
  });

  it("低于 min_supported_version 时 mandatory=true", async () => {
    const appId = "com.test.up-mand";
    await seedPublishedReleases(appId, ["1.0.0", "1.1.0"]);
    await env.DB.prepare(
      "UPDATE app_channels SET min_supported_version = '1.1.0' WHERE app_id = ?",
    )
      .bind(appId)
      .run();

    const below = await queryUpdates(appId, "stable", "?current=1.0.0");
    expect(below.body.mandatory).toBe(true);

    const above = await queryUpdates(appId, "stable", "?current=1.1.0");
    expect(above.body.update_available).toBe(false);
    expect(above.body.mandatory).toBe(false);
  });

  it("客户端比服务端新（回滚后场景）返回无更新", async () => {
    const appId = "com.test.up-ahead";
    await seedPublishedReleases(appId, ["1.0.0", "1.1.0"]);
    const { body } = await queryUpdates(appId, "stable", "?current=1.5.0");
    expect(body.update_available).toBe(false);
    // latest 仍是服务端真实生效版本，客户端不应被要求降级
    expect(body.latest).toBe("1.1.0");
    expect(body.download_url).toBeUndefined();
  });
});

describe("版本查询：灰度分流", () => {
  it("rollout=100（默认）所有客户端可见", async () => {
    await seedPublishedReleases("com.test.up-gray100", ["1.0.0", "1.1.0"]);
    const { body } = await queryUpdates(
      "com.test.up-gray100",
      "stable",
      "?current=1.0.0&client_id=whatever",
    );
    expect(body.update_available).toBe(true);
    expect(body.latest).toBe("1.1.0");
  });

  it("rollout=0 时所有客户端命中回退版本", async () => {
    const appId = "com.test.up-gray0";
    await createAndSeedWithGray(appId, ["1.0.0", "1.1.0"], 0);
    const { body } = await queryUpdates(
      appId,
      "stable",
      "?current=1.0.0&client_id=some-client",
    );
    // 灰度未命中 → 有效最新版回退到 1.0.0 → 无更新
    expect(body.update_available).toBe(false);
    expect(body.latest).toBe("1.0.0");
  });

  it("按 client_id 稳定哈希分流：桶内可见、桶外不可见", async () => {
    const appId = "com.test.up-gray50";
    await createAndSeedWithGray(appId, ["1.0.0", "1.1.0"], 50);
    const { inside, outside } = await findClientIds(50);

    const inBody = await queryUpdates(
      appId,
      "stable",
      `?current=1.0.0&client_id=${inside}`,
    );
    expect(inBody.body.update_available).toBe(true);
    expect(inBody.body.latest).toBe("1.1.0");

    const outBody = await queryUpdates(
      appId,
      "stable",
      `?current=1.0.0&client_id=${outside}`,
    );
    expect(outBody.body.update_available).toBe(false);
    expect(outBody.body.latest).toBe("1.0.0");
  });

  it("无 client_id 时默认不进入灰度", async () => {
    const appId = "com.test.up-gray-nocid";
    await createAndSeedWithGray(appId, ["1.0.0", "1.1.0"], 99);
    const { body } = await queryUpdates(appId, "stable", "?current=1.0.0");
    expect(body.update_available).toBe(false);
    expect(body.latest).toBe("1.0.0");
  });

  it("灰度未命中且无更早发布版本时视为无更新", async () => {
    const appId = "com.test.up-gray-first";
    await seedPublishedReleases(appId, ["1.0.0"]);
    // 把唯一已上线的 1.0.0 调成灰度 0（测试内直接改库，模拟灰度发布中的首个版本）
    await env.DB.prepare("UPDATE releases SET rollout = 0 WHERE app_id = ?").bind(appId).run();
    const { body } = await queryUpdates(appId, "stable", "?current=0.9.0&client_id=c1");
    expect(body.update_available).toBe(false);
    expect(body.latest).toBe("0.9.0");
  });
});

/** 建应用、按顺序上线 versions，并把最后一个版本的灰度比例设为 rollout */
async function createAndSeedWithGray(
  appId: string,
  versions: string[],
  rollout: number,
): Promise<void> {
  await seedPublishedReleases(appId, versions);
  const lastVersion = versions[versions.length - 1];
  await env.DB.prepare(
    "UPDATE releases SET rollout = ? WHERE app_id = ? AND version = ?",
  )
    .bind(rollout, appId, lastVersion)
    .run();
}

/** 暴力寻找落入/未落入灰度桶的 client_id */
async function findClientIds(rollout: number): Promise<{ inside: string; outside: string }> {
  let inside = "";
  let outside = "";
  for (let i = 0; i < 1000 && (!inside || !outside); i++) {
    const id = `client-${i}`;
    const bucket = await rolloutBucket(id);
    if (bucket < rollout) {
      if (!inside) inside = id;
    } else if (!outside) {
      outside = id;
    }
  }
  if (!inside || !outside) throw new Error("找不到合适的灰度测试 client_id");
  return { inside, outside };
}
