/**
 * 文件作用：ToolNode — 表示一次工具调用节点。
 * doExecute() 内部包含完整重试链。
 * Step Gate 审批已抽离到 BaseNode 模板方法 + INodeInterceptor。
 * doExecute() 只能 return（成功）或 throw（失败），状态由模板方法收口。
 *
 * 🛡️ 架构师建议：彻底静默节点。物理抹除所有 ctx.bus.dispatch 和插件调用。
 * 业务语义（如 onToolStart）由 Layer 3 插件管家监听物理状态变更推断。
 */

import type { NodeKind, GraphPort } from "../../core/engine/node-types.js";
import { BaseNode } from "./base-node.js";
import { RepairNode } from "./repair-node.js";
import type { IAgentNodeContext } from "../../contracts/agent.js";
import type { ToolExecuteResult } from "../../contracts/agent.js";
import { executeToolWithTimeout, repairToolArgsByIntent } from "../../core/utils/tool-executor.js";
import { summarizeText } from "../../core/utils/text-utils.js";

export interface ToolNodeInit {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  /** 工具意图说明 */
  intent?: string;
  maxRetries: number;
  step: number;
  currentAttempt?: number;
}

export class ToolNode extends BaseNode<IAgentNodeContext> {
  readonly kind: NodeKind = "tool";

  public readonly toolName: string;
  public readonly toolCallId: string;
  public readonly maxRetries: number;
  public readonly step: number;
  public currentAttempt: number;

  private readonly args: Record<string, unknown>;
  private effectiveArgs?: Record<string, unknown>;
  private readonly intent: string;
  private resultContent?: unknown;
  private resultOk?: boolean;

  constructor(id: string, init: ToolNodeInit, parentId?: string) {
    super(id, parentId);
    this.toolName = init.toolName;
    this.toolCallId = init.toolCallId;
    this.args = init.args;
    this.intent = init.intent ?? "";
    this.maxRetries = init.maxRetries;
    this.step = init.step;
    this.currentAttempt = init.currentAttempt ?? 1;
  }

  get title(): string {
    return this.intent ? this.intent.slice(0, 60) : this.toolName;
  }

  /** 获取有效参数（可能被拦截器编辑过） */
  getEffectiveArgs(): Record<string, unknown> {
    return this.effectiveArgs ?? { ...this.args };
  }

  /** 设置工具执行结果（外部或内部调用） */
  setResult(ok: boolean, content?: unknown): void {
    this.resultOk = ok;
    this.resultContent = content;
  }

  /** 子类可覆盖：校验拦截器编辑后的参数 */
  protected validateEditedArgs(
    args: Record<string, unknown>,
    ctx: IAgentNodeContext
  ): { ok: true } | { ok: false; errors: string[] } {
    const toolDef = ctx.toolRegistry.resolve(this.toolName);
    if (!toolDef?.inputSchema) return { ok: true };

    const schema = toolDef.inputSchema as Record<string, unknown>;
    const required = (schema.required ?? []) as string[];
    const errors: string[] = [];
    for (const field of required) {
      if (args[field] === undefined || args[field] === null) {
        errors.push(`${field}: 必填字段缺失`);
      }
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true };
  }

  /** 子类可覆盖：应用拦截器编辑后的参数 */
  protected applyEditedArgs(args: Record<string, unknown>): void {
    this.effectiveArgs = args;
  }

  /** 拦截器 skip 时：写入 workingMessages */
  protected async onSkipped(ctx: IAgentNodeContext): Promise<void> {
    const skipResult = {
      ok: false,
      content: "[SKIPPED by approval gate]",
      metadata: { skippedByUser: true },
    };

    ctx.bus.dispatch("tool.execution.end", {
      sessionId: ctx.sessionId,
      turnIndex: ctx.turnIndex,
      nodeId: this.id,
      toolName: this.toolName,
      toolCallId: this.toolCallId,
      toolStatus: "fail",
      toolOk: false,
      toolResultText: String(skipResult.content),
    });

    ctx.workingMessages.push({
      role: "tool",
      tool_call_id: this.toolCallId,
      content: JSON.stringify(skipResult),
    });

    this.setResult(false, "[SKIPPED by approval gate]");
  }

  /**
   * 纯业务逻辑 — 成功 return，失败 throw，状态由 BaseNode 模板方法收口。
   */
  protected async doExecute(ctx: IAgentNodeContext): Promise<void> {
    let effectiveArgs = this.getEffectiveArgs();
    let finalResult: ToolExecuteResult | undefined;
    let attempt = 1;
    let executionError: Error | undefined;

    try {
      ctx.bus.dispatch("tool.execution.start", {
        sessionId: ctx.sessionId,
        turnIndex: ctx.turnIndex,
        nodeId: this.id,
        toolName: this.toolName,
        toolCallId: this.toolCallId,
        toolArgsText: summarizeText(effectiveArgs),
      });

      // 第一次执行
      finalResult = await executeToolWithTimeout(
        ctx.toolRegistry,
        {
          toolName: this.toolName,
          args: effectiveArgs,
          timeoutMs: ctx.defaultToolTimeoutMs,
          runId: ctx.runId,
          step: this.step,
          toolCallId: this.toolCallId,
          sessionId: ctx.sessionId,
        },
        ctx.logger
      );

      let prevNodeId = this.id;

      // 重试循环
      while (!finalResult.ok && attempt <= this.maxRetries) {
        ctx.abortSignal?.throwIfAborted();

        // 创建 RepairNode（可视化）
        const repairNode = new RepairNode(
          `repair-${this.id}-${attempt}`,
          {
            lastError: summarizeText(finalResult.content, 300),
            originalArgs: effectiveArgs,
          },
          this.id
        );
        repairNode.markRunning();

        // LLM 修复参数
        const repairResult = await repairToolArgsByIntent(
          {
            toolName: this.toolName,
            intentSummary: this.intent,
            previousArgs: effectiveArgs,
            lastResult: summarizeText(finalResult.content, 300),
          },
          "",
          (input) =>
            ctx.llmClient.chat({
              systemPrompt: input.systemPrompt,
              userMessage: input.userMessage,
              historyMessages: [],
              abortSignal: input.abortSignal,
            }),
          ctx.abortSignal
        );

        const repairedArgs = (repairResult.repairedArgs ?? effectiveArgs) as Record<
          string,
          unknown
        >;
        repairNode.setRepaired(repairedArgs);
        ctx.dag.addNode(
          { id: repairNode.id, type: "repair", status: "success" },
          repairNode.freezeSnapshot()
        );
        ctx.dag.addEdge(prevNodeId, repairNode.id);
        repairNode.broadcastIo(ctx);
        prevNodeId = repairNode.id;

        effectiveArgs = repairedArgs;
        attempt++;

        finalResult = await executeToolWithTimeout(
          ctx.toolRegistry,
          {
            toolName: this.toolName,
            args: effectiveArgs,
            timeoutMs: ctx.defaultToolTimeoutMs,
            runId: ctx.runId,
            step: this.step,
            toolCallId: this.toolCallId,
            sessionId: ctx.sessionId,
          },
          ctx.logger
        );

        // 创建 Retry 记录（可视化）
        const retryNode = new ToolNode(
          `retry-${this.id}-${attempt}`,
          {
            toolName: this.toolName,
            toolCallId: this.toolCallId,
            args: effectiveArgs,
            intent: this.intent,
            maxRetries: 0,
            step: this.step,
            currentAttempt: attempt,
          },
          this.id
        );
        retryNode.markRunning();
        retryNode.setResult(finalResult.ok, finalResult.content);
        if (finalResult.ok) {
          retryNode.markSuccess();
        } else {
          retryNode.markFailed({ name: "ToolError", message: String(finalResult.content) });
        }
        const retryStatus = finalResult.ok ? "success" : "fail";
        ctx.dag.addNode(
          { id: retryNode.id, type: "tool", status: retryStatus },
          retryNode.freezeSnapshot()
        );
        ctx.dag.addEdge(prevNodeId, retryNode.id);
        retryNode.broadcastIo(ctx);
        prevNodeId = retryNode.id;
      }
    } catch (error: any) {
      executionError = error;
      throw error;
    } finally {
      // 写入 workingMessages + stateStore
      if (finalResult) {
        ctx.workingMessages.push({
          role: "tool",
          tool_call_id: this.toolCallId,
          content: JSON.stringify({
            ok: finalResult.ok,
            content: finalResult.content,
            metadata: { ...(finalResult.metadata ?? {}), attempt },
          }),
        });
        this.setResult(finalResult.ok, finalResult.content);
        ctx.stateStore.setNodeOutput(this.id, {
          ok: finalResult.ok,
          content: finalResult.content,
          metadata: { ...(finalResult.metadata ?? {}), attempt },
        });
      }

      ctx.bus.dispatch("tool.execution.end", {
        sessionId: ctx.sessionId,
        turnIndex: ctx.turnIndex,
        nodeId: this.id,
        toolName: this.toolName,
        toolCallId: this.toolCallId,
        toolStatus: finalResult?.ok ? "success" : "fail",
        toolOk: finalResult?.ok ?? false,
        toolResultText: String(finalResult?.content ?? executionError?.message ?? "工具执行异常"),
      });
    }

    if (finalResult?.ok) {
      return;
    } else {
      throw new ToolExecutionError(String(finalResult?.content ?? "工具执行异常"));
    }
  }

  protected getSpecificFields(): Record<string, unknown> {
    return {
      toolName: this.toolName,
      intentSummary: this.intent,
      toolGoal: "",
      maxRetries: this.maxRetries,
      currentAttempt: this.currentAttempt,
    };
  }

  async getInputPorts(ctx: IAgentNodeContext): Promise<GraphPort[]> {
    const ports: GraphPort[] = [await this.makePort(ctx, "args", "json", this.args)];
    if (this.intent) {
      ports.push({ name: "intent", type: "text", content: this.intent });
    }
    return ports;
  }

  async getOutputPorts(ctx: IAgentNodeContext): Promise<GraphPort[]> {
    if (this.resultContent === undefined) return [];
    const type = typeof this.resultContent === "string" ? "text" : "json";
    return [await this.makePort(ctx, "result", type, this.resultContent)];
  }
}

class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionError";
  }
}
