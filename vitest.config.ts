import path from "node:path";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          main: path.join(__dirname, "src/index.ts"),
        miniflare: {
          compatibilityDate: "2025-05-05",
          d1Databases: ["DB"],
          r2Buckets: ["BUCKET"],
          analyticsEngineDatasets: { METRICS: { dataset: "releasedock_metrics" } },
          // 注：不配置 ratelimits —— miniflare 的限流计数器与 vitest-pool-workers
          // 的 per-test 存储隔离不兼容（计数器无法随测试回滚）。限流在生产环境
          // 由 wrangler.jsonc 中的绑定生效；测试环境中绑定缺失时中间件自动跳过。
          bindings: {
            ADMIN_TOKEN: "test-admin-token",
            // 供 test/apply-migrations.ts 中的 applyD1Migrations 使用
            TEST_MIGRATIONS: migrations,
          },
        },
        },
      },
    },
  };
});
