import { useEffect, useState } from "react";
import type {
  AgentErrorEvent,
  AgentFinishEvent,
  AgentStartEvent,
  AgentThoughtEvent,
  AgentUiEventGateway,
  AgentUiStatus,
  ApprovalPendingEvent,
  ApprovalResolvedEvent,
  ToolEndEvent,
  ToolStartEvent,
  WeaveDagDetailEvent,
  WeaveDagEvent
} from "./agent-ui-events.js";

/**
 * 文件作用：维护 TUI 状态树，并监听 Agent 事件驱动界面动态更新。
 */
export interface ToolHistoryItem {
  id: string;
  toolName: string;
  args: string;
  status: "running" | "success" | "fail";
  result: string;
}

export interface ChatLogItem {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
}

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

export interface AgentUiState {
  status: AgentUiStatus;
  thoughtText: string;
  toolHistory: ToolHistoryItem[];
  currentTool: ToolHistoryItem | null;
  chatLogs: ChatLogItem[];
  weaveDagNodes: WeaveDagNodeItem[];
  latestError: string;
}

const MAX_LOG_ITEMS = 40;

export function useAgentState(gateway: AgentUiEventGateway): AgentUiState {
  const [status, setStatus] = useState<AgentUiStatus>("idle");
  const [thoughtText, setThoughtText] = useState("");
  const [toolHistory, setToolHistory] = useState<ToolHistoryItem[]>([]);
  const [currentTool, setCurrentTool] = useState<ToolHistoryItem | null>(null);
  const [chatLogs, setChatLogs] = useState<ChatLogItem[]>([]);
  const [weaveDagNodes, setWeaveDagNodes] = useState<WeaveDagNodeItem[]>([]);
  const [latestError, setLatestError] = useState("");

  useEffect(() => {
    const onAgentStart = (event: AgentStartEvent): void => {
      setStatus("thinking");
      setThoughtText("");
      setCurrentTool(null);
      setWeaveDagNodes([]);
      setLatestError("");
      setChatLogs((prev) => {
        const next = [
          ...prev,
          ...(prev.length > 0
            ? [
                {
                  id: `${event.runId}-turn-divider`,
                  role: "system" as const,
                  text: "__turn_divider__"
                }
              ]
            : []),
          {
            id: `${event.runId}-user`,
            role: "user" as const,
            text: event.userInput
          }
        ];
        return next.slice(-MAX_LOG_ITEMS);
      });
    };

    const onAgentThought = (_event: AgentThoughtEvent): void => {
      setStatus((prev) => (prev === "using_tool" ? prev : "thinking"));
    };

    const onToolStart = (event: ToolStartEvent): void => {
      const running: ToolHistoryItem = {
        id: `${event.runId}-${event.toolName}-${Date.now()}`,
        toolName: event.toolName,
        args: event.args,
        status: "running",
        result: ""
      };

      setStatus("using_tool");
      setCurrentTool(running);
      setToolHistory((prev) => [...prev, running]);
      setChatLogs((prev) => {
        const next = [
          ...prev,
          {
            id: `${running.id}-tool-start`,
            role: "system" as const,
            text: `tool:${event.toolName} start${event.args ? ` args=${event.args}` : ""}`
          }
        ];
        return next.slice(-MAX_LOG_ITEMS);
      });
    };

    const onToolEnd = (event: ToolEndEvent): void => {
      setStatus("thinking");
      setCurrentTool(null);
      setToolHistory((prev) => {
        const index = [...prev].reverse().findIndex((item) => item.toolName === event.toolName && item.status === "running");
        if (index < 0) {
          return prev;
        }

        const targetIndex = prev.length - 1 - index;
        const updated = [...prev];
        updated[targetIndex] = {
          ...updated[targetIndex],
          status: event.status,
          result: event.result
        };
        return updated;
      });

      setChatLogs((prev) => {
        const next = [
          ...prev,
          {
            id: `${event.runId}-${event.toolName}-tool-end-${Date.now()}`,
            role: "system" as const,
            text: `tool:${event.toolName} ${event.status === "success" ? "ok" : "fail"}${event.result ? ` result=${event.result}` : ""}`
          }
        ];
        return next.slice(-MAX_LOG_ITEMS);
      });
    };

    const onAgentFinish = (event: AgentFinishEvent): void => {
      setStatus("done");
      setThoughtText("");
      setCurrentTool(null);
      setChatLogs((prev) => {
        const next = [
          ...prev,
          {
            id: `${event.runId}-assistant`,
            role: "assistant" as const,
            text: event.finalText
          }
        ];
        return next.slice(-MAX_LOG_ITEMS);
      });
    };

    const onAgentError = (event: AgentErrorEvent): void => {
      setStatus("error");
      setCurrentTool(null);
      setLatestError(event.errorMessage);
      setChatLogs((prev) => {
        const next = [
          ...prev,
          {
            id: `${event.runId}-error`,
            role: "system" as const,
            text: `error=${event.errorMessage}`
          }
        ];
        return next.slice(-MAX_LOG_ITEMS);
      });
    };

    const onWeaveDag = (event: WeaveDagEvent): void => {
      const now = Date.now();
      setWeaveDagNodes((prev) => {
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

      setWeaveDagNodes((prev) => {
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

        const details = [...current.details, event.text].slice(-8);
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

    const onApprovalPending = (_event: ApprovalPendingEvent): void => {
      const now = Date.now();
      setWeaveDagNodes((prev) => {
        if (prev.length === 0) {
          return prev;
        }

        const target = [...prev]
          .filter((node) => node.status === "running" || node.status === "waiting")
          .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];

        if (!target) {
          return prev;
        }

        const index = prev.findIndex((node) => node.id === target.id);
        if (index < 0 || prev[index].pausedAtMs) {
          return prev;
        }

        const next = [...prev];
        next[index] = {
          ...next[index],
          pausedAtMs: now,
          updatedAtMs: now
        };
        return next;
      });
    };

    const onApprovalResolved = (_event: ApprovalResolvedEvent): void => {
      const now = Date.now();
      setWeaveDagNodes((prev) => {
        if (prev.length === 0) {
          return prev;
        }

        const target = [...prev]
          .filter((node) => node.status === "running" || node.status === "waiting")
          .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];

        if (!target) {
          return prev;
        }

        const index = prev.findIndex((node) => node.id === target.id);
        if (index < 0 || !prev[index].pausedAtMs) {
          return prev;
        }

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
    gateway.on("agent:thought", onAgentThought);
    gateway.on("tool:start", onToolStart);
    gateway.on("tool:end", onToolEnd);
    gateway.on("agent:finish", onAgentFinish);
    gateway.on("agent:error", onAgentError);
    gateway.on("weave:dag", onWeaveDag);
    gateway.on("weave:dag-detail", onWeaveDagDetail);
    gateway.on("approval:pending", onApprovalPending);
    gateway.on("approval:resolved", onApprovalResolved);

    return () => {
      gateway.off("agent:start", onAgentStart);
      gateway.off("agent:thought", onAgentThought);
      gateway.off("tool:start", onToolStart);
      gateway.off("tool:end", onToolEnd);
      gateway.off("agent:finish", onAgentFinish);
      gateway.off("agent:error", onAgentError);
      gateway.off("weave:dag", onWeaveDag);
      gateway.off("weave:dag-detail", onWeaveDagDetail);
      gateway.off("approval:pending", onApprovalPending);
      gateway.off("approval:resolved", onApprovalResolved);
    };
  }, [gateway]);

  return {
    status,
    thoughtText,
    toolHistory,
    currentTool,
    chatLogs,
    weaveDagNodes,
    latestError
  };
}
