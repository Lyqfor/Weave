/**
 * 文件作用：统一插件钩子执行器，消除各执行路径中重复的插件调用代码。
 */
import type {
  AgentLoopPlugin,
  AgentPluginOutput,
  AgentPluginOutputs,
  AgentPluginRunContext
} from "./plugins/agent-plugin.js";

type PluginOutputCallback = (runId: string, output: AgentPluginOutputs) => void;

/**
 * 批量触发同一钩子，收集并转发所有插件输出。
 */
export async function executePluginHook<C>(
  plugins: AgentLoopPlugin[],
  hookName: keyof AgentLoopPlugin,
  context: C,
  runId: string,
  emitOutput: PluginOutputCallback
): Promise<void> {
  for (const plugin of plugins) {
    const hook = plugin[hookName];
    if (typeof hook === "function") {
      // 必须绑定到插件实例，避免类方法中的 this（如 WeavePlugin.runStates）丢失。
      const output = await (hook as (this: AgentLoopPlugin, ctx: C) => Promise<AgentPluginOutputs>).call(
        plugin,
        context
      );
      emitOutput(runId, output);
    }
  }
}

/**
 * 触发 onRunStart 钩子。
 */
export async function executeOnRunStart(
  plugins: AgentLoopPlugin[],
  context: AgentPluginRunContext,
  runId: string,
  emitOutput: PluginOutputCallback
): Promise<void> {
  await executePluginHook(plugins, "onRunStart", context, runId, emitOutput);
}

/**
 * 触发 onRunCompleted 钩子。
 */
export async function executeOnRunCompleted(
  plugins: AgentLoopPlugin[],
  context: AgentPluginRunContext & { finalText: string },
  runId: string,
  emitOutput: PluginOutputCallback
): Promise<void> {
  await executePluginHook(plugins, "onRunCompleted", context, runId, emitOutput);
}

/**
 * 触发 onRunError 钩子。
 */
export async function executeOnRunError(
  plugins: AgentLoopPlugin[],
  context: AgentPluginRunContext & { errorMessage: string },
  runId: string,
  emitOutput: PluginOutputCallback
): Promise<void> {
  await executePluginHook(plugins, "onRunError", context, runId, emitOutput);
}

/**
 * 触发 beforeLlmRequest 钩子，收集可能的 systemPrompt 覆盖。
 * 返回最后一个提供了 systemPrompt 覆盖的值（如有）。
 */
export async function executeBeforeLlmRequest(
  plugins: AgentLoopPlugin[],
  context: Parameters<NonNullable<AgentLoopPlugin["beforeLlmRequest"]>>[0],
  runId: string,
  emitOutput: PluginOutputCallback
): Promise<string | undefined> {
  let overridePrompt: string | undefined;
  for (const plugin of plugins) {
    const result = await plugin.beforeLlmRequest?.(context);
    if (result) {
      if (result.systemPrompt) {
        overridePrompt = result.systemPrompt;
      }
      if (result.output) {
        emitOutput(runId, Array.isArray(result.output) ? result.output : result.output);
      }
    }
  }
  return overridePrompt;
}

/**
 * 触发 beforeToolExecution 钩子。
 */
export async function executeBeforeToolExecution(
  plugins: AgentLoopPlugin[],
  context: Parameters<NonNullable<AgentLoopPlugin["beforeToolExecution"]>>[0],
  runId: string,
  emitOutput: PluginOutputCallback
): Promise<void> {
  await executePluginHook(plugins, "beforeToolExecution", context, runId, emitOutput);
}

/**
 * 触发 afterToolExecution 钩子。
 */
export async function executeAfterToolExecution(
  plugins: AgentLoopPlugin[],
  context: Parameters<NonNullable<AgentLoopPlugin["afterToolExecution"]>>[0],
  runId: string,
  emitOutput: PluginOutputCallback
): Promise<void> {
  await executePluginHook(plugins, "afterToolExecution", context, runId, emitOutput);
}

/**
 * 触发 afterLlmResponse 钩子。
 */
export async function executeAfterLlmResponse(
  plugins: AgentLoopPlugin[],
  context: Parameters<NonNullable<AgentLoopPlugin["afterLlmResponse"]>>[0],
  runId: string,
  emitOutput: PluginOutputCallback
): Promise<void> {
  await executePluginHook(plugins, "afterLlmResponse", context, runId, emitOutput);
}
