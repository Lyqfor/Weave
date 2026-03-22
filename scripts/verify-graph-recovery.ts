/**
 * 文件作用：验证 Web 恢复链路核心工具函数语义（重订阅计划、离线队列、受控并发）。
 */

import {
  buildRunSubscribePlan,
  enqueueWithLimit,
  flushQueue,
  runWithConcurrency,
  type DagRecoveryMeta
} from "../apps/weave-graph-web/src/lib/recovery-utils";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function verifyBuildRunSubscribePlan(): Promise<void> {
  const dags: Record<string, DagRecoveryMeta> = {
    dagA: { runId: "run-1", lastEventId: "e1", updatedAt: "2026-03-22T10:00:00.000Z" },
    dagB: { runId: "run-1", lastEventId: "e2", updatedAt: "2026-03-22T10:01:00.000Z" },
    dagC: { runId: "run-2", lastEventId: "x1", updatedAt: "2026-03-22T10:00:30.000Z" }
  };

  const plan = buildRunSubscribePlan(dags);
  assert(plan.length === 2, "plan 应按 run 去重后返回 2 条");
  const run1 = plan.find((item) => item.runId === "run-1");
  assert(run1?.lastEventId === "e2", "run-1 应选择更新时间最新的游标");
}

async function verifyQueueHelpers(): Promise<void> {
  const queue: Array<{ reqId: string }> = [];

  enqueueWithLimit(queue, { reqId: "a" }, 2);
  enqueueWithLimit(queue, { reqId: "b" }, 2);
  const dropped = enqueueWithLimit(queue, { reqId: "c" }, 2);

  assert(dropped.length === 1 && dropped[0]?.reqId === "a", "超限时应丢弃最旧请求");
  assert(queue.map((item) => item.reqId).join(",") === "b,c", "队列应保留最新请求");

  const sent: string[] = [];
  const sentCount = flushQueue(
    queue,
    () => true,
    (item) => sent.push(item.reqId)
  );

  assert(sentCount === 2, "flushQueue 应发送 2 条请求");
  assert(sent.join(",") === "b,c", "flushQueue 应遵循 FIFO 顺序");
  assert(queue.length === 0, "flushQueue 后队列应为空");
}

async function verifyRunWithConcurrency(): Promise<void> {
  const items = Array.from({ length: 10 }, (_, idx) => idx + 1);
  let active = 0;
  let maxActive = 0;
  const executed: number[] = [];

  await runWithConcurrency(items, 3, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    executed.push(item);
    active -= 1;
  });

  assert(maxActive <= 3, "并发执行峰值不应超过指定上限");
  assert(executed.length === items.length, "所有任务都应被执行");
}

async function main(): Promise<void> {
  await verifyBuildRunSubscribePlan();
  await verifyQueueHelpers();
  await verifyRunWithConcurrency();

  console.log("Graph recovery verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
