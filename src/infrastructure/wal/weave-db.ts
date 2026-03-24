import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

const SCHEMA_SQL = `
-- 1. Session 表：宏观对话生命周期
CREATE TABLE IF NOT EXISTS session (
  id VARCHAR PRIMARY KEY,
  title VARCHAR,
  head_execution_id VARCHAR, -- 当前激活的执行分支
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. DAG 执行实例表（时间线）
CREATE TABLE IF NOT EXISTS dag_execution (
  id VARCHAR PRIMARY KEY,
  session_id VARCHAR REFERENCES session(id),
  parent_execution_id VARCHAR,     -- 关联原时间线（Fork 来源）
  forked_at_node VARCHAR,          -- 记录分叉节点 ID
  status VARCHAR,                  -- RUNNING, COMPLETED, FAILED, INTERCEPTED
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. 拓扑边表 (为了 CTE 性能优化)
CREATE TABLE IF NOT EXISTS dag_edge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id VARCHAR REFERENCES dag_execution(id),
  source_node_id VARCHAR,
  target_node_id VARCHAR,
  kind VARCHAR                     -- dependency, data, retry
);

-- 4. 数据黑板表（Blackboard Message / Payload Pool）
CREATE TABLE IF NOT EXISTS blackboard_message (
  id VARCHAR PRIMARY KEY,
  session_id VARCHAR REFERENCES session(id),
  role VARCHAR,                    -- system, user, assistant, tool, config
  content TEXT,                    -- 实际的庞大文本或 JSON Payload
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. 预写式日志表（WAL Events）
CREATE TABLE IF NOT EXISTS wal_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id VARCHAR REFERENCES dag_execution(id),
  node_id VARCHAR,
  event_type VARCHAR,              -- 事件枚举
  payload JSON,                    -- 仅存增量、指针（Blackboard ID）和状态差值
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

/**
 * 文件作用：WeaveDb — 核心 SQLite 持久化引擎。
 * 基于 Node.js 24 原生内置的 DatabaseSync，零原生模块编译依赖。
 * 负责数据库初始化、Schema 加载及基础连接管理。
 */
export class WeaveDb {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);

    // 👑 顶级架构配置：开启 SQLite 原生 WAL 模式，确保并发读写性能
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");

    this.initSchema();
  }

  /**
   * 初始化数据库表结构。
   */
  private initSchema(): void {
    // DatabaseSync.exec 会逐条执行 SQL 语句
    this.db.exec(SCHEMA_SQL);
  }

  /**
   * 获取底层 DatabaseSync 实例。
   */
  get rawDb(): DatabaseSync {
    return this.db;
  }

  /**
   * 关闭数据库连接。
   */
  close(): void {
    this.db.close();
  }

  /**
   * 开启同步事务（手动控制）。
   */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN TRANSACTION");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
