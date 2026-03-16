import { EventEmitter } from "node:events";
import type { AgentRunEvent } from "../agent/run-agent.js";

/**
 * 文件作用：提供面向 TUI 的事件网关，将 Runtime 事件映射为 UI 语义事件。
 */
export type AgentUiStatus = "idle" | "thinking" | "using_tool" | "done" | "error";

export interface AgentStartEvent {
  runId: string;
  userInput: string;
}

export interface AgentThoughtEvent {
  runId: string;
  text: string;
}

export interface ToolStartEvent {
  runId: string;
  toolName: string;
  args: string;
}

export interface ToolEndEvent {
  runId: string;
  toolName: string;
  result: string;
  status: "success" | "fail";
}

export interface AgentFinishEvent {
  runId: string;
  finalText: string;
}

export interface AgentErrorEvent {
  runId: string;
  errorMessage: string;
}

export interface WeaveDagEvent {
  runId: string;
  nodeId: string;
  parentId?: string;
  label: string;
  status: "running" | "waiting" | "success" | "fail";
}

export interface WeaveDagDetailEvent {
  runId: string;
  nodeId: string;
  text: string;
}

interface WeaveDagEnvelope {
  schemaVersion?: string;
  eventId?: string;
  eventType?: string;
  payload?: Record<string, unknown>;
}

export interface ApprovalPendingEvent {
  runId: string;
  toolName: string;
  toolCallId: string;
}

export interface ApprovalResolvedEvent {
  runId: string;
  toolName: string;
  toolCallId: string;
  action: "approve" | "edit" | "skip" | "abort";
}

export class AgentUiEventGateway extends EventEmitter {
  private readonly showProtocolTransitionNodes = process.env.WEAVE_TUI_SHOW_PROTOCOL_NODES === "1";

  mapFromRuntime(event: AgentRunEvent): void {
    if (event.type === "run.start") {
      this.emit("agent:start", {
        runId: event.runId,
        userInput: event.payload?.userInput ?? ""
      } satisfies AgentStartEvent);
      return;
    }

    if (event.type === "llm.delta") {
      this.emit("agent:thought", {
        runId: event.runId,
        text: event.payload?.text ?? ""
      } satisfies AgentThoughtEvent);
      return;
    }

    if (event.type === "tool.execution.start") {
      this.emit("tool:start", {
        runId: event.runId,
        toolName: event.payload?.toolName ?? "unknown",
        args: event.payload?.toolArgsText ?? ""
      } satisfies ToolStartEvent);
      return;
    }

    if (event.type === "tool.execution.end") {
      this.emit("tool:end", {
        runId: event.runId,
        toolName: event.payload?.toolName ?? "unknown",
        result: event.payload?.toolResultText ?? "",
        status: event.payload?.toolStatus ?? (event.payload?.toolOk ? "success" : "fail")
      } satisfies ToolEndEvent);
      return;
    }

    if (event.type === "run.completed") {
      this.emit("agent:finish", {
        runId: event.runId,
        finalText: event.payload?.finalText ?? ""
      } satisfies AgentFinishEvent);
      return;
    }

    if (event.type === "run.error") {
      this.emit("agent:error", {
        runId: event.runId,
        errorMessage: event.payload?.errorMessage ?? "未知错误"
      } satisfies AgentErrorEvent);
      return;
    }

    if (event.type === "node.pending_approval") {
      this.emit("approval:pending", {
        runId: event.runId,
        toolName: event.payload?.toolName ?? "unknown",
        toolCallId: event.payload?.toolCallId ?? ""
      } satisfies ApprovalPendingEvent);
      return;
    }

    if (event.type === "node.approval.resolved") {
      this.emit("approval:resolved", {
        runId: event.runId,
        toolName: event.payload?.toolName ?? "unknown",
        toolCallId: event.payload?.toolCallId ?? "",
        action: event.payload?.approvalAction ?? "approve"
      } satisfies ApprovalResolvedEvent);
      return;
    }

    if (
      event.type === "plugin.output" &&
      event.payload?.pluginName === "weave" &&
      event.payload?.outputType === "weave.dag.node"
    ) {
      const text = event.payload?.outputText ?? "";
      const parsed = this.parseWeaveDagNode(text);
      if (!parsed) {
        return;
      }

      this.emit("weave:dag", {
        runId: event.runId,
        ...parsed
      } satisfies WeaveDagEvent);
      return;
    }

    if (
      event.type === "plugin.output" &&
      event.payload?.pluginName === "weave" &&
      event.payload?.outputType === "weave.dag.detail"
    ) {
      const text = event.payload?.outputText ?? "";
      const parsed = this.parseWeaveDagDetail(text);
      if (!parsed) {
        return;
      }

      this.emit("weave:dag-detail", {
        runId: event.runId,
        ...parsed
      } satisfies WeaveDagDetailEvent);
      return;
    }

    if (
      event.type === "plugin.output" &&
      event.payload?.pluginName === "weave" &&
      event.payload?.outputType === "weave.dag.event"
    ) {
      const envelope = this.parseWeaveDagEnvelope(event.payload?.outputText ?? "");
      if (!envelope) {
        return;
      }

      if (envelope.eventType === "dag.node.transition") {
        // 默认不把协议层状态迁移渲染为 DAG 业务节点，避免与 Weave 语义节点重复展示。
        // 当需要诊断调度细节时，可通过 WEAVE_TUI_SHOW_PROTOCOL_NODES=1 临时打开。
        if (!this.showProtocolTransitionNodes) {
          return;
        }

        const nodeId = typeof envelope.payload?.nodeId === "string" ? envelope.payload.nodeId : "";
        const nodeType = typeof envelope.payload?.nodeType === "string" ? envelope.payload.nodeType : "node";
        const toStatus = typeof envelope.payload?.toStatus === "string" ? envelope.payload.toStatus : "";
        const mappedStatus = this.mapDagNodeStatus(toStatus);
        if (!nodeId || !mappedStatus) {
          return;
        }

        this.emit("weave:dag", {
          runId: event.runId,
          nodeId,
          label: `${nodeType} -> ${toStatus}`,
          status: mappedStatus
        } satisfies WeaveDagEvent);
        return;
      }

      if (envelope.eventType === "dag.node.detail") {
        const nodeId = typeof envelope.payload?.nodeId === "string" ? envelope.payload.nodeId : "";
        const text = typeof envelope.payload?.text === "string" ? envelope.payload.text : "";
        if (!nodeId || !text) {
          return;
        }

        this.emit("weave:dag-detail", {
          runId: event.runId,
          nodeId,
          text
        } satisfies WeaveDagDetailEvent);
      }
    }
  }

  private parseWeaveDagEnvelope(text: string): WeaveDagEnvelope | null {
    if (!text.trim()) {
      return null;
    }

    try {
      const parsed = JSON.parse(text) as WeaveDagEnvelope;
      if (!parsed.eventType || !parsed.payload) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private mapDagNodeStatus(status: string): WeaveDagEvent["status"] | null {
    if (status === "running" || status === "ready") {
      return "running";
    }
    if (status === "blocked") {
      return "waiting";
    }
    if (status === "success") {
      return "success";
    }
    if (status === "fail" || status === "aborted" || status === "skipped") {
      return "fail";
    }
    return null;
  }

  private parseWeaveDagNode(text: string): Omit<WeaveDagEvent, "runId"> | null {
    if (!text.trim()) {
      return null;
    }

    try {
      const data = JSON.parse(text) as {
        nodeId?: string;
        parentId?: string;
        label?: string;
        status?: "running" | "waiting" | "success" | "fail";
      };

      if (!data.nodeId || !data.label || !data.status) {
        return null;
      }

      return {
        nodeId: data.nodeId,
        parentId: data.parentId,
        label: data.label,
        status: data.status
      };
    } catch {
      return null;
    }
  }

  private parseWeaveDagDetail(text: string): Omit<WeaveDagDetailEvent, "runId"> | null {
    if (!text.trim()) {
      return null;
    }

    try {
      const data = JSON.parse(text) as {
        nodeId?: string;
        text?: string;
      };

      if (!data.nodeId || !data.text) {
        return null;
      }

      return {
        nodeId: data.nodeId,
        text: data.text
      };
    } catch {
      return null;
    }
  }
}
