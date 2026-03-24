import type { IWalDao } from "../../application/ports/wal-dao.js";
import type { AgentRunEvent } from "../../domain/event/event-types.js";
import { stringify, parse } from "flatted";

/**
 * 文件作用：WeaveWalManager — 预写式日志管理器（拦截器层）。
 * 负责事件的微批处理、黑板分离、深拷贝防守及持久化。
 */
export class WeaveWalManager {
  private eventQueue: AgentRunEvent[] = [];
  private timer: NodeJS.Timeout;
  private closed = false;
  private readonly BATCH_SIZE = 50;
  private readonly FLUSH_INTERVAL_MS = 10;

  constructor(
    private readonly dao: IWalDao,
    private readonly sessionId: string
  ) {
    // 1. 初始化定时刷盘，使用 unref 避免阻止进程正常退出
    this.timer = setInterval(() => this.flush(), this.FLUSH_INTERVAL_MS).unref();

    // 2. 顶级架构设计：优雅停机，确保 SIGINT/SIGTERM 时强制落盘
    this.setupGracefulShutdown();
  }

  /**
   * 核心拦截方法：WeaveEventBus 会在广播前调用此方法。
   */
  public intercept(event: AgentRunEvent): AgentRunEvent {
    if (this.closed) {
      throw new Error("WeaveWalManager 已关闭，拒绝写入新事件");
    }
    // 🛡️ 防守型深拷贝，避免污染原始事件和内存总线
    const eventCopy: AgentRunEvent = {
      ...event,
      payload: event.payload ? parse(stringify(event.payload)) : undefined,
    };

    // 1. 自动维护拓扑边
    this.handleTopology(eventCopy);

    // 2. 黑板剥离
    const processedEvent = this.extractToBlackboard(eventCopy);

    // 3. 进入写入队列
    this.eventQueue.push(processedEvent);
    if (this.eventQueue.length >= this.BATCH_SIZE) {
      this.flush();
    }

    return processedEvent;
  }

  private handleTopology(event: AgentRunEvent): void {
    if (event.type === "engine.edge.created") {
      const p = event.payload;
      this.dao.insertEdge(event.runId, p.fromId, p.toId, p.kind);
    }
  }

  private extractToBlackboard(event: AgentRunEvent): AgentRunEvent {
    const p = event.payload;
    if (!p) return event;

    // 👑 升级为递归扫描模式，不再局限于特定字段名
    this.recursiveDehydrate(p, event.runId);

    return event;
  }

  /**
   * 递归脱水：发现长文本 -> 写入黑板 -> 替换为引用
   */
  private recursiveDehydrate(obj: any, runId: string): void {
    if (!obj || typeof obj !== "object") return;

    for (const key in obj) {
      const val = obj[key];

      // 只有长度超过 200 字符的才进黑板
      if (typeof val === "string" && val.length > 200 && !val.startsWith("[[REF:bb_")) {
        const blackboardId = `bb_${runId}_${Date.now()}_${key}`;

        // 立即同步写入黑板
        this.dao.insertBlackboardMessage(
          blackboardId,
          this.sessionId,
          "content", // 默认角色
          val
        );

        // 替换为引用指针
        obj[key] = `[[REF:${blackboardId}]]`;
      } else if (typeof val === "object" && val !== null) {
        this.recursiveDehydrate(val, runId);
      }
    }
  }

  /**
   * 将缓存中的事件批量刷入 SQLite 事务。
   */
  public flush(): void {
    if (this.eventQueue.length === 0) return;

    const events = [...this.eventQueue];
    this.eventQueue = [];

    try {
      for (const e of events) {
        // 🛡️ 类型安全地提取 nodeId
        const payload = e.payload as any;
        const nodeId =
          payload && typeof payload === "object" && "nodeId" in payload
            ? String(payload.nodeId)
            : null;

        this.dao.insertWalEvent({
          execution_id: e.runId,
          node_id: nodeId,
          event_type: e.type,
          payload: stringify(e.payload),
        });
      }
    } catch (err) {
      // 🛡️ 发生异常时，将数据放回队首，避免静默丢失
      this.eventQueue.unshift(...events);
      console.error("[WeaveWalManager] Flush WAL failed:", err);
    }
  }

  private setupGracefulShutdown(): void {
    // handler 和 signal 参数保留用于潜在的日志扩展，暂时不使用
    const _handler = (_signal: string) => {
      this.flush();
    };
    // 使用 once 确保只执行一次，且不阻塞系统默认行为
    process.once("SIGINT", () => {
      this.flush();
      process.exit(0);
    });
    process.once("SIGTERM", () => {
      this.flush();
      process.exit(0);
    });
  }

  /**
   * 手动关闭（供 AgentRuntime 调用）。关闭后拒绝接收新事件。
   */
  public destroy(): void {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.flush();
  }
}
