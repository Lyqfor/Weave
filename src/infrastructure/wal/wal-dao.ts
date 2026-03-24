import type { DatabaseSync } from "node:sqlite";
import { WeaveDb } from "./weave-db.js";
import type {
  IWalDao,
  SessionRecord,
  ExecutionRecord,
  WalEventRecord,
} from "../../contracts/storage.js";

/** 拓扑边记录（仅用于 replay-engine 读取） */
export interface EdgeRecord {
  source: string;
  target: string;
  kind: string;
}

export class WalDao implements IWalDao {
  private readonly db: DatabaseSync;

  constructor(private weaveDb: WeaveDb) {
    this.db = weaveDb.rawDb;
  }

  // ─── Session ─────────────────────────────────────────────────────────────

  upsertSession(session: SessionRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO session (id, title, head_execution_id)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        head_execution_id = excluded.head_execution_id
    `);
    stmt.run(session.id, session.title, session.head_execution_id ?? null);
  }

  getSession(id: string): SessionRecord | undefined {
    return this.db.prepare("SELECT * FROM session WHERE id = ?").get(id) as
      | SessionRecord
      | undefined;
  }

  updateSessionHead(sessionId: string, headExecutionId: string): void {
    this.db
      .prepare("UPDATE session SET head_execution_id = ? WHERE id = ?")
      .run(headExecutionId, sessionId);
  }

  getSessions(cursor?: string, limit: number = 20): SessionRecord[] {
    let sql = "SELECT * FROM session";
    const params: (string | number | null)[] = [];
    if (cursor) {
      sql += " WHERE created_at < ?";
      params.push(cursor);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    return this.db.prepare(sql).all(...params) as SessionRecord[];
  }

  // ─── Execution ───────────────────────────────────────────────────────────

  insertExecution(exec: ExecutionRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO dag_execution (id, session_id, parent_execution_id, forked_at_node, status)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      exec.id,
      exec.session_id,
      exec.parent_execution_id ?? null,
      exec.forked_at_node ?? null,
      exec.status
    );
  }

  updateExecutionStatus(id: string, status: ExecutionRecord["status"]): void {
    this.db.prepare("UPDATE dag_execution SET status = ? WHERE id = ?").run(status, id);
  }

  getExecution(id: string): ExecutionRecord | undefined {
    return this.db.prepare("SELECT * FROM dag_execution WHERE id = ?").get(id) as
      | ExecutionRecord
      | undefined;
  }

  getSessionExecutions(sessionId: string, cursor?: string, limit: number = 50): ExecutionRecord[] {
    let sql = "SELECT * FROM dag_execution WHERE session_id = ?";
    const params: (string | number | null)[] = [sessionId];
    if (cursor) {
      sql += " AND created_at < ?";
      params.push(cursor);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    return this.db.prepare(sql).all(...params) as ExecutionRecord[];
  }

  // ─── Edges ───────────────────────────────────────────────────────────────

  insertEdge(execId: string, sourceNodeId: string, targetNodeId: string, kind: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO dag_edge (execution_id, source_node_id, target_node_id, kind)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(execId, sourceNodeId, targetNodeId, kind);
  }

  // ─── Blackboard ──────────────────────────────────────────────────────────

  insertBlackboardMessage(id: string, sessionId: string, role: string, content: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO blackboard_message (id, session_id, role, content)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(id, sessionId, role, content);
  }

  getBlackboardMessage(id: string): { content: string; role: string } | undefined {
    return this.db.prepare("SELECT content, role FROM blackboard_message WHERE id = ?").get(id) as
      | { content: string; role: string }
      | undefined;
  }

  // ─── WAL Events ──────────────────────────────────────────────────────────

  insertWalEvent(event: WalEventRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO wal_event (execution_id, node_id, event_type, payload)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(event.execution_id, event.node_id ?? null, event.event_type, event.payload);
  }

  /**
   * 👑 核心魔法：使用递归 CTE 获取目标节点及其所有祖先节点的 WAL 日志。
   * 下推计算，极大提升回溯重放的效率。
   */
  getAncestorsWalEvents(execId: string, targetNodeId: string): WalEventRecord[] {
    const sql = `
      WITH RECURSIVE Ancestors(node_id) AS (
        SELECT source_node_id FROM dag_edge WHERE target_node_id = ? AND execution_id = ?
        UNION ALL
        SELECT e.source_node_id 
        FROM dag_edge e 
        INNER JOIN Ancestors a ON e.target_node_id = a.node_id
        WHERE e.execution_id = ?
      )
      SELECT * FROM wal_event 
      WHERE execution_id = ? 
      AND (node_id IN (SELECT node_id FROM Ancestors) OR node_id = ? OR node_id IS NULL)
      ORDER BY id ASC
    `;
    return this.db
      .prepare(sql)
      .all(targetNodeId, execId, execId, execId, targetNodeId) as WalEventRecord[];
  }

  getExecutionWalEvents(execId: string): WalEventRecord[] {
    return this.db
      .prepare("SELECT * FROM wal_event WHERE execution_id = ? ORDER BY id ASC")
      .all(execId) as WalEventRecord[];
  }

  getEdges(executionId: string): EdgeRecord[] {
    return this.db
      .prepare(
        "SELECT source_node_id as source, target_node_id as target, kind FROM dag_edge WHERE execution_id = ?"
      )
      .all(executionId) as unknown as EdgeRecord[];
  }
}
