/**
 * 文件作用：AttemptNode — 表示工具调用的一次重试执行尝试（第 2 次及以后）。
 * inputPorts: args（本次实际使用的参数）
 * outputPorts: result（成功时）+ errorMessage（失败时）
 */

import type { NodeKind, GraphPort } from "./node-types.js";
import { BaseNode } from "./base-node.js";
import type { EngineContext } from "../engine/engine-types.js";

export interface AttemptNodeInit {
  attemptIndex: number;
  args: unknown;
}

export class AttemptNode extends BaseNode<EngineContext> {
  readonly kind: NodeKind = "attempt";

  public readonly attemptIndex: number;
  private args: unknown;
  private resultContent?: unknown;
  private errorMessage?: string;

  constructor(id: string, init: AttemptNodeInit, parentId?: string) {
    super(id, parentId);
    this.attemptIndex = init.attemptIndex;
    this.args = init.args;
  }

  get title(): string {
    return `第 ${this.attemptIndex} 次执行`;
  }

  setSuccess(result?: unknown): void {
    this.status = "success";
    this.completedAt = new Date().toISOString();
    this.resultContent = result;
  }

  setFailed(errorMsg: string): void {
    this.status = "fail";
    this.completedAt = new Date().toISOString();
    this.errorMessage = errorMsg;
  }

  protected getSpecificFields(): Record<string, unknown> {
    return { attemptIndex: this.attemptIndex };
  }

  async getInputPorts(): Promise<GraphPort[]> {
    return [await this.makePort("args", "json", this.args)];
  }

  async getOutputPorts(): Promise<GraphPort[]> {
    const ports: GraphPort[] = [];
    if (this.resultContent !== undefined) {
      const type = typeof this.resultContent === "string" ? "text" : "json";
      ports.push(await this.makePort("result", type, this.resultContent));
    }
    if (this.errorMessage) {
      ports.push({ name: "errorMessage", type: "text", content: this.errorMessage });
    }
    return ports;
  }
}
