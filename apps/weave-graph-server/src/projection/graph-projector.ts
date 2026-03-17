/*
 * 文件作用：将 Runtime 原始事件归一化为图协议事件（node/edge/status/io）。
 */

import type {
  EdgeUpsertPayload,
  GraphEnvelope,
  NodeIoPayload,
  NodePendingApprovalPayload,
  NodeApprovalResolvedPayload,
  NodeStatusPayload,
  NodeUpsertPayload,
  RunEndPayload,
  RunStartPayload
} from "../protocol/graph-events.js";
import { GRAPH_SCHEMA_VERSION } from "../protocol/graph-events.js";

export type RuntimeRawEvent = {
  runId: string;
  type: string;
  timestamp: string;
  payload?: Record<string, unknown>;
};

export class GraphProjector {
  private static readonly RUN_CONTEXT_GRACE_MS = 30_000;
  private static readonly MAX_RUN_CONTEXTS = 256;
  private seqByRun = new Map<string, number>();
  private dagIdByRun = new Map<string, string>();
  private completedAtByRun = new Map<string, number>();

  project(event: RuntimeRawEvent): Array<GraphEnvelope<unknown>> {
    this.pruneRunContexts(Date.now());

    const out: Array<GraphEnvelope<unknown>> = [];

    if (event.type === "run.start") {
      const userInput = this.stringValue(event.payload?.userInput) || "";
      const sessionId = this.stringValue(event.payload?.sessionId);
      const turnIndex = this.numberValue(event.payload?.turnIndex);
      const dagId = this.buildDagId(event.runId, sessionId, turnIndex);
      this.dagIdByRun.set(event.runId, dagId);
      this.completedAtByRun.delete(event.runId);
      out.push(this.wrap<RunStartPayload>(event.runId, "run.start", event.timestamp, {
        dagId,
        sessionId,
        turnIndex,
        userInputSummary: userInput
      }));
    }

    if (event.type === "run.completed" || event.type === "run.error") {
      out.push(this.wrap<RunEndPayload>(event.runId, "run.end", event.timestamp, {
        ok: event.type === "run.completed",
        finalSummary: this.stringValue(event.payload?.finalText) || this.stringValue(event.payload?.errorMessage)
      }));
      // run 结束后保留短暂上下文，吸收可能晚到的 plugin.output，避免拆分为第二个 runId DAG。
      this.completedAtByRun.set(event.runId, Date.now());
    }

    if (event.type === "plugin.output" && this.stringValue(event.payload?.outputType) === "weave.dag.node") {
      const parsed = this.safeJson(this.stringValue(event.payload?.outputText));
      if (parsed?.nodeId) {
        // 优先使用插件明确传递的 kind，回退到启发式推断
        const explicitKind = parsed.kind ? String(parsed.kind) : undefined;
        out.push(this.wrap<NodeUpsertPayload>(event.runId, "node.upsert", event.timestamp, {
          nodeId: String(parsed.nodeId),
          parentId: parsed.parentId ? String(parsed.parentId) : undefined,
          kind: (explicitKind as NodeUpsertPayload["kind"]) ?? this.inferKind(String(parsed.nodeId), String(parsed.label || "")),
          title: String(parsed.label || "")
        }));

        out.push(this.wrap<NodeStatusPayload>(event.runId, "node.status", event.timestamp, {
          nodeId: String(parsed.nodeId),
          status: this.toNodeStatus(String(parsed.status || "running"))
        }));

        if (parsed.parentId) {
          const edgeId = `${String(parsed.parentId)}->${String(parsed.nodeId)}`;
          out.push(this.wrap<EdgeUpsertPayload>(event.runId, "edge.upsert", event.timestamp, {
            edgeId,
            source: String(parsed.parentId),
            target: String(parsed.nodeId)
          }));
        }
      }
    }

    if (event.type === "plugin.output" && this.stringValue(event.payload?.outputType) === "weave.dag.edge") {
      const parsed = this.safeJson(this.stringValue(event.payload?.outputText));
      if (parsed?.sourceId && parsed?.targetId) {
        const sourceId = String(parsed.sourceId);
        const targetId = String(parsed.targetId);
        const edgeId = parsed.edgeKind
          ? `${sourceId}->${targetId}:${String(parsed.edgeKind)}`
          : `${sourceId}->${targetId}`;
        out.push(this.wrap<EdgeUpsertPayload>(event.runId, "edge.upsert", event.timestamp, {
          edgeId,
          source: sourceId,
          target: targetId,
          fromPort: parsed.fromPort ? String(parsed.fromPort) : undefined,
          toPort: parsed.toPort ? String(parsed.toPort) : undefined,
          edgeKind: parsed.edgeKind as EdgeUpsertPayload["edgeKind"] | undefined,
          label: parsed.label ? String(parsed.label) : undefined
        }));
      }
    }

    if (event.type === "tool.gate.pending") {
      const toolCallId = this.stringValue(event.payload?.toolCallId);
      const toolName = this.stringValue(event.payload?.toolName) || "unknown";
      const toolParams = this.stringValue(event.payload?.toolParams) || "{}";
      if (toolCallId) {
        const gateNodeId = `gate:${toolCallId.slice(-8)}`;
        out.push(this.wrap<NodeUpsertPayload>(event.runId, "node.upsert", event.timestamp, {
          nodeId: gateNodeId,
          kind: "gate",
          title: `Step Gate · ${toolName}`
        }));
        out.push(this.wrap<NodeStatusPayload>(event.runId, "node.status", event.timestamp, {
          nodeId: gateNodeId,
          status: "running"
        }));
        out.push(this.wrap<NodePendingApprovalPayload>(event.runId, "node.pending_approval", event.timestamp, {
          nodeId: gateNodeId,
          toolName,
          toolParams
        }));
      }
    }

    if (event.type === "tool.gate.resolved") {
      const toolCallId = this.stringValue(event.payload?.toolCallId);
      const action = this.stringValue(event.payload?.action) as "approve" | "edit" | "skip" | "abort";
      if (toolCallId) {
        const gateNodeId = `gate:${toolCallId.slice(-8)}`;
        const statusMap: Record<string, NodeStatusPayload["status"]> = {
          approve: "success",
          edit: "success",
          skip: "skipped",
          abort: "fail"
        };
        out.push(this.wrap<NodeStatusPayload>(event.runId, "node.status", event.timestamp, {
          nodeId: gateNodeId,
          status: statusMap[action] ?? "success"
        }));
        out.push(this.wrap<NodeApprovalResolvedPayload>(event.runId, "node.approval.resolved", event.timestamp, {
          nodeId: gateNodeId,
          action
        }));
      }
    }

    if (event.type === "plugin.output" && this.stringValue(event.payload?.outputType) === "weave.dag.detail") {
      const parsed = this.safeJson(this.stringValue(event.payload?.outputText));
      if (parsed?.nodeId) {
        out.push(this.wrap<NodeIoPayload>(event.runId, "node.io", event.timestamp, {
          nodeId: String(parsed.nodeId),
          outputPorts: [
            {
              name: "detail",
              type: "text",
              summary: this.stringValue(parsed.text) || ""
            }
          ]
        }));
      }
    }

    return out;
  }

  private wrap<T>(runId: string, eventType: GraphEnvelope<T>["eventType"], timestamp: string, payload: T): GraphEnvelope<T> {
    const current = this.seqByRun.get(runId) ?? 0;
    const next = current + 1;
    this.seqByRun.set(runId, next);

    return {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      seq: next,
      runId,
      dagId: this.dagIdByRun.get(runId) ?? runId,
      eventType,
      timestamp,
      payload
    };
  }

  private buildDagId(runId: string, sessionId?: string, turnIndex?: number): string {
    if (sessionId && typeof turnIndex === "number") {
      return `${sessionId}:turn-${turnIndex}`;
    }
    return runId;
  }

  private pruneRunContexts(nowMs: number): void {
    // 先清理超过保留窗口的运行上下文。
    for (const [runId, completedAt] of this.completedAtByRun.entries()) {
      if (nowMs - completedAt > GraphProjector.RUN_CONTEXT_GRACE_MS) {
        this.completedAtByRun.delete(runId);
        this.seqByRun.delete(runId);
        this.dagIdByRun.delete(runId);
      }
    }

    // 兜底限制上下文数量，避免极端长跑服务累积。
    if (this.seqByRun.size <= GraphProjector.MAX_RUN_CONTEXTS) {
      return;
    }

    const candidates = [...this.completedAtByRun.entries()].sort((a, b) => a[1] - b[1]);
    const overflow = this.seqByRun.size - GraphProjector.MAX_RUN_CONTEXTS;
    for (let index = 0; index < overflow && index < candidates.length; index += 1) {
      const runId = candidates[index][0];
      this.completedAtByRun.delete(runId);
      this.seqByRun.delete(runId);
      this.dagIdByRun.delete(runId);
    }
  }

  private inferKind(nodeId: string, label: string): NodeUpsertPayload["kind"] {
    if (/step\s*gate|人工拦截|暂停|挂起/i.test(label)) {
      return "gate";
    }
    if (label.includes("LLM") || label.includes("决策")) {
      return "llm";
    }
    if (label.includes("修复")) {
      return "repair";
    }
    if (nodeId.includes("final") || label.includes("本轮完成")) {
      return "final";
    }
    return "tool";
  }

  private toNodeStatus(input: string): NodeStatusPayload["status"] {
    if (input === "success" || input === "fail" || input === "running" || input === "retrying" || input === "skipped") {
      return input;
    }
    return "pending";
  }

  private stringValue(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  private numberValue(value: unknown): number | undefined {
    return typeof value === "number" ? value : undefined;
  }

  private safeJson(text: string): Record<string, unknown> | null {
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private looksLikeCommand(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }

    return /[|><]/.test(trimmed) || /\b(ls|dir|cat|grep|findstr|awk|sed|pnpm|npm|git|node|python)\b/i.test(trimmed);
  }
}
