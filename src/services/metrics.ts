import type { Env } from "../types";

export interface MetricEvent {
  appId: string;
  channel: string;
  /** 事件类型：update_check / update_download */
  type: string;
  detail?: string;
  /** 数值维度：下载字节数等，缺省计 1 次 */
  value?: number;
}

/**
 * Analytics Engine 基础监控。
 * index = app_id（按应用聚合）；blobs = [channel, 事件类型, 附加信息]；doubles = [数值]。
 * 绑定缺失（本地/部分测试环境）或写入失败时不影响主流程。
 */
export function recordMetric(env: Env, event: MetricEvent): void {
  if (!env.METRICS) return;
  try {
    env.METRICS.writeDataPoint({
      indexes: [event.appId],
      blobs: [event.channel, event.type, event.detail ?? ""],
      doubles: [event.value ?? 1],
    });
  } catch {
    // 监控写入失败可忽略
  }
}
