/**
 * 文件作用：ToolNode — 表示一次工具调用节点，execute() 内部包含完整重试链。
 * 重试过程中动态创建 RepairNode 和 retry ToolNode 作为可视化子节点（已在 execute() 内完成，外部调度器不介入）。
 * inputPorts: args（json）+ intent（text）
 * outputPorts: result（json/text）
 */

import type { NodeKind, GraphPort } from "./node-types.js";
import { BaseNode } from "./base-node.js";
import { RepairNode } from "./repair-node.js";
import { EscalationNode } from "./escalation-node.js";
import type { RunContext } from "../../session/run-context.js";
import { executeToolWithTimeout } from "../../agent/tool-executor.js";
import { repairToolArgsByIntent } from "../../agent/tool-executor.js";
import { summarizeText, safeJsonStringify } from "../../utils/text-utils.js";

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

  /** 设置工具执行结果（外部或内部调用） */
  setResult(ok: boolean, content?: unknown): void {
    this.resultOk = ok;
    this.resultContent = content;
  }

  async execute(ctx: RunContext): Promise<void> {
    this.markRunning();
    this.transitionInDag(ctx, "running", "scheduler-picked");

    let effectiveArgs = { ...this.args };
    let skipByApproval = false;

    // ── StepGate 审批 ────────────────────────────────────────────────────────
    if (ctx.stepGate.enabled && ctx.stepGate.approveToolCall) {
      this.transitionInDag(ctx, "blocked", "waiting-user-approval");
      ctx.bus.dispatch("node.pending_approval", {
        sessionId: ctx.sessionId,
        turnIndex: ctx.turnIndex,
        toolName: this.toolName,
        toolCallId: this.toolCallId,
        toolArgsText: summarizeText(effectiveArgs),
        toolArgsJsonText: safeJsonStringify(effectiveArgs)
      });

      const decision = await ctx.stepGate.approveToolCall({
        runId: ctx.runId,
        step: this.step,
        toolName: this.toolName,
        toolCallId: this.toolCallId,
        args: effectiveArgs,
        argsText: safeJsonStringify(effectiveArgs)
      });

      if (decision.action === "abort") {
        ctx.bus.dispatch("node.approval.resolved", {
          sessionId: ctx.sessionId,
          turnIndex: ctx.turnIndex,
          toolName: this.toolName,
          toolCallId: this.toolCallId,
          approvalAction: "abort"
        });
        this.markAborted();
        this.transitionInDag(ctx, "aborted", "approval-aborted");
        throw new Error("用户终止了当前回合执行");
      }

      if (decision.action === "edit" && decision.editedArgs !== undefined) {
        effectiveArgs =
          decision.editedArgs && typeof decision.editedArgs === "object"
            ? (decision.editedArgs as Record<string, unknown>)
            : {};
      }

      if (decision.action === "skip") {
        skipByApproval = true;
      }

      ctx.bus.dispatch("node.approval.resolved", {
        sessionId: ctx.sessionId,
        turnIndex: ctx.turnIndex,
        toolName: this.toolName,
        toolCallId: this.toolCallId,
        approvalAction: decision.action,
        toolArgsText: summarizeText(effectiveArgs),
        toolArgsJsonText: safeJsonStringify(effectiveArgs)
      });
    }

    // ── Skip 处理 ────────────────────────────────────────────────────────────
    if (skipByApproval) {
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
      this.markSkipped();
      this.transitionInDag(ctx, "skipped", "approval-skipped");
      return;
    }

    // ── 恢复执行（审批通过 blocked → running） ──────────────────────────────
    if (ctx.stepGate.enabled && ctx.stepGate.approveToolCall) {
      this.transitionInDag(ctx, "running", "approval-resumed");
    }

    ctx.bus.dispatch("tool.execution.start", {
      sessionId: ctx.sessionId,
      turnIndex: ctx.turnIndex,
      toolName: this.toolName,
      toolCallId: this.toolCallId,
      toolArgsText: summarizeText(effectiveArgs),
      toolArgsJsonText: safeJsonStringify(effectiveArgs)
    });

    const totalAttempts = this.maxRetries + 1;

    for (const plugin of ctx.plugins) {
      const output = await plugin.beforeToolExecution?.({
        ...ctx.basePluginContext,
        step: this.step,
        toolName: this.toolName,
        toolCallId: this.toolCallId,
        args: effectiveArgs,
        intentSummary: this.intent,
        attempt: 1,
        maxRetries: this.maxRetries
      });
      ctx.bus.dispatchPluginOutput(output);
    }

    // ── 第一次执行（ToolNode 本身即是第一次尝试，不创建子节点） ────────────
    let finalResult = await executeToolWithTimeout(
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
    let attempt = 1;
    let prevNodeId = this.id; // 修复链的依赖锚点

    // ── 失败时依次创建 RepairNode 并重试 ────────────────────────────────────
    // 每次循环：当前执行失败 → 创建 RepairNode 修复参数 → 重新执行工具
    while (!finalResult.ok && attempt <= this.maxRetries) {
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
        ctx.memoryStore.buildSystemPrompt(ctx.systemPrompt),
        (input) => ctx.llmClient.chat({
          systemPrompt: input.systemPrompt,
          userMessage: input.userMessage,
          historyMessages: []
        })
      );

      const repairedArgs = (repairResult.repairedArgs ?? effectiveArgs) as Record<string, unknown>;
      repairNode.setRepaired(repairedArgs);
      // RepairNode 以 success 状态加入 DAG（外部调度器不会再调度它）
      ctx.dag.addNode({ id: repairNode.id, type: "repair", status: "success" });
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

      // 用修复后的参数重新执行工具
      for (const plugin of ctx.plugins) {
        const output = await plugin.beforeToolExecution?.({
          ...ctx.basePluginContext,
          step: this.step,
          toolName: this.toolName,
          toolCallId: this.toolCallId,
          args: effectiveArgs,
          intentSummary: this.intent,
          attempt,
          maxRetries: this.maxRetries,
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
      ctx.dag.addNode({ id: retryNode.id, type: "tool", status: retryStatus });
      ctx.dag.addEdge(prevNodeId, retryNode.id);
      prevNodeId = retryNode.id;
    }

    // ── 重试耗尽仍失败 → 添加 EscalationNode（可视化） ──────────────────────
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

      const escalNode = new EscalationNode(`escalation-${this.id}`, this.toolName, this.id);
      ctx.dag.addNode({ id: escalNode.id, type: "escalation", status: "fail" });
      ctx.dag.addEdge(prevNodeId, escalNode.id);
    }

    // afterToolExecution 插件钩子
    for (const plugin of ctx.plugins) {
      const output = await plugin.afterToolExecution?.({
        ...ctx.basePluginContext,
        step: this.step,
        toolName: this.toolName,
        toolCallId: this.toolCallId,
        args: effectiveArgs,
        result: finalResult as import("../../tools/tool-types.js").ToolExecuteResult,
        intentSummary: this.intent,
        attempt,
        totalAttempts,
        wasRepaired: attempt > 1,
        allFailed: !finalResult.ok && attempt >= totalAttempts
      });
      ctx.bus.dispatchPluginOutput(output);
    }

    ctx.bus.dispatch("tool.execution.end", {
      sessionId: ctx.sessionId,
      turnIndex: ctx.turnIndex,
      toolName: this.toolName,
      toolCallId: this.toolCallId,
      toolOk: finalResult.ok,
      toolStatus: finalResult.ok ? "success" : "fail",
      toolResultText: summarizeText(finalResult.content)
    });

    // 将工具结果写入 workingMessages（LLM 后续轮次需要）
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

    const finalStatus = finalResult.ok ? "success" : "fail";
    if (finalResult.ok) {
      this.markSuccess();
    } else {
      this.markFailed({ name: "ToolError", message: String(finalResult.content) });
    }
    this.transitionInDag(ctx, finalStatus, finalResult.ok ? "tool-ok" : "max-retries-exhausted");
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
