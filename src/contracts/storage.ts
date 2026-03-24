/**
 * 契约层：存储层接口与类型
 * 规则：此文件只允许 Zod Schema、TypeScript interface/type、JSDoc 注释。零业务实现代码。
 */

import { z } from "zod";

// ─── WAL 事件记录 ────────────────────────────────────────────────────────────

/**
 * WAL 事件记录（数据库存储格式）
 * @example { execution_id: 'exec-1', node_id: 'llm-1', event_type: 'transition', payload: '{"from":"running","to":"success"}' }
 */
export const WalEventRecordSchema = z.object({
  id: z.number().int().optional(),
  execution_id: z.string(),
  node_id: z.string().nullable().optional(),
  event_type: z.string(),
  payload: z.string(), // JSON string
  created_at: z.string().optional(),
});
export type WalEventRecord = z.infer<typeof WalEventRecordSchema>;

/**
 * 会话记录
 * @example { id: 'sess-uuid', title: '第一次对话', head_execution_id: 'exec-uuid' }
 */
export const SessionRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  head_execution_id: z.string().nullable().optional(),
  created_at: z.string().optional(),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

/**
 * 执行记录
 * @example { id: 'exec-uuid', session_id: 'sess-uuid', status: 'COMPLETED' }
 */
export const ExecutionRecordSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  parent_execution_id: z.string().nullable().optional(),
  forked_at_node: z.string().nullable().optional(),
  status: z.enum(["RUNNING", "COMPLETED", "FAILED", "INTERCEPTED"]),
  created_at: z.string().optional(),
});
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;

// ─── WAL DAO 接口 ────────────────────────────────────────────────────────────

/**
 * WAL 数据访问对象接口 — 所有持久化操作的唯一入口。
 *
 * 规则：禁止在 IWalDao 实现外部直接调用 db.prepare()（见 ANTI_PATTERNS.md E-005）。
 *
 * @example
 * const dao: IWalDao = new WalDao(weaveDb);
 * dao.upsertSession({ id: 'sess-1', title: '对话1' });
 */
export interface IWalDao {
  // Session
  upsertSession(session: SessionRecord): void;
  getSession(id: string): SessionRecord | undefined;
  updateSessionHead(sessionId: string, headExecutionId: string): void;
  getSessions(cursor?: string, limit?: number): SessionRecord[];

  // Execution
  insertExecution(exec: ExecutionRecord): void;
  updateExecutionStatus(id: string, status: ExecutionRecord["status"]): void;
  getExecution(id: string): ExecutionRecord | undefined;
  getSessionExecutions(sessionId: string, cursor?: string, limit?: number): ExecutionRecord[];

  // Edge
  insertEdge(execId: string, sourceNodeId: string, targetNodeId: string, kind: string): void;
  getEdges(executionId: string): { source: string; target: string; kind: string }[];

  // Blackboard
  insertBlackboardMessage(id: string, sessionId: string, role: string, content: string): void;
  getBlackboardMessage(id: string): { content: string; role: string } | undefined;

  // WAL Events
  insertWalEvent(event: WalEventRecord): void;
  getAncestorsWalEvents(execId: string, targetNodeId: string): WalEventRecord[];
  getExecutionWalEvents(execId: string): WalEventRecord[];
}

// ─── Blob 存储接口 ────────────────────────────────────────────────────────────

/**
 * Blob 存储接口 — 大内容的引用存储，避免 WAL 中存储大对象。
 * @example
 * const store: IBlobStore = new BlobStore();
 * const { blobRef } = await store.store(largeContent);
 * const content = await store.get(blobRef);
 */
export interface IBlobStore {
  store(content: unknown): Promise<{ content: unknown; blobRef?: string }>;
  get(blobRef: string): Promise<unknown>;
}

// ─── 快照存储接口 ─────────────────────────────────────────────────────────────

import { FrozenSnapshotSchema, SnapshotEntrySchema } from "./engine.js";
export type { FrozenSnapshot, SnapshotEntry } from "./engine.js";
// Re-export from engine for convenience
export { FrozenSnapshotSchema, SnapshotEntrySchema };

/**
 * 快照存储接口 — 同步冻结 + 异步装配，支持回溯和分叉重跑。
 * @example
 * const store: ISnapshotStore = new SnapshotStore(diskPath);
 * const seq = store.appendFrozen({ nodeId: 'llm-1', fromStatus: 'running', toStatus: 'success', ... });
 */
export interface ISnapshotStore {
  appendFrozen(entry: Omit<import("./engine.js").SnapshotEntry, "seq" | "payload">): number;
  /** 异步装配：补充 Blob 数据到已有快照条目（节点执行完成后调用） */
  hydrateEntry(seq: number, payload: Record<string, unknown>): Promise<void>;
  getAll(): import("./engine.js").SnapshotEntry[];
  getByNodeId(nodeId: string): import("./engine.js").SnapshotEntry[];
  getLatestByNodeId(nodeId: string): import("./engine.js").SnapshotEntry | undefined;
}
