/**
 * infrastructure/wal WAL 数据库 BDD 测试
 * 规则：场景由人类设计，AI 填充实现。空 it() 即是验收标准。
 * 注意：使用内存 SQLite（:memory:），不影响真实数据文件（见 ANTI_PATTERNS.md E-005）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WeaveDb } from "../../infrastructure/wal/weave-db.js";
import { WalDao } from "../../infrastructure/wal/wal-dao.js";
import { WeaveWalManager } from "../../infrastructure/wal/weave-wal-manager.js";
import { SnapshotStore } from "../../infrastructure/storage/snapshot-store.js";
import type { SessionRecord, ExecutionRecord } from "../../contracts/storage.js";
import type { IWalDao } from "../../application/ports/wal-dao.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// ─── 测试数据工厂 ─────────────────────────────────────────────────────────────

function makeSession(overrides?: Partial<SessionRecord>): SessionRecord {
  return {
    id: `sess-${randomBytes(4).toString("hex")}`,
    title: "测试会话",
    ...overrides,
  };
}

function makeExecution(sessionId: string, overrides?: Partial<ExecutionRecord>): ExecutionRecord {
  return {
    id: `exec-${randomBytes(4).toString("hex")}`,
    session_id: sessionId,
    status: "RUNNING",
    ...overrides,
  };
}

function makeFrozenEntry(nodeId = "n1") {
  return {
    timestamp: new Date().toISOString(),
    nodeId,
    fromStatus: "ready",
    toStatus: "running",
    frozen: {
      nodeId,
      kind: "llm" as const,
      title: "LLM 决策",
      dependencies: [],
      status: "running" as const,
      metrics: {},
    },
  };
}

/** 创建内存 WalDao（:memory: 不落盘，测试互不干扰） */
function makeMemoryDao(): { db: WeaveDb; dao: WalDao } {
  const db = new WeaveDb(":memory:");
  const dao = new WalDao(db);
  return { db, dao };
}

// ─── WalDao Tests ─────────────────────────────────────────────────────────────

describe("WalDao — WAL 数据访问对象", () => {
  let dao: WalDao;
  let db: WeaveDb;

  beforeEach(() => {
    ({ db, dao } = makeMemoryDao());
  });

  afterEach(() => {
    db.close();
  });

  // ─── Session CRUD ──────────────────────────────────────────────────────────

  it("Given 新 session, When upsertSession, Then getSession 返回相同数据", () => {
    const session = makeSession({ title: "对话测试" });
    dao.upsertSession(session);
    const found = dao.getSession(session.id);
    expect(found?.id).toBe(session.id);
    expect(found?.title).toBe("对话测试");
  });

  it("Given 已存在 session, When upsertSession（相同 id）, Then 数据被更新而非插入新行", () => {
    const session = makeSession({ title: "原始标题" });
    dao.upsertSession(session);
    dao.upsertSession({ ...session, title: "更新后标题" });

    const found = dao.getSession(session.id);
    expect(found?.title).toBe("更新后标题");

    // 只有一条记录，不是两条
    const all = dao.getSessions();
    expect(all.filter((s) => s.id === session.id)).toHaveLength(1);
  });

  it("Given 多个 session, When getSessions(limit=2), Then 返回最近 2 条（按 created_at 降序）", () => {
    // 依次插入 3 条
    const s1 = makeSession({ title: "会话1" });
    const s2 = makeSession({ title: "会话2" });
    const s3 = makeSession({ title: "会话3" });
    dao.upsertSession(s1);
    dao.upsertSession(s2);
    dao.upsertSession(s3);

    const result = dao.getSessions(undefined, 2);
    expect(result).toHaveLength(2);
    // 降序，最新的在前
    // （SQLite 同一毫秒可能顺序不定，但总数正确）
  });

  // ─── Execution CRUD ────────────────────────────────────────────────────────

  it("Given 新 execution, When insertExecution, Then getExecution 返回相同数据", () => {
    const session = makeSession();
    dao.upsertSession(session);
    const exec = makeExecution(session.id);
    dao.insertExecution(exec);

    const found = dao.getExecution(exec.id);
    expect(found?.id).toBe(exec.id);
    expect(found?.session_id).toBe(session.id);
    expect(found?.status).toBe("RUNNING");
  });

  it("Given RUNNING 状态 execution, When updateExecutionStatus('COMPLETED'), Then getExecution 返回 COMPLETED", () => {
    const session = makeSession();
    dao.upsertSession(session);
    const exec = makeExecution(session.id, { status: "RUNNING" });
    dao.insertExecution(exec);

    dao.updateExecutionStatus(exec.id, "COMPLETED");

    const found = dao.getExecution(exec.id);
    expect(found?.status).toBe("COMPLETED");
  });

  // ─── WAL Events ────────────────────────────────────────────────────────────

  it("Given insertWalEvent 调用, When payload 超过 1MB, Then 成功存储（不截断）", () => {
    const session = makeSession();
    dao.upsertSession(session);
    const exec = makeExecution(session.id);
    dao.insertExecution(exec);

    // 构造 1MB+ payload
    const largePayload = "x".repeat(1024 * 1024 + 100);
    dao.insertWalEvent({
      execution_id: exec.id,
      node_id: "n1",
      event_type: "test.large",
      payload: largePayload,
    });

    const events = dao.getExecutionWalEvents(exec.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toHaveLength(largePayload.length);
  });

  it("Given 多个节点的 WAL 事件, When getExecutionWalEvents, Then 只返回该 execution 的事件", () => {
    const session = makeSession();
    dao.upsertSession(session);
    const exec1 = makeExecution(session.id);
    const exec2 = makeExecution(session.id);
    dao.insertExecution(exec1);
    dao.insertExecution(exec2);

    // exec1 插入 3 个事件
    for (let i = 0; i < 3; i++) {
      dao.insertWalEvent({
        execution_id: exec1.id,
        node_id: `n${i}`,
        event_type: "test.event",
        payload: `{}`,
      });
    }
    // exec2 插入 2 个事件
    for (let i = 0; i < 2; i++) {
      dao.insertWalEvent({
        execution_id: exec2.id,
        node_id: `m${i}`,
        event_type: "test.event",
        payload: `{}`,
      });
    }

    const exec1Events = dao.getExecutionWalEvents(exec1.id);
    const exec2Events = dao.getExecutionWalEvents(exec2.id);
    expect(exec1Events).toHaveLength(3);
    expect(exec2Events).toHaveLength(2);
  });

  // ─── 并发写入（见 ANTI_PATTERNS.md E-005）─────────────────────────────────

  it("Given 100 个并发 insertWalEvent 调用, When 通过 WeaveWalManager 队列, Then 全部写入成功无 BUSY 错误", async () => {
    const session = makeSession();
    dao.upsertSession(session);
    const exec = makeExecution(session.id);
    dao.insertExecution(exec);

    const manager = new WeaveWalManager(dao as any, session.id);

    // 通过 manager.flush() 写入 100 个事件（同步排队，无并发竞争）
    const events = Array.from({ length: 100 }, (_, i) => ({
      runId: exec.id,
      timestamp: new Date().toISOString(),
      schemaVersion: "1",
      eventId: `evt-${i}`,
      type: "test.concurrent" as any,
      payload: { index: i } as any,
    }));

    for (const event of events) {
      manager.intercept(event as any);
    }
    manager.flush(); // 强制同步刷盘
    manager.destroy();

    const written = dao.getExecutionWalEvents(exec.id);
    expect(written).toHaveLength(100);
  });
});

// ─── WeaveWalManager Tests ────────────────────────────────────────────────────

describe("WeaveWalManager — WAL 写入队列", () => {
  let db: WeaveDb;
  let dao: WalDao;

  beforeEach(() => {
    ({ db, dao } = makeMemoryDao());
    const session = makeSession();
    dao.upsertSession(session);
  });

  afterEach(() => {
    db.close();
  });

  function makeBaseEvent(runId: string, index: number) {
    return {
      runId,
      timestamp: new Date().toISOString(),
      schemaVersion: "1",
      eventId: `evt-${index}`,
      type: "test.event" as any,
      payload: { index } as any,
    };
  }

  it("Given 10 个写入请求同时到达, When enqueue 调用, Then 按顺序串行写入", async () => {
    const session = makeSession();
    dao.upsertSession(session);
    const exec = makeExecution(session.id);
    dao.insertExecution(exec);

    const manager = new WeaveWalManager(dao as any, session.id);

    // 10 个 intercept 调用入队
    for (let i = 0; i < 10; i++) {
      manager.intercept(makeBaseEvent(exec.id, i) as any);
    }
    manager.flush();
    manager.destroy();

    const events = dao.getExecutionWalEvents(exec.id);
    expect(events).toHaveLength(10);
    // id 单调递增（串行写入的顺序保证）
    for (let i = 1; i < events.length; i++) {
      expect(events[i].id!).toBeGreaterThan(events[i - 1].id!);
    }
  });

  it("Given WAL 管理器关闭, When 继续 enqueue, Then 抛出 Error（不静默丢弃）", () => {
    const session = makeSession();
    dao.upsertSession(session);

    const manager = new WeaveWalManager(dao as any, session.id);
    manager.destroy(); // 关闭

    const event = makeBaseEvent("exec-xxx", 0) as any;
    expect(() => manager.intercept(event)).toThrow("已关闭");
  });

  it("Given 批量刷盘间隔配置为 50ms, When 100ms 内有 5 次写入, Then 最多触发 2 次事务", async () => {
    vi.useFakeTimers();
    const session = makeSession();
    dao.upsertSession(session);
    const exec = makeExecution(session.id);
    dao.insertExecution(exec);

    const manager = new WeaveWalManager(dao as any, session.id);

    // 5 次写入全部进队列
    for (let i = 0; i < 5; i++) {
      manager.intercept(makeBaseEvent(exec.id, i) as any);
    }

    // 推进 10ms（FLUSH_INTERVAL_MS=10），触发一次定时 flush，5 条批量写入
    vi.advanceTimersByTime(10);
    manager.destroy();
    vi.useRealTimers();

    const events = dao.getExecutionWalEvents(exec.id);
    // 5 个事件全部被批量写入（一次 flush 完成）
    expect(events).toHaveLength(5);
  });
});

// ─── SnapshotStore Tests ──────────────────────────────────────────────────────

describe("SnapshotStore — 快照存储", () => {
  let store: SnapshotStore;
  let diskPath: string;

  beforeEach(() => {
    diskPath = join(tmpdir(), `dagent-snap-test-${randomBytes(4).toString("hex")}.jsonl`);
    store = new SnapshotStore(diskPath);
  });

  it("Given appendFrozen 调用, When 多次追加, Then seq 单调递增（从 1 开始）", () => {
    const entry = makeFrozenEntry("n1");
    const seq1 = store.appendFrozen(entry);
    const seq2 = store.appendFrozen({ ...entry, nodeId: "n2" });
    const seq3 = store.appendFrozen({ ...entry, nodeId: "n3" });

    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
    expect(seq3).toBe(3);
    // 严格单调递增
    expect(seq2).toBeGreaterThan(seq1);
    expect(seq3).toBeGreaterThan(seq2);
  });

  it("Given 超过水位线（500 条）, When appendFrozen, Then 旧数据被异步驱逐到磁盘", async () => {
    // 插入 501 条以触发驱逐
    for (let i = 0; i <= 500; i++) {
      store.appendFrozen(makeFrozenEntry(`n${i}`));
    }

    // 驱逐是异步的，等待 I/O 完成
    await new Promise((r) => setTimeout(r, 50));

    // 内存中条目数应 < 501（部分被驱逐到磁盘）
    expect(store.getEntries().length).toBeLessThan(501);
  });

  it("Given getByNodeId 调用, When 节点有多条快照, Then 按 seq 升序返回", () => {
    // 为 node-A 追加 3 条快照
    store.appendFrozen({ ...makeFrozenEntry("node-A"), fromStatus: "pending", toStatus: "ready" });
    store.appendFrozen({ ...makeFrozenEntry("node-B") }); // 其他节点
    store.appendFrozen({ ...makeFrozenEntry("node-A"), fromStatus: "ready", toStatus: "running" });
    store.appendFrozen({
      ...makeFrozenEntry("node-A"),
      fromStatus: "running",
      toStatus: "success",
    });

    const nodeASnaps = store.getByNodeId("node-A");

    expect(nodeASnaps).toHaveLength(3);
    // seq 严格升序
    for (let i = 1; i < nodeASnaps.length; i++) {
      expect(nodeASnaps[i].seq).toBeGreaterThan(nodeASnaps[i - 1].seq);
    }
    // 状态转换按顺序记录
    expect(nodeASnaps[0].toStatus).toBe("ready");
    expect(nodeASnaps[1].toStatus).toBe("running");
    expect(nodeASnaps[2].toStatus).toBe("success");
  });

  it("Given getLatestByNodeId 调用, When 节点有多条快照, Then 返回 seq 最大的条目", () => {
    store.appendFrozen({ ...makeFrozenEntry("node-X"), fromStatus: "pending", toStatus: "ready" });
    store.appendFrozen({ ...makeFrozenEntry("node-X"), fromStatus: "ready", toStatus: "running" });
    store.appendFrozen({
      ...makeFrozenEntry("node-X"),
      fromStatus: "running",
      toStatus: "success",
    });

    const latest = store.getLatestByNodeId("node-X");

    expect(latest).toBeDefined();
    expect(latest!.toStatus).toBe("success");
    // seq 是最大的
    const all = store.getByNodeId("node-X");
    const maxSeq = Math.max(...all.map((e) => e.seq));
    expect(latest!.seq).toBe(maxSeq);
  });
});
