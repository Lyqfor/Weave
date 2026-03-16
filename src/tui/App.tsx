import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { AgentRuntime, AgentRunEvent } from "../agent/run-agent.js";
import { dispatchUserInput } from "../agent/message-dispatcher.js";
import type { SessionRecorder } from "../session/session-recorder.js";
import { WeavePlugin } from "../weave/weave-plugin.js";
import { AgentUiEventGateway } from "./agent-ui-events.js";
import { useAgentState } from "./use-agent-state.js";
import type { WeaveMode } from "./weave-mode.js";

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
  waiting: "#F2C94C",
  running: "#58C4DD",
  detailBorder: "#A8743F",
  detailText: "#F0CFAD"
} as const;

function summarizeArgs(args: string): string {
  if (!args) {
    return "";
  }

  return args.length > 70 ? `${args.slice(0, 70)}...` : args;
}

function isBackspaceKey(value: string, key: { backspace?: boolean; delete?: boolean; ctrl?: boolean }): boolean {
  if (key.backspace) {
    return true;
  }

  // Windows 终端下 Backspace 可能以控制字符传入。
  if (value === "\b" || value === "\x7f") {
    return true;
  }

  // 兼容部分终端将 Backspace 映射到 delete 且无可打印字符。
  if (key.delete && value === "") {
    return true;
  }

  if (key.ctrl && value.toLowerCase() === "h") {
    return true;
  }

  return false;
}

function isPrintableInput(value: string): boolean {
  if (!value) {
    return false;
  }

  return !/[\x00-\x1F\x7F]/.test(value);
}

function ensureVisibleCursor(value: string): string {
  return `${value}█`;
}

function charDisplayWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
    return 0;
  }

  const isWide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6);

  return isWide ? 2 : 1;
}

function renderInputWithCursor(value: string, cursor: number, maxLength: number): string {
  const safeCursor = clamp(cursor, 0, value.length);
  const chars = Array.from(value);
  const withCursorChars = [...chars.slice(0, safeCursor), "█", ...chars.slice(safeCursor)];
  const totalWidth = withCursorChars.reduce((sum, char) => sum + charDisplayWidth(char), 0);

  if (totalWidth <= maxLength) {
    return withCursorChars.join("");
  }

  const cursorIndex = safeCursor;
  const prefixWidth = new Array<number>(withCursorChars.length + 1).fill(0);
  for (let i = 0; i < withCursorChars.length; i += 1) {
    prefixWidth[i + 1] = prefixWidth[i] + charDisplayWidth(withCursorChars[i]);
  }

  const rangeWidth = (start: number, endExclusive: number): number => prefixWidth[endExclusive] - prefixWidth[start];
  const buildDisplay = (left: number, rightExclusive: number): string => {
    const hasLeft = left > 0;
    const hasRight = rightExclusive < withCursorChars.length;
    const body = withCursorChars.slice(left, rightExclusive).join("");
    return `${hasLeft ? "…" : ""}${body}${hasRight ? "…" : ""}`;
  };

  let left = cursorIndex;
  let rightExclusive = cursorIndex + 1;

  const canUseRange = (nextLeft: number, nextRightExclusive: number): boolean => {
    const hasLeft = nextLeft > 0;
    const hasRight = nextRightExclusive < withCursorChars.length;
    const ellipsisCost = (hasLeft ? 1 : 0) + (hasRight ? 1 : 0);
    return rangeWidth(nextLeft, nextRightExclusive) + ellipsisCost <= maxLength;
  };

  while (true) {
    let changed = false;

    if (rightExclusive < withCursorChars.length && canUseRange(left, rightExclusive + 1)) {
      rightExclusive += 1;
      changed = true;
    }

    if (left > 0 && canUseRange(left - 1, rightExclusive)) {
      left -= 1;
      changed = true;
    }

    if (!changed) {
      break;
    }
  }

  return buildDisplay(left, rightExclusive);
}

function fitInputPreview(text: string, maxLength: number): string {
  if (!text) {
    return text;
  }

  const chars = Array.from(text);
  let width = 0;
  const kept: string[] = [];

  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const char = chars[i];
    const next = charDisplayWidth(char);
    if (width + next > Math.max(1, maxLength - 1)) {
      break;
    }

    kept.push(char);
    width += next;
  }

  if (kept.length === chars.length) {
    return text;
  }

  return `…${kept.reverse().join("")}`;
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

function estimateDisplayWidth(text: string): number {
  // 终端宽度按“显示列”计数；使用统一字符宽度函数，避免估算口径不一致。
  return Array.from(text).reduce((sum, char) => sum + charDisplayWidth(char), 0);
}

function areSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }

  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }

  return true;
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
    return "⏸";
  }
  if (status === "success") {
    return "✔";
  }
  return "✖";
}

function isLowSignalDecisionLabel(label: string): boolean {
  const normalized = label.trim();
  return (
    normalized === "大模型决策中..." ||
    normalized === "决策为调用工具" ||
    normalized === "大模型决策完成" ||
    normalized === "大模型决策完成，进入下一轮"
  );
}

function extractDetailValue(details: string[], key: string): string {
  const line = details.find((item) => item.startsWith(`${key}=`));
  if (!line) {
    return "";
  }

  return line.slice(key.length + 1).trim();
}

function semanticToolTitle(label: string, details: string[]): string {
  const command = extractDetailValue(details, "command");
  const file = extractDetailValue(details, "file");

  if (label.includes("执行命令") && command) {
    return `⚡ 运行命令: [${command}]`;
  }

  if (label.includes("读取文件") && file) {
    return `📄 查阅文件: [${file}]`;
  }

  if (label.includes("写入文件") && file) {
    return `✏️ 写入文件: [${file}]`;
  }

  if (label.includes("执行命令")) {
    return "⚡ 运行命令";
  }

  if (label.includes("读取文件")) {
    return "📄 查阅文件";
  }

  if (label.includes("写入文件")) {
    return "✏️ 写入文件";
  }

  return label;
}

function summarizeApprovalIntent(toolName: string, argsText: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsText) as Record<string, unknown>;
  } catch {
    args = {};
  }

  if (toolName === "command_exec") {
    const command = typeof args.command === "string" ? args.command : "";
    return command ? `⚡ 运行命令: [${command}]` : "⚡ 运行命令";
  }

  if (toolName === "read_file") {
    const filePath = typeof args.filePath === "string"
      ? args.filePath
      : typeof args.path === "string"
        ? args.path
        : "";
    return filePath ? `📄 查阅文件: [${filePath}]` : "📄 查阅文件";
  }

  if (toolName === "write_file") {
    const filePath = typeof args.filePath === "string"
      ? args.filePath
      : typeof args.path === "string"
        ? args.path
        : "";
    return filePath ? `✏️ 写入文件: [${filePath}]` : "✏️ 写入文件";
  }

  return `执行工具: ${toolName}`;
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
    pausedAtMs?: number;
    pausedDurationMs: number;
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
      pausedAtMs?: number;
      pausedDurationMs: number;
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
      pausedAtMs?: number;
      pausedDurationMs: number;
      details: string[];
    }>,
    prefix: string,
    depth: number
  ): void => {
    list.forEach((node, index) => {
      const children = byParent.get(node.id) ?? [];
      const shouldFlattenThisNode =
        !node.id.includes(".") && children.length > 0 && isLowSignalDecisionLabel(node.label);

      if (shouldFlattenThisNode) {
        walk(children, prefix, depth);
        return;
      }

      const isLast = index === list.length - 1;
      const branch = depth === 0 ? "" : `${isLast ? "└─" : "├─"} `;
      const branchPrefix = `${prefix}${branch}`;
      const activePausedMs = node.pausedAtMs ? Math.max(0, Date.now() - node.pausedAtMs) : 0;
      const pausedDurationMs = Math.max(0, (node.pausedDurationMs ?? 0) + activePausedMs);
      const durationMs = Math.max(0, (node.endedAtMs ?? node.updatedAtMs) - node.startedAtMs - pausedDurationMs);
      const durationText = durationMs >= 0 ? ` (${formatDurationMs(durationMs)})` : "";
      const hasDetails = node.details.length > 0;
      const isExpanded = hasDetails ? expandedNodeIds.has(node.id) : false;

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

function buildVisibleDagNodeIds(
  nodes: Array<{
    id: string;
    parentId?: string;
    label: string;
  }>
): string[] {
  if (nodes.length === 0) {
    return [];
  }

  const byParent = new Map<string, Array<{ id: string; parentId?: string; label: string }>>();
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

  const visibleIds: string[] = [];

  const walk = (list: Array<{ id: string; parentId?: string; label: string }>): void => {
    for (const node of list) {
      const children = byParent.get(node.id) ?? [];
      const shouldFlattenThisNode =
        !node.id.includes(".") && children.length > 0 && isLowSignalDecisionLabel(node.label);

      if (shouldFlattenThisNode) {
        walk(children);
        continue;
      }

      visibleIds.push(node.id);
      if (children.length > 0) {
        walk(children);
      }
    }
  };

  walk(byParent.get("__root__") ?? []);
  return visibleIds;
}

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const inputEnabled = Boolean(process.stdin.isTTY);
  const [input, setInput] = useState("");
  const [inputCursor, setInputCursor] = useState(0);
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
  const contentWidth = separatorWidth;
  const rootWidth = contentWidth + 2;
  const transcriptTextMax = clamp(terminalWidth - 8, 28, 140);

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
      const dispatched = dispatchUserInput(rawInput, weaveMode);

      if (dispatched.kind === "mode-change") {
        setWeaveMode(dispatched.mode);
        setWeaveActiveTurn(dispatched.mode !== "off");
        setSystemNote(`Weave 会话模式已切换为 ${dispatched.mode.toUpperCase()}`);
        return;
      }

      if (dispatched.kind === "quit") {
        endSession(`command:${dispatched.command}`);
        return;
      }

      if (dispatched.kind === "empty") {
        setSystemNote("请输入问题内容，例如：/weave 帮我分析这段代码");
        return;
      }

      const parsed = dispatched;

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
                    setInputCursor(0);
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
        setInputCursor(0);
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

  const weaveTreeLines = useMemo(
    () => buildWeaveTreeLines(uiState.weaveDagNodes, expandedDagNodeIds),
    [uiState.weaveDagNodes, expandedDagNodeIds]
  );
  const visibleDagNodeIds = useMemo(
    () => buildVisibleDagNodeIds(uiState.weaveDagNodes),
    [uiState.weaveDagNodes]
  );
  const runActive = busy || uiState.status === "thinking" || uiState.status === "using_tool";
  const activeDagNodeId = useMemo(() => {
    const current = [...uiState.weaveDagNodes]
      .filter((node) => node.status === "running" || node.status === "waiting")
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
    return current?.id ?? "";
  }, [uiState.weaveDagNodes]);
  const previousActiveDagNodeIdRef = useRef("");

  useEffect(() => {
    if (visibleDagNodeIds.length === 0) {
      setSelectedDagNodeId((prev) => (prev ? "" : prev));
      setExpandedDagNodeIds((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }

    const latestNodeId = visibleDagNodeIds[visibleDagNodeIds.length - 1];

    setSelectedDagNodeId((prev) => {
      if (!prev || !visibleDagNodeIds.includes(prev)) {
        return latestNodeId;
      }

      return prev;
    });

    setExpandedDagNodeIds((prev) => {
      if (prev.size === 0) {
        return new Set<string>([latestNodeId]);
      }

      const next = new Set<string>();
      for (const id of prev) {
        if (visibleDagNodeIds.includes(id)) {
          next.add(id);
        }
      }

      if (next.size === 0) {
        next.add(latestNodeId);
      }

      if (areSetsEqual(prev, next)) {
        return prev;
      }

      return next;
    });
  }, [visibleDagNodeIds]);

  useEffect(() => {
    if (!weaveActiveTurn) {
      previousActiveDagNodeIdRef.current = "";
      return;
    }

    if (activeDagNodeId) {
      setSelectedDagNodeId((prev) => (prev === activeDagNodeId ? prev : activeDagNodeId));
      setExpandedDagNodeIds((prev) => {
        const next = new Set(prev);
        const previousActive = previousActiveDagNodeIdRef.current;
        if (previousActive && previousActive !== activeDagNodeId) {
          next.delete(previousActive);
        }

        next.add(activeDagNodeId);
        if (areSetsEqual(prev, next)) {
          return prev;
        }

        return next;
      });

      previousActiveDagNodeIdRef.current = activeDagNodeId;
      return;
    }

    if (!runActive && visibleDagNodeIds.length > 0) {
      const lastNodeId = visibleDagNodeIds[visibleDagNodeIds.length - 1];
      setSelectedDagNodeId((prev) => (prev === lastNodeId ? prev : lastNodeId));
      setExpandedDagNodeIds((prev) => {
        const next = new Set<string>([lastNodeId]);
        if (areSetsEqual(prev, next)) {
          return prev;
        }
        return next;
      });
      previousActiveDagNodeIdRef.current = "";
    }
  }, [weaveActiveTurn, activeDagNodeId, runActive, visibleDagNodeIds]);

  useEffect(() => {
    setInputCursor((prev) => clamp(prev, 0, input.length));
  }, [input]);

  useInput((value, key) => {
    const isBackspace = isBackspaceKey(value, key);

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
            setInputCursor(0);
            setSystemNote("Step Gate: 已按编辑参数放行。");
          } catch {
            setSystemNote("参数不是合法 JSON，请继续编辑或按 Esc 取消编辑。");
          }
          return;
        }

        if (key.escape) {
          setApprovalEditing(false);
          setInput("");
          setInputCursor(0);
          setSystemNote("已退出参数编辑，Step Gate: Enter=放行, E=编辑, S=跳过, Q=终止");
          return;
        }

        if (key.leftArrow) {
          setInputCursor((prev) => Math.max(0, prev - 1));
          return;
        }

        if (key.rightArrow) {
          setInputCursor((prev) => Math.min(input.length, prev + 1));
          return;
        }

        if (key.home) {
          setInputCursor(0);
          return;
        }

        if (key.end) {
          setInputCursor(input.length);
          return;
        }

        if (isBackspace) {
          setInput((prev) => {
            if (inputCursor <= 0) {
              return prev;
            }

            return `${prev.slice(0, inputCursor - 1)}${prev.slice(inputCursor)}`;
          });
          setInputCursor((prev) => Math.max(0, prev - 1));
          return;
        }

        if (key.delete) {
          setInput((prev) => {
            if (inputCursor >= prev.length) {
              return prev;
            }

            return `${prev.slice(0, inputCursor)}${prev.slice(inputCursor + 1)}`;
          });
          return;
        }

        if (isPrintableInput(value)) {
          setInput((prev) => `${prev.slice(0, inputCursor)}${value}${prev.slice(inputCursor)}`);
          setInputCursor((prev) => prev + value.length);
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
        setInputCursor((pendingApproval.argsText || "{}").length);
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

    if (input.trim() === "" && visibleDagNodeIds.length > 0 && key.upArrow) {
      const currentIndex = Math.max(0, visibleDagNodeIds.indexOf(selectedDagNodeId));
      const nextIndex = Math.max(0, currentIndex - 1);
      setSelectedDagNodeId(visibleDagNodeIds[nextIndex]);
      return;
    }

    if (input.trim() === "" && visibleDagNodeIds.length > 0 && key.downArrow) {
      const currentIndex = Math.max(0, visibleDagNodeIds.indexOf(selectedDagNodeId));
      const nextIndex = Math.min(visibleDagNodeIds.length - 1, currentIndex + 1);
      setSelectedDagNodeId(visibleDagNodeIds[nextIndex]);
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

    if (key.leftArrow) {
      setInputCursor((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.rightArrow) {
      setInputCursor((prev) => Math.min(input.length, prev + 1));
      return;
    }

    if (key.home) {
      setInputCursor(0);
      return;
    }

    if (key.end) {
      setInputCursor(input.length);
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
      setInputCursor(0);
      void processTurn(trimmed);
      return;
    }

    if (isBackspace) {
      setInput((prev) => {
        if (inputCursor <= 0) {
          return prev;
        }

        return `${prev.slice(0, inputCursor - 1)}${prev.slice(inputCursor)}`;
      });
      setInputCursor((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.delete) {
      setInput((prev) => {
        if (inputCursor >= prev.length) {
          return prev;
        }

        return `${prev.slice(0, inputCursor)}${prev.slice(inputCursor + 1)}`;
      });
      return;
    }

    if (isPrintableInput(value)) {
      setInput((prev) => `${prev.slice(0, inputCursor)}${value}${prev.slice(inputCursor)}`);
      setInputCursor((prev) => prev + value.length);
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

  const latestUserQuestion = useMemo(() => {
    for (let i = uiState.chatLogs.length - 1; i >= 0; i -= 1) {
      const log = uiState.chatLogs[i];
      if (log.role === "user" && log.text.trim()) {
        return log.text;
      }
    }
    return "";
  }, [uiState.chatLogs]);

  const visibleTranscriptLines = weaveActiveTurn ? [] : transcriptLines.slice(-TRANSCRIPT_MAX_LINES);

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

  const inputPrefix = pendingApproval && approvalEditing ? "edit(args) ▸ " : `你(${turnIndex + 1}) ▸ `;
  // single + paddingX(1+1) + border(1+1) = 4 列开销。
  const inputInnerWidth = Math.max(12, contentWidth - 4);
  const inputPrefixWidth = estimateDisplayWidth(inputPrefix);
  const inputTextMax = Math.max(8, inputInnerWidth - inputPrefixWidth);

  return (
    <Box flexDirection="column" padding={1} width={rootWidth}>
      <Box flexDirection="column" width={contentWidth}>
        <Text color={THEME.primaryStrong}>Weave · session {props.sessionId}</Text>
        <Text color={THEME.muted}>
          {systemNote} | {statusText}
          {uiState.currentTool ? ` | tool: ${uiState.currentTool.toolName} ...` : ""}
          {` | turn ${turnIndex}`}
          {` | weave=${weaveMode}`}
          {selectedDagNodeId ? ` | dag:${selectedDagNodeId} (↑/↓ 选中, 回车折叠)` : ""}
        </Text>
        <Text color={THEME.border}>{"─".repeat(separatorWidth)}</Text>
      </Box>

      <Box marginTop={0} flexDirection="column" width={contentWidth}>
        {weaveTreeLines.length > 0 ? (
          <Box borderStyle="round" borderColor={THEME.border} paddingX={1} flexDirection="column" marginBottom={1} width={contentWidth}>
            <Text color={THEME.primaryStrong}>⎈ WEAVE DAG</Text>
            {latestUserQuestion ? (
              <Box marginBottom={1}>
                <Text color={THEME.muted}>问题: {latestUserQuestion}</Text>
              </Box>
            ) : null}
            {weaveTreeLines.map((line) => {
              const selected = line.id === selectedDagNodeId;
              const foldPrefix = line.hasDetails ? (line.isExpanded ? "[-] " : "[+] ") : "";
              const nodeKind = line.id.includes(".") ? "工具" : "决策";
              const semanticLabel = line.id.includes(".") ? semanticToolTitle(line.label, line.details) : line.label;
              const nodeText = `${line.branchPrefix}${foldPrefix}${statusIcon(line.status)} [${nodeKind}] ${line.id} ${semanticLabel}${line.durationText}`;
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
                            ? THEME.running
                            : line.status === "waiting"
                              ? THEME.waiting
                              : line.status === "success"
                                ? THEME.success
                                : THEME.danger
                    }
                  >
                    {prefix}{nodeText}
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
              <Box borderStyle="round" borderColor={THEME.waiting} paddingX={1} flexDirection="column" marginTop={1}>
                <Text color={THEME.waiting}>⏸ STEP GATE · 等待放行</Text>
                <Text color={THEME.text}>{summarizeApprovalIntent(pendingApproval.toolName, pendingApproval.argsText)}</Text>
                {approvalEditing ? (
                  <Text color={THEME.detailText}>args: {pendingApproval.argsText}</Text>
                ) : null}
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

      <Box marginTop={0} borderStyle="single" borderColor={THEME.primary} paddingX={1} width={contentWidth}>
        <Text color={THEME.primary}>{inputPrefix}</Text>
        <Text color={THEME.text}>
          {input
            ? renderInputWithCursor(input, inputCursor, inputTextMax)
            : ensureVisibleCursor(
                fitInputPreview(
                  busy ? (pendingApproval ? "(等待 Step Gate 决策...)" : "(处理中，稍候...)") : "",
                  inputTextMax
                )
              )}
        </Text>
      </Box>
    </Box>
  );
}
