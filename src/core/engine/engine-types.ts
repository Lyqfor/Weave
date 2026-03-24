/**
 * 文件作用：EngineContext 接口 — 调度引擎最小依赖集。
 * dag-executor 和 BaseNode 公共方法（transitionInDag/broadcastIo）只需此接口。
 * RunContext 继承此接口并添加智能体层依赖（LLM/工具/插件等）。
 * ⛔️ 绝对不放 pendingRegistry！引擎层不能依赖 Step Gate 人机交互层。
 */

import type { DagExecutionGraph } from "./dag-graph.js";
import type { DagStateStore } from "./state-store.js";
import type { ISnapshotStore } from "../../contracts/storage.js";
import type { ILogger } from "../ports/logger.js";
import type { IBlobStore } from "../ports/blob-store.js";

export interface IPauseSignal {
  wait(): Promise<void>;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
}

export interface EngineContext {
  runId: string;
  dag: DagExecutionGraph;
  abortSignal: AbortSignal;
  abortController: AbortController;
  /** Map<nodeId, BaseNode<EngineContext>> — 执行中的节点注册表 */
  nodeRegistry: Map<string, { execute(ctx: EngineContext): Promise<void> }>;
  stateStore: DagStateStore;
  snapshotStore?: ISnapshotStore;
  logger: ILogger;
  blobStore?: IBlobStore;
  /** 暂停信号量，用于在调度 Tick 开始前挂起执行 */
  pauseSignal?: IPauseSignal;
}
