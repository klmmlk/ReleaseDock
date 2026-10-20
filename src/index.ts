import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "./types";
import { AppError } from "./errors";
import { updates } from "./routes/updates";
import { download } from "./routes/download";
import { admin } from "./routes/admin";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  c.json({ name: "releasedock", version: "0.1.0", status: "ok" }),
);
app.get("/healthz", (c) => c.json({ status: "ok" }));

app.route("/v1", updates);
app.route("/v1", download);
app.route("/v1", admin);

app.notFound((c) =>
  c.json({ error: { code: "NOT_FOUND", message: "接口不存在" } }, 404),
);

app.onError((err, c) => {
  const isAppError = err instanceof AppError;
  if (!isAppError) console.error("未处理异常:", err);
  const status = (isAppError ? err.status : 500) as ContentfulStatusCode;
  const payload = isAppError
    ? { error: { code: err.code, message: err.message } }
    : { error: { code: "INTERNAL_ERROR", message: "服务端错误" } };
  const res = c.json(payload, status);
  if (c.req.path.startsWith("/v1/admin")) res.headers.set("Cache-Control", "no-store");
  return res;
});

export default app;
