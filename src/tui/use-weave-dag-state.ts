/**
 * 文件作用：Weave DAG 节点状态管理 Hook，从 use-agent-state.ts 提取。
 * 处理 DAG 节点的增删改、审批暂停/恢复、重试状态等复杂逻辑。
 */
import { useEffect, useState } from "react";
import { MAX_NODE_DETAILS } from "../config/defaults.js";
import type {
  AgentStartEvent,
  AgentUiEventGateway,
  ApprovalPendingEvent,
  ApprovalResolvedEvent,
  WeaveDagDetailEvent,
  WeaveDagEvent
} from "./agent-ui-events.js";

export interface WeaveDagNodeItem {
  id: string;
  parentId?: string;
  label: string;
  status: "running" | "waiting" | "retrying" | "success" | "fail";
  startedAtMs: number;
  endedAtMs?: number;
  updatedAtMs: number;
  pausedAtMs?: number;
  pausedDurationMs: number;
  retryCurrent?: number;
  retryMax?: number;
  details: string[];
}

export function useWeaveDagState(gateway: AgentUiEventGateway): WeaveDagNodeItem[] {
  const [nodes, setNodes] = useState<WeaveDagNodeItem[]>([]);

  useEffect(() => {
    const onAgentStart = (_event: AgentStartEvent): void => {
      setNodes([]);
    };

    const onWeaveDag = (event: WeaveDagEvent): void => {
      const now = Date.now();
      setNodes((prev) => {
        const index = prev.findIndex((item) => item.id === event.nodeId);
        if (index < 0) {
          return [
            ...prev,
            {
              id: event.nodeId,
              parentId: event.parentId,
              label: event.label,
              status: event.status,
              startedAtMs: now,
              endedAtMs: event.status === "success" || event.status === "fail" ? now : undefined,
              updatedAtMs: now,
              pausedDurationMs: 0,
              retryCurrent: undefined,
              retryMax: undefined,
              details: []
            }
          ];
        }

        const current = prev[index];
        const isSameSemanticState =
          current.parentId === event.parentId &&
          current.label === event.label &&
          current.status === event.status;
        if (isSameSemanticState) {
          return prev;
        }

        const extraPausedMs =
          (event.status === "success" || event.status === "fail") && current.pausedAtMs
            ? Math.max(0, now - current.pausedAtMs)
            : 0;
        const next = [...prev];
        next[index] = {
          ...current,
          id: event.nodeId,
          parentId: event.parentId,
          label: event.label,
          status: event.status,
          endedAtMs:
            event.status === "success" || event.status === "fail"
              ? current.endedAtMs ?? now
              : undefined,
          updatedAtMs: now,
          pausedAtMs: event.status === "success" || event.status === "fail" ? undefined : current.pausedAtMs,
          pausedDurationMs: (current.pausedDurationMs ?? 0) + extraPausedMs,
          retryCurrent: event.status === "success" || event.status === "fail" ? undefined : current.retryCurrent,
          retryMax: event.status === "success" || event.status === "fail" ? undefined : current.retryMax
        };
        return next;
      });
    };

    const onWeaveDagDetail = (event: WeaveDagDetailEvent): void => {
      if (!event.text.trim()) {
        return;
      }

      setNodes((prev) => {
        const index = prev.findIndex((item) => item.id === event.nodeId);
        if (index < 0) {
          return prev;
        }

        const next = [...prev];
        const current = next[index];
        const lastDetail = current.details[current.details.length - 1] ?? "";
        if (lastDetail === event.text) {
          return prev;
        }

        const details = [...current.details, event.text].slice(-MAX_NODE_DETAILS);
        const retryMatch = /^retry=(\d+)\/(\d+)\b/.exec(event.text.trim());
        const retryCurrent = retryMatch ? Number(retryMatch[1]) : current.retryCurrent;
        const retryMax = retryMatch ? Number(retryMatch[2]) : current.retryMax;
        next[index] = {
          ...current,
          status: retryMatch ? "retrying" : current.status,
          endedAtMs: retryMatch ? undefined : current.endedAtMs,
          details,
          retryCurrent,
          retryMax,
          updatedAtMs: Date.now()
        };
        return next;
      });
    };

    const findActiveNode = (prev: WeaveDagNodeItem[]): { node: WeaveDagNodeItem; index: number } | null => {
      const target = [...prev]
        .filter((node) => node.status === "running" || node.status === "waiting")
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
      if (!target) return null;
      const index = prev.findIndex((node) => node.id === target.id);
      return index >= 0 ? { node: target, index } : null;
    };

    const onApprovalPending = (event: ApprovalPendingEvent): void => {
      const now = Date.now();
      setNodes((prev) => {
        const index = prev.findIndex((node) => node.id === event.nodeId);
        if (index < 0 || prev[index].pausedAtMs) return prev;
        const next = [...prev];
        next[index] = { ...next[index], pausedAtMs: now, updatedAtMs: now };
        return next;
      });
    };

    const onApprovalResolved = (event: ApprovalResolvedEvent): void => {
      const now = Date.now();
      setNodes((prev) => {
        const index = prev.findIndex((node) => node.id === event.nodeId);
        if (index < 0 || !prev[index].pausedAtMs) return prev;
        const pausedMs = Math.max(0, now - (prev[index].pausedAtMs as number));
        const next = [...prev];
        next[index] = {
          ...next[index],
          pausedAtMs: undefined,
          pausedDurationMs: (next[index].pausedDurationMs ?? 0) + pausedMs,
          updatedAtMs: now
        };
        return next;
      });
    };

    gateway.on("agent:start", onAgentStart);
    gateway.on("weave:dag", onWeaveDag);
    gateway.on("weave:dag-detail", onWeaveDagDetail);
    gateway.on("approval:pending", onApprovalPending);
    gateway.on("approval:resolved", onApprovalResolved);

    return () => {
      gateway.off("agent:start", onAgentStart);
      gateway.off("weave:dag", onWeaveDag);
      gateway.off("weave:dag-detail", onWeaveDagDetail);
      gateway.off("approval:pending", onApprovalPending);
      gateway.off("approval:resolved", onApprovalResolved);
    };
  }, [gateway]);

  return nodes;
}
