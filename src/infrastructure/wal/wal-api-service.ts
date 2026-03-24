import { WalDao } from "./wal-dao.js";
import { DagReplayEngine, DagSnapshotDTO } from "./replay-engine.js";
import type { SessionRecord, ExecutionRecord } from "../../application/ports/wal-dao.js";

/**
 * 文件作用：WalApiService — 面向前端的业务服务外观类。
 * 封装底层的 DAO 和 ReplayEngine，提供支持分页、轻量级快照和防竞态 Fork 的高级 API。
 */
export class WalApiService {
  constructor(
    private readonly dao: WalDao,
    private readonly replayEngine: DagReplayEngine
  ) {}

  // ─── Session & Timeline ──────────────────────────────────────────────────

  /**
   * 获取会话列表（支持基于时间的 Cursor 分页）。
   */
  getSessions(
    cursor?: string,
    limit: number = 20
  ): { sessions: SessionRecord[]; nextCursor: string | null } {
    const sessions = this.dao.getSessions(cursor, limit);
    // 使用最后一条记录的时间戳作为下一次查询的 cursor
    const nextCursor = sessions.length === limit ? sessions[sessions.length - 1].created_at! : null;
    return { sessions, nextCursor };
  }

  /**
   * 获取会话详情。
   */
  getSessionDetails(sessionId: string): SessionRecord | undefined {
    return this.dao.getSession(sessionId);
  }

  /**
   * 获取特定会话的所有执行分支（支持分页）。
   */
  getSessionExecutions(
    sessionId: string,
    cursor?: string,
    limit: number = 50
  ): { executions: ExecutionRecord[]; nextCursor: string | null } {
    const executions = this.dao.getSessionExecutions(sessionId, cursor, limit);
    const nextCursor =
      executions.length === limit ? executions[executions.length - 1].created_at! : null;
    return { executions, nextCursor };
  }

  /**
   * 切换当前激活的执行分支（Head 指针）。
   */
  switchActiveExecution(sessionId: string, executionId: string): void {
    this.dao.updateSessionHead(sessionId, executionId);
  }

  // ─── Graph Hydration ─────────────────────────────────────────────────────

  /**
   * 重构某个执行点的轻量化图快照（只读）。
   */
  async reconstructExecutionSnapshot(executionId: string): Promise<DagSnapshotDTO> {
    const { dag, stateStore } = await this.replayEngine.reconstruct(executionId);
    return this.replayEngine.toSnapshotDTO(dag, stateStore, executionId);
  }

  // ─── Time-Travel & Forking ───────────────────────────────────────────────

  /**
   * 步骤 1: 仅创建新分支，不唤醒调度器。
   * 解决了异步竞态问题，允许前端在 Run 开始前先完成 WebSocket 订阅。
   */
  async forkExecution(
    sessionId: string,
    parentExecId: string,
    forkAtNodeId: string
  ): Promise<string> {
    // 生成新的执行 ID，建议带上 fork 标记
    const newExecId = `run_${Date.now()}_fork_${Math.random().toString(36).slice(2, 6)}`;

    // 调用重放引擎创建物理实例
    await this.replayEngine.fork(parentExecId, forkAtNodeId, newExecId);

    return newExecId;
  }

  /**
   * 步骤 2: 正式启动/恢复执行（预留接口，需对接 AgentRuntime 的生命周期管理）。
   */
  async resumeExecution(
    executionId: string,
    modifiedParams?: Record<string, unknown>
  ): Promise<void> {
    // 👑 架构说明：此处应通过 Orchestrator 或 RuntimeManager 唤醒 Engine
    // 目前仅作为接口预留，具体的引擎唤醒逻辑将在 Runtime 集成层实现
    console.log(`[WAL-API] 准备恢复执行: ${executionId}, 参数覆盖:`, modifiedParams);
  }

  // ─── Blackboard ──────────────────────────────────────────────────────────

  /**
   * 按需获取黑板中的大文本内容（懒加载）。
   */
  getBlackboardContent(blackboardId: string): { role: string; content: string } | null {
    const msg = this.dao.getBlackboardMessage(blackboardId);
    return msg ? { role: msg.role, content: msg.content } : null;
  }
}
