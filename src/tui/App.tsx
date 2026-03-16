import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { AgentRuntime, AgentRunEvent } from "../agent/run-agent.js";
import type { SessionRecorder } from "../session/session-recorder.js";
import { WeavePlugin } from "../weave/weave-plugin.js";
import { AgentUiEventGateway } from "./agent-ui-events.js";
import { useAgentState } from "./use-agent-state.js";
import { parseTurnInput, type WeaveMode } from "./weave-mode.js";

/**
 * 文件作用：Ink 顶层应用组件，负责输入、状态展示与事件桥接。
 */
interface AppProps {
  agent: AgentRuntime;
  recorder: SessionRecorder;
  sessionId: string;
  initialInput: string;
  onSessionEnd: (reason: string, turnCount: number) => void;
}

const THEME = {
  primary: "#F08A24",
  primaryStrong: "#FFB15D",
  border: "#8A5A2B",
  muted: "#C9A27A",
  text: "#FFF2E6",
  panelTitle: "#FFD7A8",
  user: "#FFD9B8",
  assistant: "#FFE7CE",
  success: "#8FD3A6",
  danger: "#F3A2A2",
  toolActive: "#FFC46B",
  detailBorder: "#A8743F",
  detailText: "#F0CFAD"
} as const;

function summarizeArgs(args: string): string {
  if (!args) {
    return "";
  }

  return args.length > 70 ? `${args.slice(0, 70)}...` : args;
}

function ensureVisibleCursor(value: string): string {
  return `${value}█`;
}

function fitInputPreview(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `…${text.slice(-(maxLength - 1))}`;
}

function summarizeLine(text: string, maxLength = 72): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (!singleLine) {
    return "";
  }

  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength)}...` : singleLine;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

interface TreeLine {
  id: string;
  parentId?: string;
  depth: number;
  branchPrefix: string;
  detailIndent: number;
  label: string;
  status: "running" | "waiting" | "success" | "fail";
  durationText: string;
  isCurrent: boolean;
  hasDetails: boolean;
  isExpanded: boolean;
  details: string[];
}

function parseNodePath(id: string): number[] {
  return id
    .split(".")
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n));
}

function compareNodeId(a: string, b: string): number {
  const ap = parseNodePath(a);
  const bp = parseNodePath(b);
  const max = Math.max(ap.length, bp.length);

  for (let i = 0; i < max; i += 1) {
    const av = ap[i] ?? -1;
    const bv = bp[i] ?? -1;
    if (av !== bv) {
      return av - bv;
    }
  }

  return 0;
}

function statusIcon(status: "running" | "waiting" | "success" | "fail"): string {
  if (status === "running") {
    return "◓";
  }
  if (status === "waiting") {
    return "•";
  }
  if (status === "success") {
    return "✔";
  }
  return "✖";
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildWeaveTreeLines(
  nodes: Array<{
    id: string;
    parentId?: string;
    label: string;
    status: "running" | "waiting" | "success" | "fail";
    startedAtMs: number;
    endedAtMs?: number;
    updatedAtMs: number;
    details: string[];
  }>,
  expandedNodeIds: Set<string>
): TreeLine[] {
  if (nodes.length === 0) {
    return [];
  }

  const byParent = new Map<
    string,
    Array<{
      id: string;
      parentId?: string;
      label: string;
      status: "running" | "waiting" | "success" | "fail";
      startedAtMs: number;
      endedAtMs?: number;
      updatedAtMs: number;
      details: string[];
    }>
  >();
  for (const node of nodes) {
    const parent = node.parentId ?? "__root__";
    const list = byParent.get(parent) ?? [];
    list.push(node);
    byParent.set(parent, list);
  }

  for (const [key, list] of byParent.entries()) {
    list.sort((a, b) => compareNodeId(a.id, b.id));
    byParent.set(key, list);
  }

  const lines: TreeLine[] = [];

  const walk = (
    list: Array<{
      id: string;
      parentId?: string;
      label: string;
      status: "running" | "waiting" | "success" | "fail";
      startedAtMs: number;
      endedAtMs?: number;
      updatedAtMs: number;
      details: string[];
    }>,
    prefix: string,
    depth: number
  ): void => {
    list.forEach((node, index) => {
      const isLast = index === list.length - 1;
      const branch = depth === 0 ? "" : `${isLast ? "└─" : "├─"} `;
      const branchPrefix = `${prefix}${branch}`;
      const durationMs = (node.endedAtMs ?? node.updatedAtMs) - node.startedAtMs;
      const durationText = durationMs >= 0 ? ` (${formatDurationMs(durationMs)})` : "";
      const hasDetails = node.details.length > 0;
      const defaultExpanded = node.status === "running" || node.status === "waiting";
      const isExpanded = hasDetails ? (expandedNodeIds.has(node.id) || defaultExpanded) : false;

      lines.push({
        id: node.id,
        parentId: node.parentId,
        depth,
        branchPrefix,
        detailIndent: branchPrefix.length,
        label: node.label,
        status: node.status,
        durationText,
        isCurrent: false,
        hasDetails,
        isExpanded,
        details: node.details
      });

      const children = byParent.get(node.id) ?? [];
      if (children.length > 0) {
        const childPrefix = depth === 0 ? "" : `${prefix}${isLast ? "   " : "│  "}`;
        walk(children, childPrefix, depth + 1);
      }
    });
  };

  const roots = byParent.get("__root__") ?? [];
  walk(roots, "", 0);

  const currentNode = [...nodes]
    .filter((node) => node.status === "running" || node.status === "waiting")
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
  if (currentNode) {
    const index = lines.findIndex((line) => line.id === currentNode.id);
    if (index >= 0) {
      lines[index] = {
        ...lines[index],
        isCurrent: true
      };
    }
  }

  return lines;
}

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const inputEnabled = Boolean(process.stdin.isTTY);
  const [input, setInput] = useState("");
  const [turnIndex, setTurnIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [weaveMode, setWeaveMode] = useState<WeaveMode>("off");
  const [weaveActiveTurn, setWeaveActiveTurn] = useState(false);
  const [approvalEditing, setApprovalEditing] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<{
    toolName: string;
    toolCallId: string;
    argsText: string;
  } | null>(null);
  const [sigintCount, setSigintCount] = useState(0);
  const [selectedDagNodeId, setSelectedDagNodeId] = useState("");
  const [expandedDagNodeIds, setExpandedDagNodeIds] = useState<Set<string>>(new Set());
  const [systemNote, setSystemNote] = useState("输入问题后回车发送，输入 /q /quit /exit 可退出会话。");

  const gateway = useMemo(() => new AgentUiEventGateway(), []);
  const uiState = useAgentState(gateway);

  const TRANSCRIPT_MAX_LINES = 200;
  const terminalWidth = clamp(process.stdout.columns || 100, 60, 180);
  const separatorWidth = clamp(terminalWidth - 2, 24, 176);
  const transcriptTextMax = clamp(terminalWidth - 8, 28, 140);
  const inputTextMax = clamp(terminalWidth - 18, 18, 120);

  const turnIndexRef = useRef(0);
  const lastRunIdRef = useRef("");
  const approvalResolverRef = useRef<((decision: { action: "approve" | "edit" | "skip" | "abort"; editedArgs?: unknown }) => void) | null>(null);
  const sigintTimerRef = useRef<NodeJS.Timeout | null>(null);
  const endedRef = useRef(false);

  const endSession = useCallback(
    (reason: string) => {
      if (endedRef.current) {
        return;
      }

      endedRef.current = true;
      if (sigintTimerRef.current) {
        clearTimeout(sigintTimerRef.current);
      }

      props.recorder.end(reason);
      props.onSessionEnd(reason, turnIndexRef.current);
      exit();
    },
    [exit, props]
  );

  const processTurn = useCallback(
    async (rawInput: string) => {
      const parsed = parseTurnInput(rawInput, weaveMode);

      if (parsed.modeCommand) {
        setWeaveMode(parsed.modeCommand);
        setWeaveActiveTurn(parsed.modeCommand !== "off");
        setSystemNote(`Weave 会话模式已切换为 ${parsed.modeCommand.toUpperCase()}`);
        return;
      }

      if (!parsed.question) {
        setSystemNote("请输入问题内容，例如：/weave 帮我分析这段代码");
        return;
      }

      const nextTurn = turnIndexRef.current + 1;
      turnIndexRef.current = nextTurn;
      setTurnIndex(nextTurn);
      setWeaveActiveTurn(parsed.enableWeave);
      setBusy(true);
      setSystemNote(
        parsed.enableWeave
          ? `本轮已启用 Weave (${parsed.stepMode ? "STEP" : "DAG"}) 模式`
          : "本轮使用普通模式"
      );

      props.recorder.recordUser(nextTurn, rawInput);

      const plugins = parsed.enableWeave ? [new WeavePlugin()] : [];
      try {
        const finalText = await props.agent.runOnceStream(parsed.question, {
          plugins,
          stepMode: parsed.enableWeave && parsed.stepMode,
          approveToolCall:
            parsed.enableWeave && parsed.stepMode
              ? async (request) => {
                  return new Promise((resolve) => {
                    approvalResolverRef.current = resolve;
                    setApprovalEditing(false);
                    setPendingApproval({
                      toolName: request.toolName,
                      toolCallId: request.toolCallId,
                      argsText: request.argsText || "{}"
                    });
                    setInput("");
                    setSystemNote("Step Gate: Enter=放行, E=编辑参数, S=跳过, Q=终止本轮");
                  });
                }
              : undefined
        });
        props.recorder.recordAssistant(nextTurn, finalText, lastRunIdRef.current);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        props.recorder.recordError(nextTurn, errorMessage, lastRunIdRef.current);
      } finally {
        approvalResolverRef.current = null;
        setPendingApproval(null);
        setApprovalEditing(false);
        setBusy(false);
      }
    },
    [props, weaveMode]
  );

  useEffect(() => {
    const onRuntimeEvent = (event: AgentRunEvent): void => {
      if (event.type === "run.start") {
        lastRunIdRef.current = event.runId;
      }
      gateway.mapFromRuntime(event);
    };

    props.agent.on("event", onRuntimeEvent);
    return () => {
      props.agent.off("event", onRuntimeEvent);
    };
  }, [gateway, props.agent]);

  useEffect(() => {
    if (!props.initialInput) {
      return;
    }

    void processTurn(props.initialInput);
  }, [processTurn, props.initialInput]);

  const weaveNodeIds = useMemo(
    () => uiState.weaveDagNodes.map((node) => node.id).sort(compareNodeId),
    [uiState.weaveDagNodes]
  );

  useEffect(() => {
    if (weaveNodeIds.length === 0) {
      setSelectedDagNodeId("");
      setExpandedDagNodeIds(new Set());
      return;
    }
    const latestNodeId = weaveNodeIds[weaveNodeIds.length - 1];

    setSelectedDagNodeId((prev) => {
      if (!prev || !weaveNodeIds.includes(prev)) {
        return latestNodeId;
      }

      return latestNodeId;
    });

    setExpandedDagNodeIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (weaveNodeIds.includes(id)) {
          next.add(id);
        }
      }

      next.add(latestNodeId);

      return next;
    });
  }, [uiState.weaveDagNodes, weaveNodeIds]);

  useInput((value, key) => {
    if (key.ctrl && value.toLowerCase() === "c") {
      if (sigintCount === 0) {
        setSigintCount(1);
        setSystemNote("检测到 Ctrl+C，再按一次将退出当前会话。");
        if (sigintTimerRef.current) {
          clearTimeout(sigintTimerRef.current);
        }
        sigintTimerRef.current = setTimeout(() => {
          setSigintCount(0);
        }, 1500);
        return;
      }

      endSession("double-ctrl-c");
      return;
    }

    if (pendingApproval) {
      if (approvalEditing) {
        if (key.return) {
          try {
            const editedArgs = JSON.parse(input || "{}");
            approvalResolverRef.current?.({ action: "edit", editedArgs });
            approvalResolverRef.current = null;
            setPendingApproval(null);
            setApprovalEditing(false);
            setInput("");
            setSystemNote("Step Gate: 已按编辑参数放行。");
          } catch {
            setSystemNote("参数不是合法 JSON，请继续编辑或按 Esc 取消编辑。");
          }
          return;
        }

        if (key.escape) {
          setApprovalEditing(false);
          setInput("");
          setSystemNote("已退出参数编辑，Step Gate: Enter=放行, E=编辑, S=跳过, Q=终止");
          return;
        }

        if (key.backspace || key.delete) {
          setInput((prev) => prev.slice(0, -1));
          return;
        }

        if (value) {
          setInput((prev) => prev + value);
        }
        return;
      }

      const lower = value.toLowerCase();
      if (key.return) {
        approvalResolverRef.current?.({ action: "approve" });
        approvalResolverRef.current = null;
        setPendingApproval(null);
        setSystemNote("Step Gate: 已放行工具执行。");
        return;
      }

      if (lower === "e") {
        setApprovalEditing(true);
        setInput(pendingApproval.argsText || "{}");
        setSystemNote("请输入新的 JSON 参数后回车提交，Esc 取消编辑。");
        return;
      }

      if (lower === "s") {
        approvalResolverRef.current?.({ action: "skip" });
        approvalResolverRef.current = null;
        setPendingApproval(null);
        setSystemNote("Step Gate: 已跳过本次工具调用。");
        return;
      }

      if (lower === "q") {
        approvalResolverRef.current?.({ action: "abort" });
        approvalResolverRef.current = null;
        setPendingApproval(null);
        setSystemNote("Step Gate: 已终止本轮执行。");
      }
      return;
    }

    if (input.trim() === "" && weaveNodeIds.length > 0 && key.upArrow) {
      const currentIndex = Math.max(0, weaveNodeIds.indexOf(selectedDagNodeId));
      const nextIndex = Math.max(0, currentIndex - 1);
      setSelectedDagNodeId(weaveNodeIds[nextIndex]);
      return;
    }

    if (input.trim() === "" && weaveNodeIds.length > 0 && key.downArrow) {
      const currentIndex = Math.max(0, weaveNodeIds.indexOf(selectedDagNodeId));
      const nextIndex = Math.min(weaveNodeIds.length - 1, currentIndex + 1);
      setSelectedDagNodeId(weaveNodeIds[nextIndex]);
      return;
    }

    if (key.return && input.trim() === "") {
      if (selectedDagNodeId) {
        const targetNode = uiState.weaveDagNodes.find((node) => node.id === selectedDagNodeId);
        if (targetNode && targetNode.details.length > 0) {
          setExpandedDagNodeIds((prev) => {
            const next = new Set(prev);
            if (next.has(selectedDagNodeId)) {
              next.delete(selectedDagNodeId);
            } else {
              next.add(selectedDagNodeId);
            }
            return next;
          });
        }
      }
      return;
    }

    if (busy) {
      return;
    }

    if (key.return) {
      const trimmed = input.trim();
      if (trimmed === "/q" || trimmed === "/quit" || trimmed === "/exit") {
        endSession(`command:${trimmed}`);
        return;
      }

      setInput("");
      void processTurn(trimmed);
      return;
    }

    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }

    if (value) {
      setInput((prev) => prev + value);
    }
  }, { isActive: inputEnabled });

  const transcriptLines: Array<{ id: string; role: "user" | "assistant" | "system"; text: string; isDivider?: boolean }> = [];
  uiState.chatLogs.slice(-TRANSCRIPT_MAX_LINES).forEach((log) => {
    if (weaveActiveTurn && log.role === "system") {
      return;
    }

    if (log.role === "system" && log.text === "__turn_divider__") {
      transcriptLines.push({
        id: `${log.id}-line`,
        role: "system",
        text: "",
        isDivider: true
      });
      return;
    }

    if (log.role === "system") {
      transcriptLines.push({
        id: `${log.id}-line`,
        role: "system",
        text: `· ${summarizeLine(log.text, transcriptTextMax)}`
      });
      return;
    }

    const prefix = log.role === "user" ? "›" : "‹";
    const lines = log.text.split(/\r?\n/);
    lines.forEach((part, index) => {
      transcriptLines.push({
        id: `${log.id}-line-${index}`,
        role: log.role,
        text: index === 0 ? `${prefix} ${part}` : `  ${part}`
      });
    });
  });

  if (transcriptLines.length > TRANSCRIPT_MAX_LINES) {
    transcriptLines.splice(0, transcriptLines.length - TRANSCRIPT_MAX_LINES);
  }

  const visibleTranscriptLines = weaveActiveTurn ? [] : transcriptLines.slice(-TRANSCRIPT_MAX_LINES);
  const weaveTreeLines = buildWeaveTreeLines(uiState.weaveDagNodes, expandedDagNodeIds);

  const statusText =
    uiState.status === "thinking"
      ? "thinking"
      : uiState.status === "using_tool"
        ? "using tool"
        : uiState.status === "done"
          ? "done"
          : uiState.status === "error"
            ? "error"
            : "idle";

  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="column">
        <Text color={THEME.primaryStrong}>openclaw tui · session {props.sessionId}</Text>
        <Text color={THEME.muted}>
          {systemNote} | {statusText}
          {uiState.currentTool ? ` | tool: ${uiState.currentTool.toolName} ...` : ""}
          {` | turn ${turnIndex}`}
          {` | weave=${weaveMode}`}
          {selectedDagNodeId ? ` | dag:${selectedDagNodeId} (↑/↓ 选中, 回车折叠)` : ""}
        </Text>
        <Text color={THEME.border}>{"─".repeat(separatorWidth)}</Text>
      </Box>

      <Box marginTop={0} flexDirection="column">
        {weaveTreeLines.length > 0 ? (
          <Box borderStyle="round" borderColor={THEME.border} paddingX={1} flexDirection="column" marginBottom={1}>
            <Text color={THEME.primaryStrong}>⎈ WEAVE DAG</Text>
            {weaveTreeLines.map((line) => {
              const selected = line.id === selectedDagNodeId;
              const foldPrefix = line.hasDetails ? (line.isExpanded ? "[-] " : "[+] ") : "";
              const nodeText = `${line.branchPrefix}${foldPrefix}${statusIcon(line.status)} Node ${line.id}: ${line.label}${line.durationText}`;
              const prefix = selected ? "▸ " : "  ";

              return (
                <Box key={`weave-${line.id}`} flexDirection="column">
                  <Text
                    color={
                      selected
                        ? THEME.panelTitle
                        : line.isCurrent
                          ? THEME.panelTitle
                          : line.status === "running"
                            ? THEME.primaryStrong
                            : line.status === "waiting"
                              ? THEME.toolActive
                              : line.status === "success"
                                ? THEME.success
                                : THEME.danger
                    }
                  >
                        {prefix}{summarizeLine(nodeText, transcriptTextMax)}
                  </Text>

                  {line.hasDetails && line.isExpanded ? (
                    <Box marginLeft={Math.min(line.detailIndent + 2, 24)} borderStyle="round" borderColor={THEME.detailBorder} paddingX={1} flexDirection="column">
                      {line.details.map((detail, detailIndex) => (
                        <Text key={`weave-${line.id}-detail-${detailIndex}`} color={selected ? THEME.panelTitle : THEME.detailText}>
                          {detail}
                        </Text>
                      ))}
                    </Box>
                  ) : null}
                </Box>
              );
            })}

            {pendingApproval ? (
              <Box borderStyle="round" borderColor={THEME.toolActive} paddingX={1} flexDirection="column" marginTop={1}>
                <Text color={THEME.toolActive}>⏸ STEP GATE · 等待放行</Text>
                <Text color={THEME.text}>tool: {pendingApproval.toolName}</Text>
                <Text color={THEME.detailText}>args: {pendingApproval.argsText}</Text>
                <Text color={THEME.muted}>
                  {approvalEditing
                    ? "编辑参数中：回车提交，Esc 取消"
                    : "Enter=放行 | E=编辑 | S=跳过 | Q=终止本轮"}
                </Text>
              </Box>
            ) : null}
          </Box>
        ) : null}

        {visibleTranscriptLines.map((line) => (
          line.isDivider ? (
            <Text key={line.id} color={THEME.border}>
              {"─".repeat(separatorWidth)}
            </Text>
          ) : (
            <Text
              key={line.id}
              color={line.role === "user" ? THEME.user : line.role === "assistant" ? THEME.assistant : THEME.muted}
            >
              {line.text}
            </Text>
          )
        ))}
      </Box>

      <Box marginTop={0} borderStyle="single" borderColor={THEME.primary} paddingX={1}>
        <Text color={THEME.primary}>{pendingApproval && approvalEditing ? "edit(args) ▸ " : `你(${turnIndex + 1}) ▸ `}</Text>
        <Text color={THEME.text}>
          {ensureVisibleCursor(
            fitInputPreview(
              input || (busy ? (pendingApproval ? "(等待 Step Gate 决策...)" : "(处理中，稍候...)") : ""),
              inputTextMax
            )
          )}
        </Text>
      </Box>
    </Box>
  );
}
