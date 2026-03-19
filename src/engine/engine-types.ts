/**
 * 文件作用：EngineContext 接口 — 调度引擎最小依赖集。
 * dag-executor 和 BaseNode 公共方法（transitionInDag/broadcastIo）只需此接口。
 * RunContext 继承此接口并添加智能体层依赖（LLM/工具/插件等）。
 * ⛔️ 绝对不放 pendingRegistry！引擎层不能依赖 Step Gate 人机交互层。
 */

import type { DagExecutionGraph } from "./dag-graph.js";
import type { DagStateStore } from "./state-store.js";
import type { SnapshotStore } from "./snapshot-store.js";
import type { AppLogger } from "../logging/app-logger.js";

export interface EngineContext {
  runId: string;
  dag: DagExecutionGraph;
  abortSignal: AbortSignal;
  abortController: AbortController;
  /** Map<nodeId, BaseNode<any>> — 避免与 base-node 循环导入，使用 any */
  nodeRegistry: Map<string, any>;
  stateStore: DagStateStore;
  snapshotStore?: SnapshotStore;
  logger: AppLogger;
}
