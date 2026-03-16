import { LegacyAgentRunner } from "./runner-legacy.js";
import { DagAgentRunner } from "./runner-dag.js";
import type { AgentRunner, RunnerExecuteRequest } from "./runner-types.js";

/**
 * 文件作用：运行器选择器，当前先稳定返回 legacy 运行器，预留 dag 切换位。
 */
export type RunnerMode = "legacy" | "dag";

export interface RunnerSelectorInput {
  mode: RunnerMode;
  executeLegacy: (request: RunnerExecuteRequest) => Promise<string>;
  executeDag: (request: RunnerExecuteRequest) => Promise<string>;
}

export function createRuntimeRunner(input: RunnerSelectorInput): AgentRunner {
  if (input.mode === "dag") {
    return new DagAgentRunner(input.executeDag);
  }

  return new LegacyAgentRunner(input.executeLegacy);
}
