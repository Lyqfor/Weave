/**
 * 文件作用：验证 WsRecoveryController 的联动语义。
 * 覆盖：离线入队、超限淘汰取消、重连刷空发送、重订阅并发上限。
 */

import { WsRecoveryController, type DagSnapshotLike, type RpcEnvelope } from "../apps/weave-graph-web/src/lib/ws-recovery-controller";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function verifyQueueAndFlush(): Promise<void> {
  let open = false;
  const sent: string[] = [];
  const canceled: string[] = [];
  const dispatched: string[] = [];

  const controller = new WsRecoveryController({
    maxQueueSize: 2,
    canSend: () => open,
    sendEnvelope: (envelope) => sent.push(envelope.reqId),
    markDispatched: (reqId) => dispatched.push(reqId),
    cancelRequest: (reqId) => canceled.push(reqId),
    sendRpc: async () => ({ ok: true })
  });

  const a: RpcEnvelope = { type: "run.subscribe", reqId: "a", payload: { runId: "r1" } };
  const b: RpcEnvelope = { type: "run.subscribe", reqId: "b", payload: { runId: "r2" } };
  const c: RpcEnvelope = { type: "run.subscribe", reqId: "c", payload: { runId: "r3" } };

  controller.enqueueOrSend(a);
  controller.enqueueOrSend(b);
  controller.enqueueOrSend(c);

  assert(controller.pendingCount() === 2, "离线队列应保留 2 条最新请求");
  assert(canceled.length === 1 && canceled[0] === "a", "超限应取消最旧请求");

  open = true;
  const flushed = controller.flushQueueOnReconnect();
  assert(flushed === 2, "重连后应刷空 2 条请求");
  assert(sent.join(",") === "b,c", "刷空发送顺序应为 FIFO");
  assert(dispatched.join(",") === "b,c", "刷空后应标记为已发送");
}

async function verifyResubscribeConcurrency(): Promise<void> {
  let active = 0;
  let maxActive = 0;
  const calledRunIds: string[] = [];

  const controller = new WsRecoveryController({
    resubscribeConcurrency: 2,
    canSend: () => true,
    sendEnvelope: () => {},
    markDispatched: () => {},
    cancelRequest: () => {},
    sendRpc: async (_type, payload) => {
      const runId = String((payload as { runId?: string }).runId ?? "");
      calledRunIds.push(runId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { ok: true };
    }
  });

  const dags: Record<string, DagSnapshotLike> = {
    d1: { runId: "run-1", lastEventId: "e1", updatedAt: "2026-03-22T10:00:00.000Z" },
    d2: { runId: "run-1", lastEventId: "e2", updatedAt: "2026-03-22T10:01:00.000Z" },
    d3: { runId: "run-2", lastEventId: "x1", updatedAt: "2026-03-22T10:00:30.000Z" },
    d4: { runId: "run-3", lastEventId: "y1", updatedAt: "2026-03-22T10:00:40.000Z" }
  };

  await controller.resubscribeRuns(dags);

  assert(maxActive <= 2, "重订阅并发峰值不应超过设定上限");
  assert(calledRunIds.length === 3, "重订阅应按 run 去重后执行");
}

async function main(): Promise<void> {
  await verifyQueueAndFlush();
  await verifyResubscribeConcurrency();
  console.log("WS recovery controller verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
