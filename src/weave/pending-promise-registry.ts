/**
 * 文件作用：PendingPromiseRegistry — 挂起字典，管理等待人类审批的 Promise 生命周期。
 * 超时保护 + rejectAll 清空，防止内存泄漏。
 */

import type { InterceptDecision } from "./interceptor.js";
import type { BaseNode } from "../nodes/base-node.js";

interface PendingEntry {
  resolve: (decision: InterceptDecision) => void;
  reject: (error: Error) => void;
  node: BaseNode;
  createdAt: number;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

export class PendingPromiseRegistry {
  private pending = new Map<string, PendingEntry>();

  /** 挂起节点等待审批，超时自动 reject */
  suspend(nodeId: string, node: BaseNode, timeoutMs = 5 * 60 * 1000): Promise<InterceptDecision> {
    // 清理已有挂起（防御性）
    if (this.pending.has(nodeId)) {
      const old = this.pending.get(nodeId)!;
      if (old.timeoutHandle) clearTimeout(old.timeoutHandle);
      old.reject(new Error(`节点 ${nodeId} 被新的 suspend 覆盖`));
      this.pending.delete(nodeId);
    }

    return new Promise<InterceptDecision>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        if (this.pending.has(nodeId)) {
          this.pending.delete(nodeId);
          reject(new Error(`节点 ${nodeId} 审批超时（${timeoutMs}ms）`));
        }
      }, timeoutMs);

      this.pending.set(nodeId, { resolve, reject, node, createdAt: Date.now(), timeoutHandle });
    });
  }

  /** 恢复挂起的节点，传入审批决策 */
  resume(nodeId: string, decision: InterceptDecision): boolean {
    const entry = this.pending.get(nodeId);
    if (!entry) return false;
    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
    entry.resolve(decision);
    this.pending.delete(nodeId);
    return true;
  }

  /** 拒绝所有挂起的 Promise（连接断开/进程关闭/DAG 中止时调用） */
  rejectAll(reason: Error): void {
    for (const [, entry] of this.pending) {
      if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
      entry.reject(reason);
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }

  has(nodeId: string): boolean {
    return this.pending.has(nodeId);
  }
}
