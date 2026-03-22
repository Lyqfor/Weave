/*
 * 文件作用：恢复链路通用工具函数。
 * 提供 run 重订阅计划构建、队列入队/出队以及受控并发执行能力，供 App 与验证脚本复用。
 */

export interface DagRecoveryMeta {
  runId: string;
  lastEventId?: string;
  updatedAt: string;
}

export interface RunSubscribeMeta {
  runId: string;
  lastEventId?: string;
}

/**
 * 从 dag 视图中提取“每个 run 最新游标”用于重连后的增量订阅。
 */
export function buildRunSubscribePlan(dags: Record<string, DagRecoveryMeta>): RunSubscribeMeta[] {
  const latestByRun = new Map<string, DagRecoveryMeta>();

  for (const dag of Object.values(dags)) {
    const existing = latestByRun.get(dag.runId);
    if (!existing || existing.updatedAt < dag.updatedAt) {
      latestByRun.set(dag.runId, dag);
    }
  }

  return Array.from(latestByRun.values()).map((item) => ({
    runId: item.runId,
    lastEventId: item.lastEventId
  }));
}

/**
 * 队列入队（带上限）：超过上限时从队头丢弃最旧请求。
 */
export function enqueueWithLimit<T>(queue: T[], item: T, maxSize: number): T[] {
  queue.push(item);
  if (queue.length <= maxSize) {
    return [];
  }

  const overflow = queue.length - maxSize;
  return queue.splice(0, overflow);
}

/**
 * 在发送通道可用时，按 FIFO 语义一次性刷空队列。
 */
export function flushQueue<T>(queue: T[], canSend: () => boolean, send: (item: T) => void): number {
  let sent = 0;
  while (queue.length > 0 && canSend()) {
    const item = queue.shift();
    if (!item) break;
    send(item);
    sent += 1;
  }
  return sent;
}

/**
 * 受控并发执行器：按给定并发度消费任务列表。
 */
export async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;

  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;

  const runWorker = async () => {
    while (cursor < items.length) {
      const current = items[cursor];
      cursor += 1;
      if (current === undefined) {
        continue;
      }
      await worker(current);
    }
  };

  const workers = Array.from({ length: limit }, () => runWorker());
  await Promise.all(workers);
}
