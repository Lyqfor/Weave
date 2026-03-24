/**
 * 文件作用：DAG 执行器 — 主循环，并行调度所有就绪的可执行节点。
 * Phase 2 改造：Promise.all 毫秒级熔断 + AbortController 信号广播。
 * 🛡️ 悬空 Promise 防御：每个 Promise 都有 .catch 兜底，消灭 Unhandled Rejection。
 * pendingRegistry.rejectAll 已移至 Layer 3（run-agent.ts），引擎层不再负责清理。
 */
import type { DagExecutionGraph } from "./dag-graph.js";
import type { EngineContext } from "./engine-types.js";

export class DagDeadlockError extends Error {
  constructor(public readonly pendingNodeIds: string[]) {
    super(`DAG 调度死锁：存在未完成节点但无可执行 ready 节点 [${pendingNodeIds.join(", ")}]`);
    this.name = "DagDeadlockError";
  }
}

export async function executeDag(dag: DagExecutionGraph, ctx: EngineContext): Promise<string> {
  while (dag.hasPendingWork()) {
    // 检查全局 abort signal
    ctx.abortSignal?.throwIfAborted();

    // 🛡️ 暂停检查：在启动新一轮 Tick 前挂起
    if (ctx.pauseSignal) {
      await ctx.pauseSignal.wait();
    }

    const readyIds = dag.getReadyNodeIds().sort();

    if (readyIds.length === 0) {
      const pendingIds = dag.getInProgressNodeIds();
      dag
        .getEngineEventBus()
        ?.onSchedulerIssue(
          "deadlock",
          "DAG 调度死锁：存在未完成节点但无可执行 ready 节点",
          pendingIds
        );
      throw new DagDeadlockError(pendingIds);
    }

    // 1. 启动所有并行任务
    const nodePromises = readyIds.map((id) => {
      const node = ctx.nodeRegistry.get(id);
      if (!node) {
        throw new Error(`executeDag: 无法找到可执行节点 ${id}，节点未在 ctx.nodeRegistry 中注册`);
      }
      return node.execute(ctx);
    });

    // 2. 🛡️ 极其关键的防御：吞噬滞后的异常
    //    当 Promise.all 因 A 失败而 reject 后，B 随后抛出的 AbortError
    //    会变成 Unhandled Promise Rejection，直接 Crash Node.js 进程！
    //    这行代码让每个 Promise 都有一个 .catch 兜底，消灭悬空异常。
    nodePromises.forEach((p) => p.catch(() => {}));

    try {
      // 3. Promise.all 毫秒级熔断：任一节点报错，瞬间跳入 catch
      await Promise.all(nodePromises);
    } catch (error: unknown) {
      // 4. 瞬间广播 abort 信号！其他并行节点在 catch 中自降级
      if (!ctx.abortSignal?.aborted) {
        ctx.abortController?.abort(error);
      }
      // pendingRegistry.rejectAll 已由 Layer 3 通过 abort signal 监听自动触发
      throw error;
    }
  }

  return ctx.stateStore.getFinalText();
}

/** WeaveDAGEngine — 面向对象封装，便于依赖注入与单元测试 */
export class WeaveDAGEngine {
  async execute(dag: DagExecutionGraph, ctx: EngineContext): Promise<string> {
    return executeDag(dag, ctx);
  }
}
