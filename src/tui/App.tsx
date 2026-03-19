import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { AgentRuntime, AgentRunEvent } from "../agent/run-agent.js";
import { dispatchUserInput } from "../agent/message-dispatcher.js";
import type { SessionRecorder } from "../session/session-recorder.js";
import { AgentUiEventGateway } from "./agent-ui-events.js";
import { useAgentState } from "./use-agent-state.js";
import type { WeaveMode } from "./weave-mode.js";
import { summarizeArgs } from "../utils/text-utils.js";
import { THEME } from "../config/defaults.js";
import {
  clamp,
  summarizeLine,
  estimateDisplayWidth,
  areSetsEqual,
  isBackspaceKey,
  isPrintableInput,
  buildInputDisplayText
} from "./tui-helpers.js";
import {
  type DagDisplayStatus,
  type TreeLine,
  statusIcon,
  semanticToolTitle,
  isRepairLlmNodeLabel,
  summarizeApprovalIntent,
  buildWeaveTreeLines,
  buildVisibleDagNodeIds
} from "./dag-tree.js";

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
  const webPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const endedRef = useRef(false);

  const cancelWebPoll = useCallback(() => {
    if (webPollTimerRef.current) {
      clearInterval(webPollTimerRef.current);
      webPollTimerRef.current = null;
    }
  }, []);

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
          ? `本轮已启用 Weave (${parsed.stepMode ? "STEP" : parsed.autoMode ? "AUTO" : "OBSERVE"}) 模式`
          : "本轮使用普通模式"
      );

      props.recorder.recordUser(nextTurn, rawInput);

      const plugins: import("../agent/plugins/agent-plugin.js").AgentLoopPlugin[] = [];
      try {
        const finalText = await props.agent.runOnceStream(parsed.question, {
          plugins,
          stepMode: parsed.enableWeave && parsed.stepMode,
          autoMode: parsed.enableWeave && parsed.autoMode,
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

                    // 若已配置图服务，通知 Web 前端显示审批面板并轮询决策
                    const ingestUrl = process.env.WEAVE_GRAPH_INGEST_URL?.trim() ?? "";
                    const ingestToken = process.env.WEAVE_GRAPH_TOKEN?.trim() ?? "";
                    if (ingestUrl) {
                      const serverBase = ingestUrl.replace(/\/ingest\/runtime-event$/, "");
                      // 发送 gate.pending 事件让服务端广播给前端
                      void fetch(ingestUrl, {
                        method: "POST",
                        headers: {
                          "content-type": "application/json",
                          ...(ingestToken ? { "x-graph-token": ingestToken } : {})
                        },
                        body: JSON.stringify({
                          runId: lastRunIdRef.current,
                          type: "tool.gate.pending",
                          timestamp: new Date().toISOString(),
                          payload: {
                            toolCallId: request.toolCallId,
                            toolName: request.toolName,
                            toolParams: request.argsText || "{}"
                          }
                        })
                      }).catch(() => { /* 忽略网络错误 */ });

                      // 轮询服务端获取 Web 前端的审批决策
                      if (webPollTimerRef.current) {
                        clearInterval(webPollTimerRef.current);
                      }
                      webPollTimerRef.current = setInterval(() => {
                        void fetch(`${serverBase}/api/gate/decision/${request.toolCallId}`, {
                          headers: ingestToken ? { "x-graph-token": ingestToken } : {}
                        }).then(async (resp) => {
                          if (resp.status === 200) {
                            const data = await resp.json() as { action?: string; params?: string };
                            if (data.action && approvalResolverRef.current) {
                              clearInterval(webPollTimerRef.current!);
                              webPollTimerRef.current = null;
                              // 通知服务端已消费决策
                              void fetch(`${serverBase}/api/gate/decision/${request.toolCallId}`, {
                                method: "DELETE",
                                headers: ingestToken ? { "x-graph-token": ingestToken } : {}
                              }).catch(() => { /* 忽略 */ });
                              const resolver = approvalResolverRef.current;
                              approvalResolverRef.current = null;
                              setPendingApproval(null);
                              setSystemNote(`Step Gate: Web 前端已操作 (${data.action})`);
                              resolver({
                                action: data.action as "approve" | "edit" | "skip" | "abort",
                                editedArgs: data.params ? tryParseEditedArgs(data.params) : undefined
                              });
                            }
                          }
                        }).catch(() => { /* 忽略网络错误 */ });
                      }, 400);

                      setSystemNote("Step Gate: 可在 Web 前端或按 Enter/E/S/Q 决策");
                    } else {
                      setSystemNote("Step Gate: Enter=放行, E=编辑参数, S=跳过, Q=终止本轮");
                    }
                  });
                }
              : undefined
        });
        props.recorder.recordAssistant(nextTurn, finalText, lastRunIdRef.current);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        props.recorder.recordError(nextTurn, errorMessage, lastRunIdRef.current);
      } finally {
        cancelWebPoll();
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

  const activeDagNodeId = useMemo(() => {
    const current = [...uiState.weaveDagNodes]
      .filter((node) => node.status === "running" || node.status === "waiting")
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
    return current?.id ?? "";
  }, [uiState.weaveDagNodes]);
  const forceVisibleDagNodeIds = useMemo(
    () => new Set(activeDagNodeId ? [activeDagNodeId] : []),
    [activeDagNodeId]
  );
  const weaveTreeLines = useMemo(
    () => buildWeaveTreeLines(uiState.weaveDagNodes, expandedDagNodeIds, forceVisibleDagNodeIds),
    [uiState.weaveDagNodes, expandedDagNodeIds, forceVisibleDagNodeIds]
  );
  const visibleDagNodeIds = useMemo(
    () => buildVisibleDagNodeIds(uiState.weaveDagNodes, forceVisibleDagNodeIds),
    [uiState.weaveDagNodes, forceVisibleDagNodeIds]
  );
  const runActive = busy || uiState.status === "thinking" || uiState.status === "using_tool";
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
  }, [visibleDagNodeIds]);

  useEffect(() => {
    if (!weaveActiveTurn) {
      previousActiveDagNodeIdRef.current = "";
      return;
    }

    if (activeDagNodeId) {
      setSelectedDagNodeId((prev) => (prev === activeDagNodeId ? prev : activeDagNodeId));
      setExpandedDagNodeIds((prev) => {
        const next = new Set<string>([activeDagNodeId]);
        if (areSetsEqual(prev, next)) {
          return prev;
        }

        return next;
      });

      previousActiveDagNodeIdRef.current = activeDagNodeId;
      return;
    }

    if (runActive) {
      // 运行中但当前无活动节点时，先折叠全部，避免上一节点残留展开造成抖动与视觉噪声。
      setExpandedDagNodeIds((prev) => (prev.size === 0 ? prev : new Set<string>()));
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
            cancelWebPoll();
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
        cancelWebPoll();
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
        cancelWebPoll();
        approvalResolverRef.current?.({ action: "skip" });
        approvalResolverRef.current = null;
        setPendingApproval(null);
        setSystemNote("Step Gate: 已跳过本次工具调用。");
        return;
      }

      if (lower === "q") {
        cancelWebPoll();
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
  // 保留 1 列安全余量，避免终端在边界列做不一致换行导致输入框上下抖动。
  const inputSafeMargin = 1;
  const inputTextMax = Math.max(8, inputInnerWidth - inputPrefixWidth - inputSafeMargin);
  const inputIdlePlaceholder = busy ? (pendingApproval ? "(等待 Step Gate 决策...)" : "(处理中，稍候...)") : "";
  const inputDisplayText = buildInputDisplayText(input, inputCursor, inputTextMax, inputIdlePlaceholder);

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
              const nodeKind = isRepairLlmNodeLabel(line.label) ? "决策" : line.id.includes(".") ? "工具" : "决策";
              const semanticLabel = isRepairLlmNodeLabel(line.label)
                ? line.label
                : line.id.includes(".")
                  ? semanticToolTitle(line.label, line.details)
                  : line.label;
              const nodeText = `${line.branchPrefix}${foldPrefix}${statusIcon(line.status, line.retryCurrent, line.retryMax)} [${nodeKind}] ${line.id} ${semanticLabel}${line.durationText}`;
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
                            : line.status === "retrying"
                              ? THEME.retrying
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
        <Text color={THEME.text}>{inputDisplayText}</Text>
      </Box>
    </Box>
  );
}

function tryParseEditedArgs(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
