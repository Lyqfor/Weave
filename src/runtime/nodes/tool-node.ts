/**
 * 文件作用：ToolNode — 表示一次工具调用节点。
 * doExecute() 内部包含完整重试链，try/finally 保证 Plugin 生命周期闭合。
 * Step Gate 审批已抽离到 BaseNode 模板方法 + INodeInterceptor。
 * doExecute() 只能 return（成功）或 throw（失败），状态由模板方法收口。
 */

import type { NodeKind, GraphPort } from "./node-types.js";
import { BaseNode } from "./base-node.js";
import { RepairNode } from "./repair-node.js";
import { EscalationNode } from "./escalation-node.js";
import type { RunContext } from "../../session/run-context.js";
import { executeToolWithTimeout } from "../../agent/tool-executor.js";
import { repairToolArgsByIntent } from "../../agent/tool-executor.js";
import { summarizeText, safeJsonStringify } from "../../utils/text-utils.js";
import type { ToolExecuteResult } from "../../tools/tool-types.js";

export interface ToolNodeInit {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  /** LLM 输出文本（thinking），用作工具意图说明 */
  intent?: string;
  maxRetries: number;
  step: number;
  currentAttempt?: number;
}

export class ToolNode extends BaseNode {
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
    args: Record<string, unknown>, ctx: RunContext
  ): { ok: true } | { ok: false; errors: string[] } {
    const toolDef = ctx.toolRegistry.resolve(this.toolName);
    if (!toolDef?.inputSchema) return { ok: true };

    // 基础类型校验：检查 required 字段
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

  /** 拦截器 skip 时：闭合 Plugin 钩子 + 写入 workingMessages */
  protected async onSkipped(ctx: RunContext): Promise<void> {
    const effectiveArgs = this.getEffectiveArgs();
    const skipResult = { ok: false, content: "[SKIPPED by approval gate]", metadata: { skippedByUser: true } };

    for (const plugin of ctx.plugins) {
      const output = await plugin.beforeToolExecution?.({
        ...ctx.basePluginContext,
        step: this.step,
        toolName: this.toolName,
        toolCallId: this.toolCallId,
        args: effectiveArgs,
        intentSummary: this.intent,
        attempt: 1,
        maxRetries: 0
      });
      ctx.bus.dispatchPluginOutput(output);
    }
    for (const plugin of ctx.plugins) {
      try {
        const output = await plugin.afterToolExecution?.({
          ...ctx.basePluginContext,
          step: this.step,
          toolName: this.toolName,
          toolCallId: this.toolCallId,
          args: effectiveArgs,
          result: skipResult,
          intentSummary: this.intent,
          attempt: 1,
          totalAttempts: 1,
          wasRepaired: false,
          allFailed: true
        });
        ctx.bus.dispatchPluginOutput(output);
      } catch (pluginError) {
        ctx.logger?.warn("plugin.after_tool.error", `Plugin afterToolExecution 异常: ${pluginError}`);
      }
    }

    ctx.bus.dispatch("tool.execution.end", {
      sessionId: ctx.sessionId,
      turnIndex: ctx.turnIndex,
      toolName: this.toolName,
      toolCallId: this.toolCallId,
      toolOk: false,
      toolStatus: "fail",
      toolResultText: "[SKIPPED]"
    });

    ctx.workingMessages.push({
      role: "tool",
      tool_call_id: this.toolCallId,
      content: JSON.stringify(skipResult)
    });

    this.setResult(false, "[SKIPPED by approval gate]");
  }

  /**
   * 纯业务逻辑 — try/finally 保证 Plugin 生命周期闭合。
   * 成功 return，失败 throw，状态由 BaseNode 模板方法收口。
   */
  protected async doExecute(ctx: RunContext): Promise<void> {
    let effectiveArgs = this.getEffectiveArgs();
    let finalResult: ToolExecuteResult | undefined;
    let attempt = 1;
    let executionError: Error | undefined;

    const totalAttempts = this.maxRetries + 1;

    const pluginCtx = {
      ...ctx.basePluginContext,
      step: this.step,
      toolName: this.toolName,
      toolCallId: this.toolCallId,
      args: effectiveArgs,
      intentSummary: this.intent,
      attempt: 1,
      maxRetries: this.maxRetries
    };

    ctx.bus.dispatch("tool.execution.start", {
      sessionId: ctx.sessionId,
      turnIndex: ctx.turnIndex,
      toolName: this.toolName,
      toolCallId: this.toolCallId,
      toolArgsText: summarizeText(effectiveArgs),
      toolArgsJsonText: safeJsonStringify(effectiveArgs)
    });

    // 🛡️ before 钩子
    for (const p of ctx.plugins) {
      const output = await p.beforeToolExecution?.({
        ...pluginCtx,
        args: effectiveArgs
      });
      ctx.bus.dispatchPluginOutput(output);
    }

    try {
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
          sessionId: ctx.sessionId
        },
        ctx.logger
      );

      let prevNodeId = this.id;

      // 重试循环（保留在内部）
      while (!finalResult.ok && attempt <= this.maxRetries) {
        ctx.abortSignal?.throwIfAborted();

        ctx.bus.dispatch("tool.retry.start", {
          sessionId: ctx.sessionId,
          turnIndex: ctx.turnIndex,
          toolName: this.toolName,
          toolCallId: this.toolCallId,
          retryAttempt: attempt,
          retryMax: this.maxRetries,
          retryReason: summarizeText(finalResult.content)
        });

        // 创建 RepairNode（加入 DAG 可视化，已完成态，外部调度器不会调度）
        const repairNode = new RepairNode(`repair-${this.id}-${attempt}`, {
          lastError: summarizeText(finalResult.content, 300),
          originalArgs: effectiveArgs
        }, this.id);
        repairNode.markRunning();

        // LLM 修复参数
        const repairResult = await repairToolArgsByIntent(
          {
            toolName: this.toolName,
            intentSummary: this.intent,
            previousArgs: effectiveArgs,
            lastResult: summarizeText(finalResult.content, 300)
          },
          "",
          (input) => ctx.llmClient.chat({
            systemPrompt: input.systemPrompt,
            userMessage: input.userMessage,
            historyMessages: []
          })
        );

        const repairedArgs = (repairResult.repairedArgs ?? effectiveArgs) as Record<string, unknown>;
        repairNode.setRepaired(repairedArgs);
        ctx.dag.addNode({ id: repairNode.id, type: "repair", status: "success" }, repairNode.freezeSnapshot());
        ctx.dag.addEdge(prevNodeId, repairNode.id);
        prevNodeId = repairNode.id;

        ctx.bus.dispatch("tool.retry.end", {
          sessionId: ctx.sessionId,
          turnIndex: ctx.turnIndex,
          toolName: this.toolName,
          toolCallId: this.toolCallId,
          retryAttempt: attempt,
          retryMax: this.maxRetries,
          retryPrepared: repairResult.repairedArgs !== null
        });

        effectiveArgs = repairedArgs;
        attempt++;

        // 重试前的 before 钩子
        for (const p of ctx.plugins) {
          const output = await p.beforeToolExecution?.({
            ...pluginCtx,
            args: effectiveArgs,
            attempt,
            previousError: summarizeText(finalResult.content, 300),
            repairedFrom: { ...this.args }
          });
          ctx.bus.dispatchPluginOutput(output);
        }

        finalResult = await executeToolWithTimeout(
          ctx.toolRegistry,
          {
            toolName: this.toolName,
            args: effectiveArgs,
            timeoutMs: ctx.defaultToolTimeoutMs,
            runId: ctx.runId,
            step: this.step,
            toolCallId: this.toolCallId,
            sessionId: ctx.sessionId
          },
          ctx.logger
        );

        // 创建 RetryToolNode 记录本次重试结果（可视化用，外部调度器不会调度）
        const retryNode = new ToolNode(`retry-${this.id}-${attempt}`, {
          toolName: this.toolName,
          toolCallId: this.toolCallId,
          args: effectiveArgs,
          intent: this.intent,
          maxRetries: 0,
          step: this.step,
          currentAttempt: attempt
        }, this.id);
        retryNode.markRunning();
        retryNode.setResult(finalResult.ok, finalResult.content);
        if (finalResult.ok) {
          retryNode.markSuccess();
        } else {
          retryNode.markFailed({ name: "ToolError", message: String(finalResult.content) });
        }
        const retryStatus = finalResult.ok ? "success" : "fail";
        ctx.dag.addNode({ id: retryNode.id, type: "tool", status: retryStatus }, retryNode.freezeSnapshot());
        ctx.dag.addEdge(prevNodeId, retryNode.id);
        prevNodeId = retryNode.id;
      }

      // 重试耗尽仍失败 → 添加 EscalationNode（可视化）
      if (!finalResult.ok && this.maxRetries > 0) {
        ctx.bus.dispatch("tool.retry.end", {
          sessionId: ctx.sessionId,
          turnIndex: ctx.turnIndex,
          toolName: this.toolName,
          toolCallId: this.toolCallId,
          retryAttempt: attempt,
          retryMax: this.maxRetries,
          retryPrepared: false,
          retryReason: "重试次数已耗尽"
        });

        // 不需要真正的 EscalationNode 实例了，直接在 DAG 上显示失败节点
        // const escalNode = new EscalationNode(`escalation-${this.id}`, this.toolName, this.id);
        // ctx.dag.addNode({ id: escalNode.id, type: "escalation", status: "fail" });
        // ctx.dag.addEdge(prevNodeId, escalNode.id);
      }
    } catch (error: any) {
      executionError = error;
      throw error; // 继续抛给 BaseNode 模板方法
    } finally {
      // 🛡️ 无论成功、失败还是 Abort，after 钩子绝对执行！
      // 确保监控系统的 Span 被正确闭合，不留悬空 Trace
      for (const p of ctx.plugins) {
        try {
          const output = await p.afterToolExecution?.({
            ...pluginCtx,
            args: effectiveArgs,
            result: finalResult ?? { ok: false, content: executionError?.message ?? "unknown" },
            attempt,
            totalAttempts,
            wasRepaired: attempt > 1,
            allFailed: finalResult ? !finalResult.ok : true
          });
          ctx.bus.dispatchPluginOutput(output);
        } catch (pluginError) {
          // Plugin 自身异常不应阻断主流程
          ctx.logger?.warn("plugin.after_tool.error", `Plugin afterToolExecution 异常: ${pluginError}`);
        }
      }

      ctx.bus.dispatch("tool.execution.end", {
        sessionId: ctx.sessionId,
        turnIndex: ctx.turnIndex,
        toolName: this.toolName,
        toolCallId: this.toolCallId,
        toolOk: finalResult?.ok ?? false,
        toolStatus: finalResult?.ok ? "success" : "fail",
        toolResultText: summarizeText(finalResult?.content ?? executionError?.message ?? "unknown")
      });

      // 写入 workingMessages + stateStore（无论成功失败都需要）
      if (finalResult) {
        ctx.workingMessages.push({
          role: "tool",
          tool_call_id: this.toolCallId,
          content: JSON.stringify({
            ok: finalResult.ok,
            content: finalResult.content,
            metadata: { ...(finalResult.metadata ?? {}), attempt }
          })
        });
        this.setResult(finalResult.ok, finalResult.content);
        ctx.stateStore.setNodeOutput(this.id, {
          ok: finalResult.ok,
          content: finalResult.content,
          metadata: { ...(finalResult.metadata ?? {}), attempt }
        });
      }
    }

    // 决定 return 或 throw — 模板方法接管状态
    if (finalResult?.ok) {
      return; // → BaseNode markSuccess
    } else {
      throw new ToolExecutionError(
        String(finalResult?.content ?? "工具执行异常")
      );
    }
  }

  protected getSpecificFields(): Record<string, unknown> {
    return {
      toolName: this.toolName,
      intentSummary: this.intent,
      toolGoal: "",
      maxRetries: this.maxRetries,
      currentAttempt: this.currentAttempt
    };
  }

  async getInputPorts(): Promise<GraphPort[]> {
    const ports: GraphPort[] = [
      await this.makePort("args", "json", this.args)
    ];
    if (this.intent) {
      ports.push({ name: "intent", type: "text", content: this.intent });
    }
    return ports;
  }

  async getOutputPorts(): Promise<GraphPort[]> {
    if (this.resultContent === undefined) return [];
    const type = typeof this.resultContent === "string" ? "text" : "json";
    return [await this.makePort("result", type, this.resultContent)];
  }
}

/** 工具执行失败错误（doExecute 内部抛出，BaseNode 模板方法捕获） */
class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionError";
  }
}
