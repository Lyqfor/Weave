import type {
  AgentLoopPlugin,
  AgentPluginOutput,
  AgentPluginOutputs,
  AgentPluginRunContext,
  BeforeToolExecutionContext,
  AfterToolExecutionContext
} from "../agent/plugins/agent-plugin.js";
import { summarizeText } from "../utils/text-utils.js";
import { formatToolIntent } from "./tool-formatters.js";

/**
 * 文件作用：以观察者模式监听 Agent 原生动作，实时输出动态 DAG 节点事件。
 * 采用 TurnDAGBuilder 管理节点状态，使用规范化节点 ID，支持完整节点类型：
 * InputNode / LlmNode / ToolNode / AttemptNode / RepairNode / EscalationNode / FinalNode。
 */

// ─── 节点 / 边事件类型 ───

type DagNodeKind =
  | "input"
  | "llm"
  | "tool"
  | "attempt"
  | "repair"
  | "escalation"
  | "gate"
  | "final"
  | "system";

type DagNodeStatus = "running" | "waiting" | "success" | "fail" | "skipped";

interface DagNodeEvent {
  nodeId: string;
  parentId?: string;
  kind: DagNodeKind;
  label: string;
  status: DagNodeStatus;
}

interface DagDetailEvent {
  nodeId: string;
  text: string;
}

interface DagEdgeEvent {
  sourceId: string;
  targetId: string;
  fromPort?: string;
  toPort?: string;
  edgeKind?: "dependency" | "data" | "retry" | "condition_true" | "condition_false";
  label?: string;
}

// ─── 构建函数 ───

function buildDagOutput(event: DagNodeEvent): AgentPluginOutput {
  return {
    pluginName: "weave",
    outputType: "weave.dag.node",
    outputText: JSON.stringify(event)
  };
}

function buildDagDetail(event: DagDetailEvent): AgentPluginOutput {
  return {
    pluginName: "weave",
    outputType: "weave.dag.detail",
    outputText: JSON.stringify(event)
  };
}

function buildDagEdge(event: DagEdgeEvent): AgentPluginOutput {
  return {
    pluginName: "weave",
    outputType: "weave.dag.edge",
    outputText: JSON.stringify(event)
  };
}

// ─── TurnDAGBuilder ───

/**
 * 负责管理单次对话轮次内的 DAG 节点构建。
 * 跟踪 LLM/工具的调用计数，生成规范化节点 ID，并维护节点间依赖关系。
 *
 * 规范化节点 ID 方案：
 *   input           ← 用户输入
 *   llm-1, llm-2    ← 第 N 轮 LLM 决策
 *   tool-1, tool-2  ← 第 N 个工具调用（全局唯一）
 *   tool-1:attempt-1, tool-1:attempt-2  ← 第 N 次执行尝试
 *   tool-1:repair-1                     ← 第 N 次修复（位于 attempt-N 和 attempt-(N+1) 之间）
 *   tool-1:escalation                   ← 重试耗尽升级节点
 *   final           ← 最终回答
 */
class TurnDAGBuilder {
  private llmIndex = 0;
  private toolIndex = 0;
  /** 当前 LLM 节点 ID */
  currentLlmId = "";
  /** toolCallId → canonical toolNode ID */
  private toolIdByCallId = new Map<string, string>();
  /** 上一轮完成的 tool 节点 ID（用于构建到下一 LLM 的数据流边） */
  private completedToolIds: string[] = [];

  // ── InputNode ──

  buildInputNode(userInput?: string): AgentPluginOutput[] {
    const outputs: AgentPluginOutput[] = [
      buildDagOutput({ nodeId: "input", kind: "input", label: "用户输入", status: "success" })
    ];
    if (userInput) {
      outputs.push(buildDagDetail({ nodeId: "input", text: `input=${userInput.slice(0, 200)}` }));
    }
    return outputs;
  }

  // ── LlmNode ──

  buildBeforeLlm(): AgentPluginOutput[] {
    const outputs: AgentPluginOutput[] = [];

    this.llmIndex++;
    const llmId = `llm-${this.llmIndex}`;

    // 从 InputNode 或上一轮工具结果连接到新 LLM
    if (this.llmIndex === 1) {
      outputs.push(
        buildDagEdge({
          sourceId: "input",
          targetId: llmId,
          fromPort: "input.text",
          toPort: "context",
          edgeKind: "data"
        })
      );
    } else if (this.completedToolIds.length > 0) {
      for (const toolId of this.completedToolIds) {
        outputs.push(
          buildDagEdge({
            sourceId: toolId,
            targetId: llmId,
            fromPort: "result",
            toPort: "tool_result",
            edgeKind: "data"
          })
        );
      }
    } else if (this.currentLlmId) {
      // 前一 LLM 没有工具调用，直接连接
      outputs.push(
        buildDagEdge({
          sourceId: this.currentLlmId,
          targetId: llmId,
          edgeKind: "dependency"
        })
      );
    }

    this.completedToolIds = [];
    this.currentLlmId = llmId;

    outputs.push(
      buildDagOutput({ nodeId: llmId, kind: "llm", label: "大模型决策中...", status: "running" })
    );
    return outputs;
  }

  buildAfterLlm(hasTools: boolean, toolCount: number): AgentPluginOutput[] {
    if (!this.currentLlmId) return [];

    if (hasTools) {
      return [
        buildDagOutput({
          nodeId: this.currentLlmId,
          kind: "llm",
          label: "决策为调用工具",
          status: "waiting"
        }),
        buildDagDetail({
          nodeId: this.currentLlmId,
          text: `plan=tool_calls x${toolCount}`
        })
      ];
    }

    return [
      buildDagOutput({
        nodeId: this.currentLlmId,
        kind: "llm",
        label: "大模型决策完成",
        status: "success"
      })
    ];
  }

  // ── ToolNode / AttemptNode / RepairNode / EscalationNode ──

  buildBeforeTool(
    toolCallId: string,
    toolName: string,
    args: unknown,
    intentSummary: string | undefined,
    attempt: number,
    maxRetries: number,
    previousError: string | undefined,
    repairedFrom: Record<string, unknown> | undefined
  ): AgentPluginOutput[] {
    const outputs: AgentPluginOutput[] = [];

    if (attempt === 1) {
      // 首次执行：创建 ToolNode，直接在 ToolNode 上附加参数详情（不创建 attempt-1 子节点）
      this.toolIndex++;
      const toolId = `tool-${this.toolIndex}`;
      this.toolIdByCallId.set(toolCallId, toolId);

      const semantic = formatToolIntent(toolName, args);
      const title = intentSummary || semantic.title;

      outputs.push(
        buildDagOutput({
          nodeId: toolId,
          parentId: this.currentLlmId,
          kind: "tool",
          label: title,
          status: "running"
        })
      );
      // LLM → Tool 数据流边（parentId 已创建父子边，此为语义化数据流边）
      outputs.push(
        buildDagEdge({
          sourceId: this.currentLlmId,
          targetId: toolId,
          fromPort: "tool_calls",
          toPort: "trigger",
          edgeKind: "data"
        })
      );
      // 将调用参数作为 detail 附加到 ToolNode
      outputs.push(
        buildDagDetail({
          nodeId: toolId,
          text: `args=${JSON.stringify(args).slice(0, 300)}`
        })
      );
      if (semantic.details.length > 0) {
        outputs.push(buildDagDetail({ nodeId: toolId, text: semantic.details.join("\n") }));
      }
    } else {
      // 重试：创建 RepairNode（代表上次失败后的修复 LLM 调用）+ 新 AttemptNode
      const toolId = this.toolIdByCallId.get(toolCallId);
      if (!toolId) return outputs;

      // attempt=2 时上一个失败节点是 toolId 本身（首次无 attempt-1 子节点）
      // attempt>2 时上一个失败节点是 tool-N:attempt-{attempt-1}
      const retrySourceId = attempt === 2 ? toolId : `${toolId}:attempt-${attempt - 1}`;
      const repairId = `${toolId}:repair-${attempt - 1}`;
      const attemptId = `${toolId}:attempt-${attempt}`;

      // RepairNode：代表局部上下文 LLM 修复调用
      outputs.push(
        buildDagOutput({
          nodeId: repairId,
          parentId: toolId,
          kind: "repair",
          label: "参数修复",
          status: "success"
        })
      );
      if (previousError) {
        outputs.push(
          buildDagDetail({
            nodeId: repairId,
            text: `失败原因: ${previousError}`
          })
        );
      }
      if (repairedFrom) {
        outputs.push(
          buildDagDetail({
            nodeId: repairId,
            text: `修复前参数: ${JSON.stringify(repairedFrom).slice(0, 200)}`
          })
        );
      }
      // 重试链边：上次失败节点 → RepairNode → 新 AttemptNode
      outputs.push(
        buildDagEdge({ sourceId: retrySourceId, targetId: repairId, edgeKind: "retry" })
      );
      outputs.push(
        buildDagEdge({ sourceId: repairId, targetId: attemptId, edgeKind: "retry" })
      );

      outputs.push(
        buildDagOutput({
          nodeId: attemptId,
          parentId: toolId,
          kind: "attempt",
          label: `第 ${attempt} 次执行`,
          status: "running"
        })
      );
      outputs.push(
        buildDagDetail({
          nodeId: attemptId,
          text: `尝试 ${attempt}/${maxRetries + 1}`
        })
      );
    }

    return outputs;
  }

  buildAfterTool(
    toolCallId: string,
    toolName: string,
    result: { ok: boolean; content?: unknown },
    attempt: number,
    maxRetries: number,
    allFailed: boolean | undefined
  ): AgentPluginOutput[] {
    const outputs: AgentPluginOutput[] = [];
    const toolId = this.toolIdByCallId.get(toolCallId);
    if (!toolId) return outputs;

    const semantic = formatToolIntent(toolName);

    if (result.ok) {
      if (attempt === 1) {
        // 首次直接成功：更新 ToolNode 状态，附加结果详情
        outputs.push(
          buildDagOutput({
            nodeId: toolId,
            parentId: this.currentLlmId,
            kind: "tool",
            label: semantic.title,
            status: "success"
          })
        );
        outputs.push(
          buildDagDetail({
            nodeId: toolId,
            text: `result=${String(result.content ?? "").slice(0, 200)}`
          })
        );
      } else {
        // 重试后成功：更新当前 attempt 节点和 ToolNode
        const attemptId = `${toolId}:attempt-${attempt}`;
        outputs.push(
          buildDagOutput({
            nodeId: attemptId,
            parentId: toolId,
            kind: "attempt",
            label: "执行成功",
            status: "success"
          })
        );
        outputs.push(
          buildDagOutput({
            nodeId: toolId,
            parentId: this.currentLlmId,
            kind: "tool",
            label: semantic.title,
            status: "success"
          })
        );
      }
      this.completedToolIds.push(toolId);
    } else if (allFailed) {
      if (attempt === 1) {
        // 单次执行即失败（无重试）：直接标记 ToolNode 失败
        outputs.push(
          buildDagOutput({
            nodeId: toolId,
            parentId: this.currentLlmId,
            kind: "tool",
            label: semantic.title,
            status: "fail"
          })
        );
      } else {
        // 重试耗尽：最后的 attempt 节点和 ToolNode 均失败
        const attemptId = `${toolId}:attempt-${attempt}`;
        outputs.push(
          buildDagOutput({
            nodeId: attemptId,
            parentId: toolId,
            kind: "attempt",
            label: "执行失败",
            status: "fail"
          })
        );
        outputs.push(
          buildDagOutput({
            nodeId: toolId,
            parentId: this.currentLlmId,
            kind: "tool",
            label: semantic.title,
            status: "fail"
          })
        );
      }
      // 有配置重试时创建 EscalationNode
      if (maxRetries > 0) {
        const escalationId = `${toolId}:escalation`;
        // escalation 挂在最后失败的节点下（attempt=1 时为 toolId 本身）
        const escalationSourceId = attempt === 1 ? toolId : `${toolId}:attempt-${attempt}`;
        outputs.push(
          buildDagOutput({
            nodeId: escalationId,
            parentId: toolId,
            kind: "escalation",
            label: "重试耗尽，升级主循环",
            status: "fail"
          })
        );
        outputs.push(
          buildDagEdge({ sourceId: escalationSourceId, targetId: escalationId, edgeKind: "dependency" })
        );
      }
      this.completedToolIds.push(toolId);
    } else {
      // 本次失败但还会重试
      if (attempt === 1) {
        // attempt=1 时 ToolNode 本身保持 running，等待 repair+retry，不更新状态
      } else {
        const attemptId = `${toolId}:attempt-${attempt}`;
        outputs.push(
          buildDagOutput({
            nodeId: attemptId,
            parentId: toolId,
            kind: "attempt",
            label: `第 ${attempt} 次失败`,
            status: "fail"
          })
        );
      }
    }

    return outputs;
  }

  // ── FinalNode ──

  buildFinalNode(finalText: string): AgentPluginOutput[] {
    const outputs: AgentPluginOutput[] = [];
    const finalId = "final";

    outputs.push(
      buildDagOutput({ nodeId: finalId, kind: "final", label: "本轮完成", status: "success" })
    );
    if (finalText) {
      outputs.push(buildDagDetail({ nodeId: finalId, text: summarizeText(finalText) }));
    }
    if (this.currentLlmId) {
      outputs.push(
        buildDagEdge({
          sourceId: this.currentLlmId,
          targetId: finalId,
          fromPort: "response_text",
          toPort: "response",
          edgeKind: "data"
        })
      );
    }
    return outputs;
  }
}

// ─── WeaveRunState ───

interface WeaveRunState {
  builder: TurnDAGBuilder;
}

// ─── WeavePlugin ───

export class WeavePlugin implements AgentLoopPlugin {
  name = "weave";
  private readonly runStates = new Map<string, WeaveRunState>();

  onRunStart(context: AgentPluginRunContext): AgentPluginOutputs {
    const builder = new TurnDAGBuilder();
    this.runStates.set(context.runId, { builder });
    return builder.buildInputNode(context.userInput);
  }

  beforeLlmRequest(context: { runId: string }): { output: AgentPluginOutput | AgentPluginOutput[] } | void {
    const state = this.runStates.get(context.runId);
    if (!state) return;

    const outputs: AgentPluginOutput[] = [];

    // 若有前一个 LLM 节点（status=waiting），标记为完成
    if (state.builder.currentLlmId) {
      outputs.push(
        buildDagOutput({
          nodeId: state.builder.currentLlmId,
          kind: "llm",
          label: "大模型决策完成，进入下一轮",
          status: "success"
        })
      );
    }

    // 构建新 LLM 节点及前驱边
    outputs.push(...state.builder.buildBeforeLlm());

    return { output: outputs };
  }

  afterLlmResponse(context: {
    runId: string;
    assistantMessage: { tool_calls?: Array<unknown>; content?: unknown };
  }): AgentPluginOutputs {
    const state = this.runStates.get(context.runId);
    if (!state) return;

    const hasTools = Boolean(context.assistantMessage.tool_calls?.length);
    return state.builder.buildAfterLlm(hasTools, context.assistantMessage.tool_calls?.length ?? 0);
  }

  beforeToolExecution(context: BeforeToolExecutionContext): AgentPluginOutputs {
    const state = this.runStates.get(context.runId);
    if (!state) return;

    return state.builder.buildBeforeTool(
      context.toolCallId,
      context.toolName,
      context.args,
      context.intentSummary,
      context.attempt,
      context.maxRetries,
      context.previousError,
      context.repairedFrom
    );
  }

  afterToolExecution(context: AfterToolExecutionContext): AgentPluginOutputs {
    const state = this.runStates.get(context.runId);
    if (!state) return;

    return state.builder.buildAfterTool(
      context.toolCallId,
      context.toolName,
      context.result,
      context.attempt,
      context.totalAttempts - 1,
      context.allFailed
    );
  }

  onRunCompleted(context: { runId: string; finalText: string }): AgentPluginOutputs {
    const state = this.runStates.get(context.runId);
    if (!state) return;

    const outputs: AgentPluginOutput[] = [];
    const currentNode = state.builder.currentLlmId;
    this.runStates.delete(context.runId);

    if (currentNode) {
      // 最后一轮 LLM 标记为完成（覆盖 "大模型决策完成，进入下一轮" 的情况）
      outputs.push(
        buildDagOutput({
          nodeId: currentNode,
          kind: "llm",
          label: "本轮完成",
          status: "success"
        })
      );
    }

    // FinalNode 及其连接边
    outputs.push(...state.builder.buildFinalNode(context.finalText));

    return outputs;
  }

  onRunError(context: { runId: string; errorMessage: string }): AgentPluginOutput | void {
    const state = this.runStates.get(context.runId);
    this.runStates.delete(context.runId);

    const currentNode = state?.builder.currentLlmId;
    if (!currentNode) {
      return buildDagOutput({
        nodeId: "error",
        kind: "tool",
        label: `运行失败: ${context.errorMessage}`,
        status: "fail"
      });
    }

    return buildDagOutput({
      nodeId: currentNode,
      kind: "llm",
      label: context.errorMessage,
      status: "fail"
    });
  }
}
