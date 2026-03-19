/**
 * 文件作用：RepairNode — 表示重试前的参数修复 LLM 调用节点。
 * inputPorts: lastError（text）+ originalArgs（json）
 * outputPorts: repairedArgs（json）
 */

import type { NodeKind, GraphPort } from "./node-types.js";
import { BaseNode } from "./base-node.js";
import type { EngineContext } from "../engine/engine-types.js";

export interface RepairNodeInit {
  lastError?: string;
  originalArgs?: unknown;
  repairedArgs?: unknown;
}

export class RepairNode extends BaseNode<EngineContext> {
  readonly kind: NodeKind = "repair";

  private lastError?: string;
  private originalArgs?: unknown;
  private repairedArgs?: unknown;

  constructor(id: string, init: RepairNodeInit, parentId?: string) {
    super(id, parentId);
    this.lastError = init.lastError;
    this.originalArgs = init.originalArgs;
    this.repairedArgs = init.repairedArgs;
  }

  get title(): string {
    return "参数修复";
  }

  setRepaired(repairedArgs: unknown): void {
    this.repairedArgs = repairedArgs;
    this.status = "success";
    this.completedAt = new Date().toISOString();
  }

  protected getSpecificFields(): Record<string, unknown> {
    return {};
  }

  async getInputPorts(): Promise<GraphPort[]> {
    const ports: GraphPort[] = [];
    if (this.lastError) {
      ports.push({ name: "lastError", type: "text", content: this.lastError });
    }
    if (this.originalArgs !== undefined) {
      ports.push(await this.makePort("originalArgs", "json", this.originalArgs));
    }
    return ports;
  }

  async getOutputPorts(): Promise<GraphPort[]> {
    if (this.repairedArgs === undefined) return [];
    return [await this.makePort("repairedArgs", "json", this.repairedArgs)];
  }
}
