import type { AgentRunner, RunnerExecuteRequest } from "./runner-types.js";

/**
 * 文件作用：Dag 运行器适配层，委托到 DAG 执行内核实现。
 */
export class DagAgentRunner implements AgentRunner {
  name = "dag";

  constructor(
    private readonly executeDag: (request: RunnerExecuteRequest) => Promise<string>
  ) {}

  async run(request: RunnerExecuteRequest): Promise<string> {
    return await this.executeDag(request);
  }
}
