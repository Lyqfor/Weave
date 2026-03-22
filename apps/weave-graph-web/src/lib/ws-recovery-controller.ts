/*
 * 文件作用：WebSocket 恢复控制器。
 * 统一处理离线队列、重连后队列刷空和 run 重订阅恢复流程，便于主流程复用与集成验证。
 */

import { buildRunSubscribePlan, enqueueWithLimit, flushQueue, runWithConcurrency } from "./recovery-utils";

export interface RpcEnvelope {
  type: string;
  reqId: string;
  payload: unknown;
}

export interface DagSnapshotLike {
  runId: string;
  lastEventId?: string;
  updatedAt: string;
}

export interface WsRecoveryControllerOptions {
  maxQueueSize?: number;
  resubscribeConcurrency?: number;
  canSend: () => boolean;
  sendEnvelope: (envelope: RpcEnvelope) => void;
  markDispatched: (reqId: string) => void;
  cancelRequest: (reqId: string, reason: string) => void;
  sendRpc: (type: string, payload: unknown) => Promise<unknown>;
}

export class WsRecoveryController {
  private readonly queue: RpcEnvelope[] = [];
  private readonly maxQueueSize: number;
  private readonly resubscribeConcurrency: number;

  constructor(private readonly options: WsRecoveryControllerOptions) {
    this.maxQueueSize = options.maxQueueSize ?? 300;
    this.resubscribeConcurrency = options.resubscribeConcurrency ?? 4;
  }

  /**
   * 尝试发送一条 RPC 信封：在线直接发，离线先入队。
   */
  enqueueOrSend(envelope: RpcEnvelope): void {
    if (this.options.canSend()) {
      this.options.sendEnvelope(envelope);
      this.options.markDispatched(envelope.reqId);
      return;
    }

    const dropped = enqueueWithLimit(this.queue, envelope, this.maxQueueSize);
    for (const item of dropped) {
      this.options.cancelRequest(item.reqId, "RPC queue overflow");
    }
  }

  /**
   * WebSocket 恢复后刷空离线队列。
   */
  flushQueueOnReconnect(): number {
    return flushQueue(
      this.queue,
      () => this.options.canSend(),
      (item) => {
        this.options.sendEnvelope(item);
        this.options.markDispatched(item.reqId);
      }
    );
  }

  /**
   * 根据当前 DAG 快照恢复 run 订阅。
   */
  async resubscribeRuns(dags: Record<string, DagSnapshotLike>): Promise<void> {
    const plan = buildRunSubscribePlan(dags);
    await runWithConcurrency(plan, this.resubscribeConcurrency, async (item) => {
      try {
        await this.options.sendRpc("run.subscribe", {
          runId: item.runId,
          lastEventId: item.lastEventId
        });
      } catch {
        // 单 run 恢复失败不阻断整批恢复。
      }
    });
  }

  /**
   * 组件销毁时取消尚未发出的请求，避免 Promise 悬挂。
   */
  cancelPendingQueue(reason = "RPC canceled: websocket disposed"): void {
    const pending = this.queue.splice(0);
    for (const item of pending) {
      this.options.cancelRequest(item.reqId, reason);
    }
  }

  pendingCount(): number {
    return this.queue.length;
  }
}
