/**
 * 文件作用：INodeInterceptor 接口 — 独立双轨制拦截器协议。
 * Plugin = 被动观察者，Interceptor = 主动控制者。
 * 拦截器决策通过 switch 穷举 + default 拦截，拒绝所有未知/畸形指令。
 */

import type { BaseNode } from "../nodes/base-node.js";
import type { RunContext } from "../session/run-context.js";

export interface InterceptDecision {
  action: "approve" | "edit" | "skip" | "abort";
  editedArgs?: Record<string, unknown>;
}

export interface INodeInterceptor {
  /** 判断是否需要拦截此节点 */
  shouldIntercept(node: BaseNode, ctx: RunContext): boolean | Promise<boolean>;
  /** 挂起等待人类审批决策 */
  waitForApproval(node: BaseNode, ctx: RunContext): Promise<InterceptDecision>;
}
