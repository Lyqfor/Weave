/**
 * 文件作用：BaseNode 抽象基类 — 所有 DAG 可视化节点的统一父类。
 * 持有唯一状态源（status/startedAt/completedAt/error/metrics），
 * 子类仅提供 kind/title/getSpecificFields/getInputPorts/getOutputPorts。
 *
 * 模板方法 execute() 实现完整控制流：
 *   依赖满足 → 拦截器审批（while 循环 + switch 穷举）→ 业务执行 → 状态收口。
 * 子类通过 doExecute() 实现纯业务逻辑 — 只能 return（成功）或 throw（失败）。
 *
 * toFullPayload() / freezeSnapshot() / hydrateSnapshot() 提供序列化与快照能力。
 */

import type {
  NodeKind,
  NodeStatus,
  NodeMetrics,
  NodeError,
  GraphPort,
  BaseNodePayload
} from "./node-types.js";
import { safeClone } from "./safe-serialize.js";
import { globalBlobStore } from "../blob-store.js";
import type { RunContext } from "../../session/run-context.js";
import type { DagNodeStatus } from "../dag-graph.js";
import type { FrozenSnapshot } from "../snapshot-store.js";

export abstract class BaseNode {
  abstract readonly kind: NodeKind;
  abstract readonly title: string;

  // ── 唯一真相源 ──────────────────────────────────────────────────────────────
  public status: NodeStatus = "pending";
  public startedAt?: string;
  public completedAt?: string;
  public error?: NodeError;
  public metrics: NodeMetrics = {};
  public dependencies: string[] = [];
  public tags?: string[];

  constructor(
    public readonly id: string,
    public readonly parentId?: string
  ) {}

  // ── 子类扩展点 ───────────────────────────────────────────────────────────────

  /** 子类特有字段（不包含基类字段） */
  protected abstract getSpecificFields(): Record<string, unknown>;

  /** 返回输入端口列表（async 以支持 BlobStore 大内容处理） */
  abstract getInputPorts(): Promise<GraphPort[]>;

  /** 返回输出端口列表 */
  abstract getOutputPorts(): Promise<GraphPort[]>;

  // ── 模板方法：统一控制流 ───────────────────────────────────────────────────

  /**
   * 模板方法入口 — 统一驱动：拦截器审批 → 业务执行 → 状态收口。
   * 子类不再覆盖 execute()，而是实现 doExecute()。
   * 容器节点（RepairNode、EscalationNode 等）不注册到 nodeRegistry，不会被调度。
   */
  async execute(ctx: RunContext): Promise<void> {
    try {
      // 1. 依赖满足 → ready
      this.transitionInDag(ctx, "ready", "dependencies-met");

      // 2. 拦截器生命周期 — while 循环 + switch 穷举
      if (ctx.interceptor) {
        let shouldBlock = await ctx.interceptor.shouldIntercept(this, ctx);

        while (shouldBlock) {
          this.transitionInDag(ctx, "blocked", "interceptor-hold");
          const decision = await ctx.interceptor.waitForApproval(this, ctx);

          switch (decision.action) {
            case "abort":
              this.markAborted();
              this.transitionInDag(ctx, "aborted", "interceptor-aborted");
              throw new Error("用户终止执行");

            case "skip":
              await this.onSkipped(ctx);
              this.markSkipped();
              this.transitionInDag(ctx, "skipped", "interceptor-skipped");
              this.emitSnapshot(ctx, "skipped");
              return;

            case "edit":
              // 🛡️ 防御畸形指令：edit 必须携带 editedArgs
              if (!decision.editedArgs) {
                ctx.logger?.warn("interceptor.edit.missing_args", "收到 edit 指令但缺少 editedArgs，打回重审");
                continue;
              }
              {
                const validation = this.validateEditedArgs(decision.editedArgs, ctx);
                if (!validation.ok) {
                  ctx.bus.dispatch("node.validation_error", {
                    nodeId: this.id,
                    errors: validation.errors
                  });
                  continue; // 校验失败，循环回到 waitForApproval
                }
              }
              this.applyEditedArgs(decision.editedArgs);
              shouldBlock = false;
              break;

            case "approve":
              shouldBlock = false;
              break;

            default:
              // 🛡️ 防御未知指令：一律打回重审
              ctx.logger?.warn("interceptor.unknown_action", `未知拦截决策: ${(decision as any).action}，继续挂起`);
              continue;
          }
        }
      }

      // 3. 检查全局 abort signal
      ctx.abortSignal?.throwIfAborted();

      // 4. 正式执行
      this.markRunning();
      this.transitionInDag(ctx, "running", "execution-started");

      // 5. 快照触发：running 状态
      this.emitSnapshot(ctx, "running");

      // 6. 子类纯业务逻辑（只能 return 或 throw）
      await this.doExecute(ctx);

      // 7. doExecute 正常返回 = 成功
      this.markSuccess();
      this.transitionInDag(ctx, "success", "execution-completed");

      // 8. 快照触发：success 状态
      this.emitSnapshot(ctx, "success");

    } catch (error: any) {
      // 识别 Abort 信号 → 内部自降级
      if (error.name === "AbortError" || ctx.abortSignal?.aborted) {
        if (this.status !== "aborted") {
          this.markAborted();
          this.transitionInDag(ctx, "aborted", "execution-aborted-by-engine");
          this.emitSnapshot(ctx, "aborted");
        }
        throw error;
      }

      // 正常业务失败 — 标记节点失败但不 re-throw
      // DAG 调度器会看到节点终态（fail），下游节点仍可继续执行
      // 只有 Abort 信号才需要 re-throw 触发全局熔断
      if (this.status !== "aborted" && this.status !== "skipped") {
        this.markFailed(error);
        this.transitionInDag(ctx, "fail", error.message);
        this.emitSnapshot(ctx, "fail");
      }
    }
  }

  /** 子类实现纯业务逻辑 — 只能 return（成功）或 throw（失败） */
  protected async doExecute(_ctx: RunContext): Promise<void> {
    // 默认空实现：数据容器节点（RepairNode、EscalationNode 等）不需要调度执行
  }

  /** 子类可覆盖：拦截器 skip 时的清理逻辑（Plugin 钩子闭合、写入消息等） */
  protected async onSkipped(_ctx: RunContext): Promise<void> {}

  /** 子类可覆盖：处理拦截器编辑后的参数 */
  protected applyEditedArgs(_args: Record<string, unknown>): void {}

  /** 子类可覆盖：用 Tool Schema 校验编辑参数 */
  protected validateEditedArgs(
    _args: Record<string, unknown>, _ctx: RunContext
  ): { ok: true } | { ok: false; errors: string[] } {
    return { ok: true };
  }

  // ── 状态标记方法 ───────────────────────────────────────────────────────────

  /** 标记节点开始执行 */
  markRunning(): void {
    this.status = "running";
    this.startedAt = new Date().toISOString();
  }

  /** 标记节点成功完成 */
  markSuccess(durationMs?: number): void {
    this.status = "success";
    this.completedAt = new Date().toISOString();
    if (durationMs !== undefined) {
      this.metrics.durationMs = durationMs;
    }
  }

  /** 标记节点失败 */
  markFailed(err: Error | { name: string; message: string; stack?: string }): void {
    this.status = "fail";
    this.completedAt = new Date().toISOString();
    this.error = {
      name: err.name,
      message: err.message,
      stack: "stack" in err ? err.stack : undefined
    };
  }

  /** 标记节点已跳过 */
  markSkipped(): void {
    this.status = "skipped";
    this.completedAt = new Date().toISOString();
  }

  /** 标记节点已中止 */
  markAborted(): void {
    this.status = "aborted";
    this.completedAt = new Date().toISOString();
  }

  // ── DAG 状态流转 ──────────────────────────────────────────────────────────

  /**
   * 更新 DAG 调度图中本节点状态，携带当前快照由 DagGraph 统一广播。
   * 不再直接依赖 weave-emitter — Layer 1 零 agent/ 污染。
   */
  protected transitionInDag(ctx: RunContext, to: DagNodeStatus, reason?: string): void {
    const currentSnapshot = this.freezeSnapshot();
    ctx.dag.transitionStatus(this.id, to, reason, currentSnapshot);
  }

  // ── 快照能力 ───────────────────────────────────────────────────────────────

  /** 🧊 同步冻结 — 纯同步深拷贝，不含 BlobStore I/O，杜绝撕裂态 */
  public freezeSnapshot(): FrozenSnapshot {
    return safeClone({
      nodeId: this.id,
      kind: this.kind,
      title: this.title,
      parentId: this.parentId,
      dependencies: [...this.dependencies],
      status: this.status,
      tags: this.tags,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      error: this.error,
      metrics: { ...this.metrics },
      ...this.getSpecificFields()
    });
  }

  /** 🔧 异步装配 — 补充 Blob 数据（不阻塞主流程） */
  public async hydrateSnapshot(frozen: FrozenSnapshot): Promise<BaseNodePayload> {
    const inputPorts = await this.getInputPorts();
    const outputPorts = await this.getOutputPorts();
    return {
      ...frozen,
      inputPorts: inputPorts.length > 0 ? inputPorts : undefined,
      outputPorts: outputPorts.length > 0 ? outputPorts : undefined
    } as BaseNodePayload;
  }

  /** 触发快照存储（在状态转换关键节点调用） */
  private emitSnapshot(ctx: RunContext, toStatus: string): void {
    if (!ctx.snapshotStore) return;
    const frozen = this.freezeSnapshot();
    const fromStatus = toStatus === "running" ? "ready" : "running";
    const seq = ctx.snapshotStore.appendFrozen({
      timestamp: new Date().toISOString(),
      nodeId: this.id,
      fromStatus,
      toStatus,
      frozen
    });

    // 异步装配不阻塞主流程
    this.hydrateSnapshot(frozen).then(payload => {
      ctx.snapshotStore?.hydrateEntry(seq, payload);
    }).catch(() => {});
  }

  // ── 序列化 ─────────────────────────────────────────────────────────────────

  /**
   * 生成完整 BaseNodePayload 快照。
   * - 收集 inputPorts/outputPorts（经 BlobStore 处理大内容）
   * - 末尾调用 safeClone 生成不可变深拷贝
   */
  async toFullPayload(): Promise<BaseNodePayload> {
    const inputPorts = await this.getInputPorts();
    const outputPorts = await this.getOutputPorts();

    const raw: BaseNodePayload = {
      nodeId: this.id,
      kind: this.kind,
      title: this.title,
      parentId: this.parentId,
      dependencies: this.dependencies.length > 0 ? [...this.dependencies] : undefined,
      status: this.status,
      tags: this.tags,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      error: this.error,
      metrics: Object.keys(this.metrics).length > 0 ? { ...this.metrics } : undefined,
      inputPorts: inputPorts.length > 0 ? inputPorts : undefined,
      outputPorts: outputPorts.length > 0 ? outputPorts : undefined,
      ...this.getSpecificFields()
    };

    return safeClone(raw);
  }

  // ── 受保护辅助方法 ────────────────────────────────────────────────────────────

  /**
   * 将任意内容转换为 GraphPort，自动处理大内容 blobRef。
   */
  protected async makePort(
    name: string,
    type: GraphPort["type"],
    content: unknown
  ): Promise<GraphPort> {
    const stored = await globalBlobStore.store(content);
    return { name, type, content: stored.content, blobRef: stored.blobRef };
  }
}
