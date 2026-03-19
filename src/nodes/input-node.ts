/**
 * 文件作用：InputNode — 表示用户输入节点，DAG 的起始点。
 * outputPorts: userQuery（text）
 */

import type { NodeKind, GraphPort } from "./node-types.js";
import { BaseNode } from "./base-node.js";
import type { EngineContext } from "../engine/engine-types.js";

export class InputNode extends BaseNode<EngineContext> {
  readonly kind: NodeKind = "input";

  private readonly userQuery?: string;

  constructor(id: string, userQuery?: string) {
    super(id);
    this.userQuery = userQuery;
    this.status = "success";
    this.startedAt = new Date().toISOString();
    this.completedAt = this.startedAt;
  }

  get title(): string {
    return "用户输入";
  }

  protected getSpecificFields(): Record<string, unknown> {
    return {};
  }

  async getInputPorts(): Promise<GraphPort[]> {
    return [];
  }

  async getOutputPorts(): Promise<GraphPort[]> {
    if (!this.userQuery) return [];
    return [await this.makePort("userQuery", "text", this.userQuery)];
  }
}
