/**
 * 文件作用：StepGateInterceptor — 从 ToolNode 抽出的 Step Gate 审批拦截器。
 * 双模式：
 *   1. 有 approveToolCall 回调时 → 直接调用回调（TUI / 测试场景）
 *   2. 无回调时 → 通过 PendingPromiseRegistry 挂起（WebSocket 场景）
 */

import type { INodeInterceptor, InterceptDecision } from "./interceptor.js";
import type { PendingPromiseRegistry } from "./pending-promise-registry.js";
import type { BaseNode } from "../nodes/base-node.js";
import type { RunContext } from "../session/run-context.js";
import { summarizeText, safeJsonStringify } from "../utils/text-utils.js";

export interface StepGateInterceptorOptions {
  enabled: boolean;
}

export class StepGateInterceptor implements INodeInterceptor {
  constructor(
    private readonly registry: PendingPromiseRegistry,
    private readonly options: StepGateInterceptorOptions
  ) {}

  async shouldIntercept(node: BaseNode): Promise<boolean> {
    return this.options.enabled && node.kind === "tool";
  }

  async waitForApproval(node: BaseNode, ctx: RunContext): Promise<InterceptDecision> {
    const toolName = (node as any).toolName ?? node.kind;
    const toolCallId = (node as any).toolCallId ?? node.id;
    const step = (node as any).step ?? 0;
    const effectiveArgs = (node as any).getEffectiveArgs?.() ?? (node as any).args ?? {};

    // 广播等待审批事件
    ctx.bus.dispatch("node.pending_approval", {
      sessionId: ctx.sessionId,
      turnIndex: ctx.turnIndex,
      nodeId: node.id,
      toolName,
      toolCallId,
      toolArgsText: summarizeText(effectiveArgs),
      toolArgsJsonText: safeJsonStringify(effectiveArgs)
    });

    let decision: InterceptDecision;

    if (ctx.stepGate.approveToolCall) {
      // 模式 1：TUI / 测试回调 — 直接调用 approveToolCall
      const result = await ctx.stepGate.approveToolCall({
        runId: ctx.runId,
        step,
        toolName,
        toolCallId,
        nodeId: node.id,
        args: effectiveArgs,
        argsText: safeJsonStringify(effectiveArgs)
      });
      decision = {
        action: result.action,
        editedArgs: result.editedArgs && typeof result.editedArgs === "object"
          ? result.editedArgs as Record<string, unknown>
          : undefined
      };
    } else {
      // 模式 2：WebSocket — 挂起等待外部 resume()
      decision = await this.registry.suspend(node.id, node);
    }

    // 广播审批结果事件
    ctx.bus.dispatch("node.approval.resolved", {
      sessionId: ctx.sessionId,
      turnIndex: ctx.turnIndex,
      nodeId: node.id,
      toolName,
      toolCallId,
      approvalAction: decision.action,
      toolArgsText: summarizeText(effectiveArgs),
      toolArgsJsonText: safeJsonStringify(effectiveArgs)
    });

    return decision;
  }
}
