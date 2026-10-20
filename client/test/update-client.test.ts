import { describe, expect, it } from "vitest";
import {
  ChecksumMismatchError,
  UpdateError,
  checkForUpdate,
  type UpdateClientConfig,
} from "../src/index";

interface StubResponse {
  status: number;
  body?: BodyInit;
  contentType?: string;
}

/** 依次返回预设响应的 fetch stub（第 1 次调用给第 1 个响应，以此类推） */
function sequentialFetch(responses: StubResponse[], capture?: { urls: string[] }): typeof fetch {
  let call = 0;
  return (async (input: any) => {
    if (capture) capture.urls.push(String(input));
    const r = responses[Math.min(call++, responses.length - 1)];
    return new Response(r.body ?? "", {
      status: r.status,
      headers: r.contentType ? { "Content-Type": r.contentType } : {},
    });
  }) as unknown as typeof fetch;
}

function json(status: number, body: unknown): StubResponse {
  return { status, body: JSON.stringify(body), contentType: "application/json" };
}

function baseConfig(fetchImpl: typeof fetch, overrides: Partial<UpdateClientConfig> = {}): UpdateClientConfig {
  return {
    baseUrl: "https://update.example.com",
    appId: "com.example.app",
    currentVersion: "1.0.0",
    fetchImpl,
    ...overrides,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("checkForUpdate", () => {
  it("按文档 8.1 拼接查询地址（channel 默认 stable，带 client_id）", async () => {
    const capture = { urls: [] as string[] };
    await checkForUpdate(
      baseConfig(sequentialFetch([json(200, { update_available: false })], capture), {
        clientId: "client-abc",
      }),
    );
    expect(capture.urls[0]).toBe(
      "https://update.example.com/v1/updates/com.example.app/stable?current=1.0.0&client_id=client-abc",
    );
  });

  it("channel 与 include_changelog=false 正确拼接", async () => {
    const capture = { urls: [] as string[] };
    await checkForUpdate(
      baseConfig(sequentialFetch([json(200, { update_available: false })], capture), {
        channel: "beta",
        clientId: "c1",
        includeChangelog: false,
      }),
    );
    expect(capture.urls[0]).toContain("/v1/updates/com.example.app/beta?");
    expect(capture.urls[0]).toContain("current=1.0.0");
    expect(capture.urls[0]).toContain("client_id=c1");
    expect(capture.urls[0]).toContain("include_changelog=false");
  });

  it("无更新时 download 为 undefined", async () => {
    const info = await checkForUpdate(
      baseConfig(
        sequentialFetch([json(200, { update_available: false, latest: "1.0.0", mandatory: false })]),
      ),
    );
    expect(info.updateAvailable).toBe(false);
    expect(info.mandatory).toBe(false);
    expect(info.download).toBeUndefined();
  });

  it("有更新时返回 changelog 与可用的 download，下载并校验通过", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha = await sha256Hex(bytes);
    const info = await checkForUpdate(
      baseConfig(
        sequentialFetch([
          json(200, {
            update_available: true,
            latest: "1.1.0",
            mandatory: false,
            changelog: [{ version: "1.1.0", items: ["修复登录超时问题"] }],
            download_url: "https://update.example.com/v1/download/rel_x",
            sha256: sha,
            size: bytes.byteLength,
          }),
          { status: 200, body: bytes as unknown as BodyInit },
        ]),
      ),
    );
    expect(info.updateAvailable).toBe(true);
    expect(info.latest).toBe("1.1.0");
    expect(info.changelog).toEqual([{ version: "1.1.0", items: ["修复登录超时问题"] }]);

    const result = await info.download!();
    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4]);
    expect(result.sha256).toBe(sha);
  });

  it("服务端错误时抛出带状态码与错误码的 UpdateError", async () => {
    const promise = checkForUpdate(
      baseConfig(sequentialFetch([json(404, { error: { code: "APP_NOT_FOUND", message: "应用不存在" } })])),
    );
    await expect(promise).rejects.toMatchObject({
      name: "UpdateError",
      status: 404,
      code: "APP_NOT_FOUND",
    });
  });
});

describe("下载校验", () => {
  const bytes = new Uint8Array([9, 8, 7]);

  function updateWith(sha: string): UpdateClientConfig {
    return baseConfig(
      sequentialFetch([
        json(200, {
          update_available: true,
          latest: "1.1.0",
          download_url: "https://update.example.com/v1/download/rel_x",
          sha256: sha,
        }),
        { status: 200, body: bytes as unknown as BodyInit },
      ]),
    );
  }

  it("SHA-256 不匹配时抛 ChecksumMismatchError", async () => {
    const info = await checkForUpdate(updateWith("f".repeat(64)));
    await expect(info.download!()).rejects.toMatchObject({
      name: "ChecksumMismatchError",
      code: "CHECKSUM_MISMATCH",
      expected: "f".repeat(64),
    });
    await expect(info.download!()).rejects.toBeInstanceOf(ChecksumMismatchError);
  });

  it("上报下载进度，最终 loaded == total == 字节数", async () => {
    const info = await checkForUpdate(updateWith(await sha256Hex(bytes)));
    const progress: Array<[number, number]> = [];
    const result = await info.download!({ onProgress: (loaded, total) => progress.push([loaded, total]) });
    expect(result.bytes.byteLength).toBe(3);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toEqual([3, 3]);
  });

  it("下载接口 5xx 抛 UpdateError（status=500）", async () => {
    const info = await checkForUpdate(
      baseConfig(
        sequentialFetch([
          json(200, {
            update_available: true,
            latest: "1.1.0",
            download_url: "https://update.example.com/v1/download/rel_x",
            sha256: "a".repeat(64),
          }),
          { status: 500, body: "boom" },
        ]),
      ),
    );
    await expect(info.download!()).rejects.toMatchObject({ name: "UpdateError", status: 500 });
  });
});

describe("超时", () => {
  it("超过 timeoutMs 抛出超时 UpdateError", async () => {
    const hanging = (async (_url: any, init: any) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    }) as unknown as typeof fetch;
    const promise = checkForUpdate(baseConfig(hanging, { timeoutMs: 20 }));
    await expect(promise).rejects.toMatchObject({ name: "UpdateError", message: "请求超时" });
  });
});
