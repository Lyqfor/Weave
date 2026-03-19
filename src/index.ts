import { render } from "ink";
import { loadLlmConfig } from "./config/load-llm-config.js";
import { AgentRuntime, type AgentRunEvent } from "./agent/run-agent.js";
import { dispatchUserInput } from "./agent/message-dispatcher.js";
import { MemoryStore } from "./memory/memory-store.js";
import { AppLogger, writeConversationChainLog, type ConversationChainStep } from "./logging/app-logger.js";
import { SessionRecorder } from "./session/session-recorder.js";
import { ToolRegistry } from "./tools/tool-registry.js";
import { builtinTools } from "./tools/builtins/index.js";
import React from "react";
import { App } from "./tui/App.js";
import type { WeaveMode } from "./tui/weave-mode.js";
import { createSessionId } from "./utils/id-gen.js";

/**
 * 文件作用：命令行入口，启动终端多轮会话。
 * 在单次命令启动后保持会话常驻，支持持续提问，直到用户主动退出。
 */
async function main(): Promise<void> {
  const logger = new AppLogger("cli-entry");
  const sessionId = createSessionId();
  const initialInput = process.argv.slice(2).join(" ").trim();
  const chainSteps: ConversationChainStep[] = [];

  chainSteps.push({
    stage: "session.start",
    message: "终端会话启动",
    data: { sessionId }
  });

  // 完成配置加载与运行时装配。
  const llmConfig = loadLlmConfig();
  const memoryStore = new MemoryStore("memories");
  const toolRegistry = new ToolRegistry();

  // 集中注册内置工具：通过注册中心与运行时解耦，后续新增工具无需改 Runtime 核心。
  for (const tool of builtinTools) {
    toolRegistry.register(tool);
  }

  const agent = new AgentRuntime(llmConfig, memoryStore, toolRegistry);
  agent.startSession(sessionId);
  setupGraphEventForwarder(agent, logger);

  // 会话级 jsonl 记录器：记录每轮输入输出与会话生命周期。
  const recorder = new SessionRecorder(sessionId);
  recorder.start();

  logger.info("cli.runtime.ready", "运行时装配完成", {
    sessionId,
    provider: llmConfig.provider,
    model: llmConfig.model
  });

  let exitReason = "unknown";
  let turnCount = 0;

  if (!process.stdin.isTTY) {
    const batchResult = await runBatchSession({
      agent,
      recorder,
      initialInput
    });
    exitReason = batchResult.reason;
    turnCount = batchResult.turnCount;
    chainSteps.push({
      stage: "session.exit",
      message: "非 TTY 批处理会话结束",
      data: { reason: exitReason, turnCount }
    });
  } else {
    const app = render(
      React.createElement(App, {
        agent,
        recorder,
        sessionId,
        initialInput,
        onSessionEnd: (reason: string, turns: number) => {
          exitReason = reason;
          turnCount = turns;
          chainSteps.push({
            stage: "session.exit",
            message: "TUI 会话结束",
            data: { reason, turnCount: turns }
          });
        }
      })
    );

    await app.waitUntilExit();
  }

  chainSteps.push({
    stage: "session.end",
    message: "会话结束",
    data: { reason: exitReason, turnCount }
  });

  const chainPath = writeConversationChainLog(
    sessionId,
    `Ink TUI 多轮会话，共 ${turnCount} 轮`,
    chainSteps
  );
  logger.info("session.finalized", "会话收尾完成", {
    sessionId,
    turns: turnCount,
    sessionRecordPath: recorder.getSessionFilePath(),
    chainPath
  });

  console.log(`\n会话已结束，记录文件：${recorder.getSessionFilePath()}`);
  console.log(`调用链路文档：${chainPath}`);
}

interface BatchSessionResult {
  reason: string;
  turnCount: number;
}

async function runBatchSession(input: {
  agent: AgentRuntime;
  recorder: SessionRecorder;
  initialInput: string;
}): Promise<BatchSessionResult> {
  const stdinText = await readAllStdinText();
  const lines = [input.initialInput, ...stdinText.split(/\r?\n/)]
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let turn = 0;
  let weaveMode: WeaveMode = "off";
  let reason = "stdin-eof";
  let cursor = 0;

  while (cursor < lines.length) {
    const rawLine = lines[cursor];
    cursor += 1;

    const dispatched = dispatchUserInput(rawLine, weaveMode);
    if (dispatched.kind === "quit") {
      reason = `command:${dispatched.command}`;
      break;
    }

    if (dispatched.kind === "mode-change") {
      weaveMode = dispatched.nextMode;
      continue;
    }

    if (dispatched.kind === "empty") {
      continue;
    }

    const parsed = dispatched;

    turn += 1;
    input.recorder.recordUser(turn, rawLine);

    const plugins: import("./agent/plugins/agent-plugin.js").AgentLoopPlugin[] = [];
    try {
      const finalText = await input.agent.runOnceStream(parsed.question, {
        plugins,
        stepMode: parsed.enableWeave && parsed.stepMode,
        autoMode: parsed.enableWeave && parsed.autoMode,
        approveToolCall:
          parsed.enableWeave && parsed.stepMode
            ? async () => {
                const nextDecision = lines[cursor]?.trim().toLowerCase() ?? "";
                if (nextDecision === "s") {
                  cursor += 1;
                  return { action: "skip" };
                }

                if (nextDecision === "q") {
                  cursor += 1;
                  return { action: "abort" };
                }

                if (nextDecision === "e") {
                  cursor += 1;
                  const editedJson = lines[cursor] ?? "{}";
                  cursor += 1;
                  try {
                    return { action: "edit", editedArgs: JSON.parse(editedJson) };
                  } catch {
                    return { action: "approve" };
                  }
                }

                return { action: "approve" };
              }
            : undefined
      });
      input.recorder.recordAssistant(turn, finalText);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      input.recorder.recordError(turn, errorMessage);
    }
  }

  input.recorder.end(reason);
  return {
    reason,
    turnCount: turn
  };
}

async function readAllStdinText(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  return await new Promise<string>((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      text += chunk;
    });
    process.stdin.on("end", () => {
      resolve(text);
    });
    process.stdin.on("error", (error) => {
      reject(error);
    });
  });
}


function setupGraphEventForwarder(agent: AgentRuntime, logger: AppLogger): void {
  const ingestUrl = process.env.WEAVE_GRAPH_INGEST_URL?.trim() ?? "";
  const ingestToken = process.env.WEAVE_GRAPH_TOKEN?.trim() ?? "";
  if (!ingestUrl) {
    return;
  }

  logger.info("graph.forwarder.enabled", "已启用二维图事件转发", {
    ingestUrl,
    hasToken: Boolean(ingestToken)
  });

  agent.on("event", (evt: AgentRunEvent) => {
    void fetch(ingestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(ingestToken ? { "x-graph-token": ingestToken } : {})
      },
      body: JSON.stringify(evt)
    }).catch((error) => {
      logger.error("graph.forwarder.error", "二维图事件转发失败", {
        eventType: evt.type,
        runId: evt.runId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
}

main().catch((error: unknown) => {
  console.error("会话运行失败:", error);
  process.exit(1);
});
