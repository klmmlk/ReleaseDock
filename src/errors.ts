/** 业务错误：携带文档第 10 节定义的 HTTP 状态码与错误码 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  invalidRequest: (message = "请求参数缺失或格式错误") => new AppError(400, "INVALID_REQUEST", message),
  unauthorized: (message = "管理接口鉴权失败") => new AppError(401, "UNAUTHORIZED", message),
  forbidden: (message = "无权限") => new AppError(403, "FORBIDDEN", message),
  appNotFound: () => new AppError(404, "APP_NOT_FOUND", "应用不存在"),
  channelNotFound: () => new AppError(404, "CHANNEL_NOT_FOUND", "通道不存在"),
  releaseNotFound: () => new AppError(404, "RELEASE_NOT_FOUND", "版本记录不存在"),
  r2ObjectNotFound: () => new AppError(404, "R2_OBJECT_NOT_FOUND", "R2 中不存在对应的更新包文件"),
  appAlreadyExists: () => new AppError(409, "APP_ALREADY_EXISTS", "应用已存在"),
  versionAlreadyExists: () => new AppError(409, "VERSION_ALREADY_EXISTS", "同应用同通道同版本已登记"),
  pointerConflict: () => new AppError(409, "POINTER_CONFLICT", "乐观并发控制失败，当前指针已变化"),
  releaseNotPromotable: () => new AppError(409, "RELEASE_NOT_PROMOTABLE", "当前状态不允许上线"),
  rateLimited: () => new AppError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试"),
  internal: (message = "服务端错误") => new AppError(500, "INTERNAL_ERROR", message),
};
