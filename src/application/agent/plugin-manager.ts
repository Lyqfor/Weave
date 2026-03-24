/**
 * 文件作用：Layer 3 插件大管家 — 纯旁路观察者。
 * 它监听全局物理总线（WeaveEventBus），将物理状态（running/success）翻译为业务钩子（onToolStart/onLlmStart）。
 * 业务节点（Node 级）对此完全无感，实现了物理与逻辑的彻底解耦。
 */

import type { WeaveEventBus } from "../../domain/event/event-bus.js";
import type {
  AgentLoopPlugin,
  AgentPluginOutput,
  AgentPluginOutputs,
} from "./plugins/agent-plugin.js";
import type { AgentRunEvent } from "../../domain/event/event-types.js";

/** engine.node.transition 事件 payload 的类型 */
type NodeTransitionPayload = Extract<AgentRunEvent, { type: "engine.node.transition" }>["payload"];

export class PluginManager {
  constructor(
    private readonly bus: WeaveEventBus,
    private readonly plugins: AgentLoopPlugin[]
  ) {
    this.listenToEngineEvents();
  }

  private listenToEngineEvents(): void {
    // 👑 核心魔法：从物理总线中"窃听"状态变迁，触发旁路插件
    this.bus.on("engine.node.transition", (event) => {
      const { nodeId, nodeType, toStatus, updatedPayload } = (
        event as AgentRunEvent & { payload: NodeTransitionPayload }
      ).payload;

      // 工具节点生命周期
      if (nodeType === "tool") {
        if (toStatus === "running") {
          this.executePlugins("beforeToolExecution", { nodeId, ...updatedPayload });
        } else if (toStatus === "success" || toStatus === "fail") {
          this.executePlugins("afterToolExecution", { nodeId, ...updatedPayload });
        }
      }

      // LLM 节点生命周期
      if (nodeType === "llm") {
        if (toStatus === "running") {
          this.executePlugins("beforeLlmRequest", { nodeId, ...updatedPayload });
        } else if (toStatus === "success" || toStatus === "fail") {
          this.executePlugins("afterLlmResponse", { nodeId, ...updatedPayload });
        }
      }
    });

    // 窃听流式输出，用于特定的日志记录插件（可选）
    this.bus.on("engine.node.stream", (_event) => {
      // 可以在此处触发类似 onStreamChunk 的新钩子
    });
  }

  private async executePlugins(
    hookName: keyof AgentLoopPlugin,
    context: Record<string, unknown>
  ): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        const hook = plugin[hookName] as
          | ((
              ctx: Record<string, unknown>
            ) => Promise<AgentPluginOutput | AgentPluginOutputs | void>)
          | undefined;
        if (typeof hook === "function") {
          const output = await hook.call(plugin, context);
          // 👑 插件的输出由管家统一发回总线，节点根本不知道！
          if (output) {
            this.bus.dispatchPluginOutput(output);
          }
        }
      } catch (err) {
        // 🛡️ 旁路逻辑严禁阻塞主进程
        console.error(`[PluginManager] hook ${hookName} failed:`, err);
      }
    }
  }
}
