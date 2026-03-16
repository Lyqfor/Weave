import type { AgentRunner, RunnerExecuteRequest } from "./runner-types.js";

/**
 * 文件作用：legacy 运行器适配层，将执行委托给现有 Agent-loop 实现。
 */
export class LegacyAgentRunner implements AgentRunner {
  name = "legacy";

  constructor(
    private readonly executeLegacy: (request: RunnerExecuteRequest) => Promise<string>
  ) {}

  async run(request: RunnerExecuteRequest): Promise<string> {
    return await this.executeLegacy(request);
  }
}
