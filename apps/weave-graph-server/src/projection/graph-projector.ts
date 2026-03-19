/*
 * 文件作用：将 Runtime 原始事件归一化为图协议事件（node/edge/status/io）。
 * 优先处理 weave.dag.base_node 事件（包含完整 BaseNodePayload），
 * 兼容旧版 weave.dag.node / weave.dag.edge / weave.dag.detail 事件。
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
  RunStartPayload,
  BaseNodePayload,
  NodeKind
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
      this.completedAtByRun.set(event.runId, Date.now());
    }

    // ── engine.* 事件：DagGraph 广播站直接发射，无需 plugin.output 包装 ──────

    if (event.type === "engine.node.created") {
      const nodeId = this.stringValue(event.payload?.nodeId);
      const nodeType = this.stringValue(event.payload?.nodeType);
      const frozen = (event.payload?.payload ?? {}) as Record<string, unknown>;
      if (nodeId) {
        const kind = (frozen.kind ?? nodeType) as NodeKind;
        const title = this.stringValue(frozen.title) || nodeId;
        out.push(this.wrap<NodeUpsertPayload>(event.runId, "node.upsert", event.timestamp, {
          nodeId,
          parentId: frozen.parentId ? String(frozen.parentId) : undefined,
          kind: kind as NodeKind,
          title,
          tags: Array.isArray(frozen.tags) ? (frozen.tags as string[]) : undefined,
          dependencies: Array.isArray(frozen.dependencies) ? (frozen.dependencies as string[]) : undefined
        }));
        out.push(this.wrap<NodeStatusPayload>(event.runId, "node.status", event.timestamp, {
          nodeId,
          status: this.toNodeStatus(this.stringValue(frozen.status) || "pending")
        }));
        if (frozen.inputPorts || frozen.outputPorts || frozen.error || frozen.metrics) {
          out.push(this.wrap<NodeIoPayload>(event.runId, "node.io", event.timestamp, {
            nodeId,
            inputPorts: frozen.inputPorts as BaseNodePayload["inputPorts"],
            outputPorts: frozen.outputPorts as BaseNodePayload["outputPorts"],
            error: frozen.error as BaseNodePayload["error"],
            metrics: frozen.metrics as BaseNodePayload["metrics"]
          }));
        }
      }
    }

    if (event.type === "engine.edge.created") {
      const fromId = this.stringValue(event.payload?.fromId);
      const toId = this.stringValue(event.payload?.toId);
      const kind = this.stringValue(event.payload?.kind) || "dependency";
      if (fromId && toId) {
        const edgeId = `${fromId}->${toId}:${kind}`;
        out.push(this.wrap<EdgeUpsertPayload>(event.runId, "edge.upsert", event.timestamp, {
          edgeId,
          source: fromId,
          target: toId,
          edgeKind: kind as EdgeUpsertPayload["edgeKind"]
        }));
      }
    }

    if (event.type === "engine.data.edge.created") {
      const fromNodeId = this.stringValue(event.payload?.fromNodeId);
      const toNodeId = this.stringValue(event.payload?.toNodeId);
      const fromKey = this.stringValue(event.payload?.fromKey);
      const toKey = this.stringValue(event.payload?.toKey);
      if (fromNodeId && toNodeId) {
        const edgeId = `${fromNodeId}->${toNodeId}:data:${toKey}`;
        out.push(this.wrap<EdgeUpsertPayload>(event.runId, "edge.upsert", event.timestamp, {
          edgeId,
          source: fromNodeId,
          target: toNodeId,
          fromPort: fromKey || undefined,
          toPort: toKey || undefined,
          edgeKind: "data"
        }));
      }
    }

    if (event.type === "engine.node.transition") {
      const nodeId = this.stringValue(event.payload?.nodeId);
      const toStatus = this.stringValue(event.payload?.toStatus);
      const updatedPayload = event.payload?.updatedPayload as Record<string, unknown> | undefined;
      if (nodeId) {
        out.push(this.wrap<NodeStatusPayload>(event.runId, "node.status", event.timestamp, {
          nodeId,
          status: this.toNodeStatus(toStatus)
        }));
        // 若携带快照数据，刷新 Inspector 面板
        if (updatedPayload && (updatedPayload.inputPorts || updatedPayload.outputPorts || updatedPayload.error || updatedPayload.metrics)) {
          out.push(this.wrap<NodeIoPayload>(event.runId, "node.io", event.timestamp, {
            nodeId,
            inputPorts: updatedPayload.inputPorts as BaseNodePayload["inputPorts"],
            outputPorts: updatedPayload.outputPorts as BaseNodePayload["outputPorts"],
            error: updatedPayload.error as BaseNodePayload["error"],
            metrics: updatedPayload.metrics as BaseNodePayload["metrics"]
          }));
        }
      }
    }

    if (event.type === "engine.scheduler.issue") {
      // 调度器死锁/完整性问题 — 记录为系统节点（前端可展示警告）
      const issueType = this.stringValue(event.payload?.issueType);
      const message = this.stringValue(event.payload?.message);
      const issueNodeId = `scheduler-issue-${issueType}-${Date.now()}`;
      if (message) {
        out.push(this.wrap<NodeUpsertPayload>(event.runId, "node.upsert", event.timestamp, {
          nodeId: issueNodeId,
          kind: "system",
          title: `调度异常: ${message}`
        }));
        out.push(this.wrap<NodeStatusPayload>(event.runId, "node.status", event.timestamp, {
          nodeId: issueNodeId,
          status: "fail"
        }));
      }
    }

    // ── 新版：weave.dag.base_node — 直接包含完整 BaseNodePayload ────────────
    if (event.type === "plugin.output" && this.stringValue(event.payload?.outputType) === "weave.dag.base_node") {
      const parsed = this.safeJson(this.stringValue(event.payload?.outputText));
      if (parsed?.nodeId) {
        const bp = parsed as unknown as BaseNodePayload;
        const nodeId = String(bp.nodeId);
        const kind = (bp.kind ?? "tool") as NodeKind;
        const title = String(bp.title ?? "");

        // node.upsert
        out.push(this.wrap<NodeUpsertPayload>(event.runId, "node.upsert", event.timestamp, {
          nodeId,
          parentId: bp.parentId ? String(bp.parentId) : undefined,
          kind,
          title,
          tags: Array.isArray(bp.tags) ? (bp.tags as string[]) : undefined,
          dependencies: Array.isArray(bp.dependencies) ? (bp.dependencies as string[]) : undefined
        }));

        // node.status
        out.push(this.wrap<NodeStatusPayload>(event.runId, "node.status", event.timestamp, {
          nodeId,
          status: this.toNodeStatus(String(bp.status ?? "pending"))
        }));

        // node.io（端口 + 错误 + 指标）
        if (bp.inputPorts?.length || bp.outputPorts?.length || bp.error || bp.metrics) {
          out.push(this.wrap<NodeIoPayload>(event.runId, "node.io", event.timestamp, {
            nodeId,
            inputPorts: bp.inputPorts,
            outputPorts: bp.outputPorts,
            error: bp.error,
            metrics: bp.metrics
          }));
        }

        // 由 parentId 生成父子边
        if (bp.parentId) {
          const edgeId = `${String(bp.parentId)}->${nodeId}`;
          out.push(this.wrap<EdgeUpsertPayload>(event.runId, "edge.upsert", event.timestamp, {
            edgeId,
            source: String(bp.parentId),
            target: nodeId
          }));
        }

        // 由 dependencies 生成依赖边
        if (Array.isArray(bp.dependencies)) {
          for (const depId of bp.dependencies as string[]) {
            const edgeId = `${depId}=>${nodeId}`;
            out.push(this.wrap<EdgeUpsertPayload>(event.runId, "edge.upsert", event.timestamp, {
              edgeId,
              source: depId,
              target: nodeId,
              edgeKind: "dependency"
            }));
          }
        }
      }
    }

    // ── 旧版：weave.dag.node（向后兼容，已不再由新 WeavePlugin 发射） ────────
    if (event.type === "plugin.output" && this.stringValue(event.payload?.outputType) === "weave.dag.node") {
      const parsed = this.safeJson(this.stringValue(event.payload?.outputText));
      if (parsed?.nodeId) {
        const explicitKind = parsed.kind ? String(parsed.kind) : undefined;
        out.push(this.wrap<NodeUpsertPayload>(event.runId, "node.upsert", event.timestamp, {
          nodeId: String(parsed.nodeId),
          parentId: parsed.parentId ? String(parsed.parentId) : undefined,
          kind: (explicitKind as NodeKind) ?? this.inferKind(String(parsed.nodeId), String(parsed.label || "")),
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

    // ── weave.dag.edge（两版 WeavePlugin 均发射） ────────────────────────────
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

    // ── Step Gate 事件 ────────────────────────────────────────────────────────
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

    // ── 旧版：weave.dag.detail（向后兼容） ────────────────────────────────────
    if (event.type === "plugin.output" && this.stringValue(event.payload?.outputType) === "weave.dag.detail") {
      const parsed = this.safeJson(this.stringValue(event.payload?.outputText));
      if (parsed?.nodeId) {
        out.push(this.wrap<NodeIoPayload>(event.runId, "node.io", event.timestamp, {
          nodeId: String(parsed.nodeId),
          outputPorts: [
            {
              name: "detail",
              type: "text",
              content: this.stringValue(parsed.text) || ""
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
    for (const [runId, completedAt] of this.completedAtByRun.entries()) {
      if (nowMs - completedAt > GraphProjector.RUN_CONTEXT_GRACE_MS) {
        this.completedAtByRun.delete(runId);
        this.seqByRun.delete(runId);
        this.dagIdByRun.delete(runId);
      }
    }

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

  private inferKind(nodeId: string, label: string): NodeKind {
    if (/step\s*gate|人工拦截|暂停|挂起/i.test(label)) return "gate";
    if (label.includes("LLM") || label.includes("决策")) return "llm";
    if (label.includes("修复")) return "repair";
    if (nodeId.includes("final") || label.includes("本轮完成")) return "final";
    return "tool";
  }

  private toNodeStatus(input: string): NodeStatusPayload["status"] {
    const valid = new Set(["pending", "ready", "blocked", "running", "waiting", "retrying", "success", "fail", "skipped", "aborted"]);
    return valid.has(input) ? (input as NodeStatusPayload["status"]) : "pending";
  }

  private stringValue(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  private numberValue(value: unknown): number | undefined {
    return typeof value === "number" ? value : undefined;
  }

  private safeJson(text: string): Record<string, unknown> | null {
    if (!text) return null;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
