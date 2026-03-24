/**
 * 文件作用：SnapshotStore — 同步冻结 + 异步装配的快照存储。
 * 用于回溯和分叉重跑的基础设施。内存水位线控制防 OOM。
 */

import * as fs from "node:fs";
import type { NodeStatus } from "../../core/engine/node-types.js";
import type { BaseNodePayload } from "../../core/engine/node-types.js";

export interface FrozenSnapshot {
  nodeId: string;
  kind: string;
  title: string;
  parentId?: string;
  dependencies: string[];
  status: NodeStatus;
  tags?: string[];
  startedAt?: string;
  completedAt?: string;
  error?: { name: string; message: string; stack?: string };
  metrics: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SnapshotEntry {
  seq: number;
  timestamp: string;
  nodeId: string;
  fromStatus: string;
  toStatus: string;
  frozen: FrozenSnapshot;
  payload?: BaseNodePayload;
}

export class SnapshotStore {
  private entries: SnapshotEntry[] = [];
  private seq = 0;
  private readonly diskPath: string;

  /** OOM 防御：内存水位线控制 */
  private readonly WATERMARK_LIMIT = 500;
  private readonly EVICT_BATCH_SIZE = 100;

  constructor(diskPath: string) {
    this.diskPath = diskPath;
  }

  /** 追加同步冻结的快照条目，返回序列号 */
  appendFrozen(entry: Omit<SnapshotEntry, "seq" | "payload">): number {
    const seq = ++this.seq;
    this.entries.push({ ...entry, seq });

    // 超过水位线 → 异步驱逐旧数据到磁盘
    if (this.entries.length > this.WATERMARK_LIMIT) {
      this.evictToDisk().catch(() => {}); // 驱逐失败不阻断主流程
    }

    return seq;
  }

  /** 异步装配：补充 Blob 数据到已有条目 */
  async hydrateEntry(seq: number, payload: BaseNodePayload): Promise<void> {
    const entry = this.entries.find((e) => e.seq === seq);
    if (entry) entry.payload = payload;
  }

  /**
   * 获取某个时间点的全图状态（仅内存中的快照）。
   * 被驱逐的旧数据需要从 JSONL 文件加载。
   */
  getGraphStateAt(targetSeq: number): Map<string, FrozenSnapshot> {
    const result = new Map<string, FrozenSnapshot>();
    for (const entry of this.entries) {
      if (entry.seq > targetSeq) break;
      result.set(entry.nodeId, entry.frozen);
    }
    return result;
  }

  /** 获取指定节点的最新快照 */
  getLatestSnapshot(nodeId: string): SnapshotEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].nodeId === nodeId) return this.entries[i];
    }
    return undefined;
  }

  /** 获取当前序列号 */
  getCurrentSeq(): number {
    return this.seq;
  }

  /** 获取所有内存中的条目（只读） */
  getEntries(): readonly SnapshotEntry[] {
    return this.entries;
  }

  /** ISnapshotStore 兼容：获取所有内存中的条目（可写副本） */
  getAll(): SnapshotEntry[] {
    return [...this.entries];
  }

  /** ISnapshotStore 兼容：获取指定节点的所有快照（按 seq 升序） */
  getByNodeId(nodeId: string): SnapshotEntry[] {
    return this.entries.filter((e) => e.nodeId === nodeId);
  }

  /** ISnapshotStore 兼容：获取指定节点的最新快照 */
  getLatestByNodeId(nodeId: string): SnapshotEntry | undefined {
    return this.getLatestSnapshot(nodeId);
  }

  /** 确保磁盘路径的父目录存在 */
  private async ensureDir(): Promise<void> {
    const dir =
      this.diskPath.substring(0, this.diskPath.lastIndexOf("/")) ||
      this.diskPath.substring(0, this.diskPath.lastIndexOf("\\"));
    if (dir) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  /** 内存驱逐：切割最旧的数据批量写入 JSONL，释放 V8 内存 */
  private async evictToDisk(): Promise<void> {
    await this.ensureDir();
    const chunk = this.entries.splice(0, this.EVICT_BATCH_SIZE);
    const lines = chunk.map((c) => JSON.stringify(c)).join("\n") + "\n";
    await fs.promises.appendFile(this.diskPath, lines);
  }

  /** 完整落盘（会话结束时调用） */
  async flush(): Promise<void> {
    if (this.entries.length === 0) return;
    await this.ensureDir();
    const lines = this.entries.map((c) => JSON.stringify(c)).join("\n") + "\n";
    await fs.promises.appendFile(this.diskPath, lines);
    this.entries.length = 0;
  }
}
