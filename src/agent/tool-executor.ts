/**
 * 文件作用：工具执行器，封装工具执行、超时控制与参数修复链路。
 * 注：deriveToolIntent / attachIntentToToolArgs / stripRuntimeToolMeta 已删除（Intent 现直接存储在节点字段中）。
 */
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { ToolExecuteResult } from "../tools/tool-types.js";
import type { AppLogger } from "../logging/app-logger.js";
import { summarizeText, tryParseJson, safeJsonStringify } from "../utils/text-utils.js";
import { extractErrorMessage } from "../errors/agent-errors.js";

// ─── 类型定义 ───

export interface ToolRetryTicket {
  toolName: string;
  intentSummary: string;
  previousArgs: unknown;
  lastResult: string;
}

export interface ToolRepairResult {
  repairedArgs: Record<string, unknown> | null;
  llmOutput: string;
}

interface ExecuteToolInput {
  toolName: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  runId: string;
  step: number;
  toolCallId: string;
  sessionId: string;
}

// ─── 工具执行 ───

/**
 * 带超时控制的工具执行（args 已是干净参数，无 __ 字段）。
 */
export async function executeToolWithTimeout(
  toolRegistry: ToolRegistry,
  input: ExecuteToolInput,
  logger: AppLogger
): Promise<ToolExecuteResult> {
  try {
    const result = await withTimeout(
      toolRegistry.execute(input.toolName, input.args, {
        sessionId: input.sessionId,
        runId: input.runId,
        workspaceRoot: process.cwd()
      }),
      input.timeoutMs,
      `工具执行超时: ${input.toolName} 超过 ${input.timeoutMs}ms`
    );
    return result;
  } catch (error: unknown) {
    const errorMessage = extractErrorMessage(error);
    logger.error("run.tool.error", "工具执行失败", {
      runId: input.runId,
      step: input.step,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      errorMessage
    });
    return {
      ok: false,
      content: errorMessage,
      metadata: {
        timeoutMs: input.timeoutMs,
        timedOut: errorMessage.includes("超时")
      }
    };
  }
}

// ─── JSON 提取 ───

/**
 * 从 LLM 输出中提取 JSON 对象（支持 fenced code block 和纯文本）。
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const direct = tryParseJson(trimmed);
  if (direct && (Object.keys(direct).length > 0 || trimmed === "{}")) {
    return direct;
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    const fenced = tryParseJson(fenceMatch[1]);
    if (fenced && (Object.keys(fenced).length > 0 || fenceMatch[1].trim() === "{}")) {
      return fenced;
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = tryParseJson(trimmed.slice(firstBrace, lastBrace + 1));
    if (sliced && Object.keys(sliced).length > 0) {
      return sliced;
    }
  }

  return null;
}

// ─── 参数修复 ───

/**
 * 通过 LLM 修复失败的工具参数。
 */
export async function repairToolArgsByIntent(
  ticket: ToolRetryTicket,
  systemPrompt: string,
  chatFn: (input: { systemPrompt: string; userMessage: string }) => Promise<string>
): Promise<ToolRepairResult> {
  const repairPrompt = [
    "你是工具参数修复器。请根据失败信息修复参数，并且仅返回 JSON 对象，不要输出任何解释。",
    `toolName=${ticket.toolName}`,
    `intent=${ticket.intentSummary}`,
    `previousArgs=${safeJsonStringify(ticket.previousArgs)}`,
    `lastResult=${ticket.lastResult}`,
    "要求：尽量最小修改参数；若无法修复则原样返回 previousArgs。"
  ].join("\n");

  const raw = await chatFn({
    systemPrompt: "", // 工具修复不需要系统提示词
    userMessage: repairPrompt
  });

  const parsed = extractJsonObject(raw);
  return {
    repairedArgs: parsed,
    llmOutput: raw
  };
}

// ─── 内部工具 ───

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
