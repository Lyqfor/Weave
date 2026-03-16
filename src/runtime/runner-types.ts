import type { AgentLoopPlugin } from "../agent/plugins/agent-plugin.js";

/**
 * 文件作用：定义运行器（Runner）抽象契约，隔离 legacy 与 dag 执行内核。
 */
export interface ToolApprovalRequest {
  runId: string;
  step: number;
  toolName: string;
  toolCallId: string;
  args: unknown;
  argsText: string;
}

export interface ToolApprovalDecision {
  action: "approve" | "edit" | "skip" | "abort";
  editedArgs?: unknown;
}

export interface RunOnceStreamOptions {
  plugins?: AgentLoopPlugin[];
  stepMode?: boolean;
  approveToolCall?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
}

export interface RunnerExecuteRequest {
  userInput: string;
  options?: RunOnceStreamOptions;
}

export interface AgentRunner {
  name: string;
  run(request: RunnerExecuteRequest): Promise<string>;
}
