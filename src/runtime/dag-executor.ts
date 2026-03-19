/**
 * 文件作用：DAG 执行器 — 主循环，并行调度所有就绪的可执行节点。
 * Phase 2 改造：Promise.all 毫秒级熔断 + AbortController 信号广播。
 * 🛡️ 悬空 Promise 防御：每个 Promise 都有 .catch 兜底，消灭 Unhandled Rejection。
 */
import type { DagExecutionGraph } from "./dag-graph.js";
import type { RunContext } from "../session/run-context.js";
import type { BaseNode } from "./nodes/base-node.js";

export class DagDeadlockError extends Error {
  constructor(public readonly pendingNodeIds: string[]) {
    super(`DAG 调度死锁：存在未完成节点但无可执行 ready 节点 [${pendingNodeIds.join(", ")}]`);
    this.name = "DagDeadlockError";
  }
}

export async function executeDag(dag: DagExecutionGraph, ctx: RunContext): Promise<string> {
  while (dag.hasPendingWork()) {
    // 检查全局 abort signal
    ctx.abortSignal?.throwIfAborted();

    const readyIds = dag.getReadyNodeIds().sort();

    if (readyIds.length === 0) {
      const pendingIds = dag.getInProgressNodeIds();
      // 引擎自己广播调度问题，不依赖外层转译
      dag.getEngineEventBus()?.onSchedulerIssue(
        "deadlock",
        "DAG 调度死锁：存在未完成节点但无可执行 ready 节点",
        pendingIds
      );
      throw new DagDeadlockError(pendingIds);
    }

    // 1. 启动所有并行任务
    const nodePromises = readyIds.map(id => {
      const node = ctx.nodeRegistry.get(id) as BaseNode | undefined;
      if (!node) {
        throw new Error(`executeDag: 无法找到可执行节点 ${id}，节点未在 ctx.nodeRegistry 中注册`);
      }
      return node.execute(ctx);
    });

    // 2. 🛡️ 极其关键的防御：吞噬滞后的异常
    //    当 Promise.all 因 A 失败而 reject 后，B 随后抛出的 AbortError
    //    会变成 Unhandled Promise Rejection，直接 Crash Node.js 进程！
    //    这行代码让每个 Promise 都有一个 .catch 兜底，消灭悬空异常。
    nodePromises.forEach(p => p.catch(() => {}));

    try {
      // 3. Promise.all 毫秒级熔断：任一节点报错，瞬间跳入 catch
      await Promise.all(nodePromises);
    } catch (error: any) {
      // 4. 瞬间广播 abort 信号！其他并行节点在 catch 中自降级
      if (!ctx.abortSignal?.aborted) {
        ctx.abortController?.abort(error);
      }

      // 拒绝所有挂起的审批 Promise（防内存泄漏）
      ctx.pendingRegistry?.rejectAll(new Error("DAG 执行中止"));

      throw error;
    }
  }

  return ctx.stateStore.getFinalText();
}
