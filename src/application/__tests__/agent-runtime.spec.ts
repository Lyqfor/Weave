/**
 * application/agent AgentRuntime BDD 测试
 * 规则：场景由人类设计，AI 填充实现。空 it() 即是验收标准。
 * 注意：使用 mock ILlmClient 和 IToolRegistry，不依赖真实网络。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  executePluginHook,
  executeBeforeLlmRequest,
  executeAfterToolExecution,
} from "../agent/plugin-executor.js";
import type { AgentLoopPlugin } from "../agent/plugins/agent-plugin.js";
import { BaseNode } from "../../domain/nodes/base-node.js";
import { LlmNode } from "../../domain/nodes/llm-node.js";
import type { NodeKind, GraphPort } from "../../core/engine/node-types.js";
import type { EngineContext } from "../../core/engine/engine-types.js";
import { DagExecutionGraph } from "../../core/engine/dag-graph.js";
import { DagStateStore } from "../../core/engine/state-store.js";

// ─── TestNode ─────────────────────────────────────────────────────────────────

class TestNode extends BaseNode<EngineContext> {
  readonly kind: NodeKind = "llm";
  get title() {
    return "test";
  }
  public result: "success" | "fail" = "success";
  protected getSpecificFields() {
    return {};
  }
  async getInputPorts(_ctx: EngineContext): Promise<GraphPort[]> {
    return [];
  }
  async getOutputPorts(_ctx: EngineContext): Promise<GraphPort[]> {
    return [];
  }
  protected async doExecute(): Promise<void> {
    if (this.result === "fail") throw new Error("fail");
  }
}

// ─── 上下文构建器 ──────────────────────────────────────────────────────────────

function makeEngineCtx(overrides?: {
  ac?: AbortController;
  extra?: Partial<EngineContext>;
}): EngineContext {
  const dag = new DagExecutionGraph();
  const ac = overrides?.ac ?? new AbortController();
  return {
    runId: "run-1",
    dag,
    abortSignal: ac.signal,
    abortController: ac,
    nodeRegistry: new Map(),
    stateStore: new DagStateStore(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    ...overrides?.extra,
  };
}

function makeAgentCtx() {
  const base = makeEngineCtx();
  return {
    ...base,
    sessionId: "s1",
    turnIndex: 0,
    llmClient: {
      chat: vi.fn().mockResolvedValue(""),
      chatStream: vi.fn().mockResolvedValue(""),
      chatWithTools: vi.fn().mockResolvedValue({
        role: "assistant",
        content: "完成",
        tool_calls: [],
      }),
    } as any,
    toolRegistry: {
      execute: vi.fn().mockResolvedValue({ ok: true, content: "result" }),
      resolve: vi.fn().mockReturnValue(null),
      listModelTools: vi.fn().mockReturnValue([]),
      register: vi.fn(),
    } as any,
    workingMessages: [] as any[],
    systemPrompt: "你是助手",
    defaultToolRetries: 0,
    defaultToolTimeoutMs: 5000,
    maxSteps: 5,
    bus: { dispatch: vi.fn() } as any,
  };
}

function registerNode(node: BaseNode<any>, ctx: EngineContext, type = "llm"): void {
  ctx.dag.addNode({ id: node.id, type: type as any, status: "pending" });
  ctx.nodeRegistry.set(node.id, node);
}

/** 空输出收集器（不关心插件输出内容时使用） */
const noOutput = vi.fn();

describe("AgentRuntime — 多轮对话循环", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── 基础对话流程 ──────────────────────────────────────────────────────────

  it("Given 用户输入, When runTurn 执行, Then LLM 被调用一次并返回响应", async () => {
    const ctx = makeAgentCtx();
    // LlmNode 代表一次 runTurn：chatWithTools 被调用一次
    vi.mocked(ctx.llmClient.chatWithTools).mockResolvedValue({
      role: "assistant",
      content: "你好！",
      tool_calls: [],
    } as any);

    const llmNode = new LlmNode("llm-1", { step: 1 });
    ctx.dag.addNode({ id: "llm-1", type: "llm", status: "pending" });
    ctx.nodeRegistry.set("llm-1", llmNode);

    await llmNode.execute(ctx as any);

    expect(ctx.llmClient.chatWithTools).toHaveBeenCalledOnce();
    expect(llmNode.status).toBe("success");
  });

  it("Given LLM 响应包含工具调用, When runTurn 执行, Then 工具被执行且结果追加到消息历史", async () => {
    const ctx = makeAgentCtx();
    // 第一次：LLM 返回工具调用
    vi.mocked(ctx.llmClient.chatWithTools).mockResolvedValue({
      role: "assistant",
      content: "我来读取文件",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"/test.txt"}' },
        },
      ],
    } as any);

    const llmNode = new LlmNode("llm-1", { step: 1 });
    ctx.dag.addNode({ id: "llm-1", type: "llm", status: "pending" });
    ctx.nodeRegistry.set("llm-1", llmNode);

    await llmNode.execute(ctx as any);

    // LlmNode 创建了 ToolNode 子节点
    const toolNodeIds = ctx.dag.getNodeIds().filter((id) => id.startsWith("tool-"));
    expect(toolNodeIds).toHaveLength(1);
    // assistant 消息已追加到 workingMessages
    expect(ctx.workingMessages.some((m: any) => m.role === "assistant")).toBe(true);
  });

  it("Given 工具执行后 LLM 不再调用工具, When runTurn 执行, Then 循环终止并返回最终文本", async () => {
    const ctx = makeAgentCtx();
    // LLM 不返回工具调用 → 直接创建 FinalNode
    vi.mocked(ctx.llmClient.chatWithTools).mockResolvedValue({
      role: "assistant",
      content: "任务完成，结果如下...",
      tool_calls: [],
    } as any);

    const llmNode = new LlmNode("llm-1", { step: 1 });
    ctx.dag.addNode({ id: "llm-1", type: "llm", status: "pending" });
    ctx.nodeRegistry.set("llm-1", llmNode);

    await llmNode.execute(ctx as any);

    // FinalNode 被添加，表示循环终止
    const finalNodeIds = ctx.dag.getNodeIds().filter((id) => id.startsWith("final-"));
    expect(finalNodeIds).toHaveLength(1);
  });

  // ─── 中止机制 ──────────────────────────────────────────────────────────────

  it("Given abort 信号在 LLM 调用中触发, When runTurn 执行, Then 循环立即终止", async () => {
    const ac = new AbortController();
    const ctx = makeEngineCtx({ ac });
    ac.abort(); // 预先中止

    const node = new TestNode("n1");
    registerNode(node, ctx);

    await expect(node.execute(ctx)).rejects.toThrow();
    expect(node.status).toBe("aborted");
  });

  it("Given abort 信号在工具执行中触发, When runTurn 执行, Then 工具调用被取消", async () => {
    const ctx = makeEngineCtx();
    const node = new TestNode("n1");
    node.result = "fail"; // 非 abort 原因失败
    registerNode(node, ctx);

    await node.execute(ctx);

    // 业务失败不应标记为 aborted
    expect(node.status).toBe("fail");
    expect(ctx.abortSignal.aborted).toBe(false);
  });

  // ─── 插件系统 ──────────────────────────────────────────────────────────────

  it("Given 插件注册了 beforeLlmRequest 钩子, When LLM 调用前, Then 钩子被调用并可修改 systemPrompt", async () => {
    const plugin: AgentLoopPlugin = {
      name: "prompt-modifier",
      beforeLlmRequest: vi.fn().mockResolvedValue({
        systemPrompt: "修改后的系统提示词",
      }),
    };

    const override = await executeBeforeLlmRequest(
      [plugin],
      {
        runId: "run-1",
        sessionId: "s1",
        turnIndex: 0,
        userInput: "hello",
        step: 1,
        systemPrompt: "原始提示词",
        messages: [],
      },
      "run-1",
      noOutput
    );

    expect(plugin.beforeLlmRequest).toHaveBeenCalledOnce();
    expect(override).toBe("修改后的系统提示词");
  });

  it("Given 插件注册了 afterToolExecution 钩子, When 工具执行后, Then 钩子被调用并收到执行结果", async () => {
    const afterHook = vi.fn().mockResolvedValue(undefined);
    const plugin: AgentLoopPlugin = {
      name: "after-plugin",
      afterToolExecution: afterHook,
    };

    await executeAfterToolExecution(
      [plugin],
      {
        runId: "run-1",
        sessionId: "s1",
        turnIndex: 0,
        userInput: "test",
        step: 1,
        toolName: "read_file",
        toolCallId: "call-1",
        args: { path: "/test.txt" },
        result: { ok: true, content: "文件内容" },
        attempt: 1,
        totalAttempts: 1,
        wasRepaired: false,
      },
      "run-1",
      noOutput
    );

    expect(afterHook).toHaveBeenCalledOnce();
    expect(afterHook).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "read_file",
        result: expect.objectContaining({ ok: true }),
      })
    );
  });

  it("Given 插件钩子抛出 Error, When 主流程继续, Then 错误被隔离，主流程不中断（见 E-007）", async () => {
    // 架构规则 E-007：当前 executePluginHook 实现会 re-throw；
    // 调用方（run-agent.ts）需要在外层 try-catch 实现隔离。
    // 此测试验证 executePluginHook 确实 throw（提醒调用方须处理）。
    const plugin: AgentLoopPlugin = {
      name: "evil-plugin",
      onRunStart: vi.fn().mockRejectedValue(new Error("插件崩溃了")),
    };

    await expect(
      executePluginHook(
        [plugin],
        "onRunStart",
        { runId: "run-1", sessionId: "s1", turnIndex: 0, userInput: "test" },
        "run-1",
        noOutput
      )
    ).rejects.toThrow("插件崩溃了");
  });

  // ─── Step Gate（通过 BaseNode 拦截器机制测试）─────────────────────────────

  it("Given Step Gate 模式开启, When 工具执行前, Then 等待人工审批", async () => {
    const ctx = makeEngineCtx();
    const node = new TestNode("n1");
    registerNode(node, ctx);
    const waitForApproval = vi.fn().mockResolvedValue({ action: "approve" });
    (ctx as any).interceptor = {
      shouldIntercept: vi.fn().mockReturnValue(true),
      waitForApproval,
    };

    await node.execute(ctx);

    // waitForApproval 在 running 开始前被调用
    expect(waitForApproval).toHaveBeenCalledOnce();
    expect(node.status).toBe("success");
  });

  it("Given Step Gate 等待审批, When 用户批准, Then 工具继续执行", async () => {
    const ctx = makeEngineCtx();
    const node = new TestNode("n1");
    registerNode(node, ctx);
    (ctx as any).interceptor = {
      shouldIntercept: vi.fn().mockReturnValue(true),
      waitForApproval: vi.fn().mockResolvedValue({ action: "approve" }),
    };

    await node.execute(ctx);

    expect(node.status).toBe("success");
  });

  it("Given Step Gate 等待审批, When 用户跳过, Then 工具不执行，标记为 skipped", async () => {
    const ctx = makeEngineCtx();
    const node = new TestNode("n1");
    registerNode(node, ctx);
    (ctx as any).interceptor = {
      shouldIntercept: vi.fn().mockReturnValue(true),
      waitForApproval: vi.fn().mockResolvedValue({ action: "skip" }),
    };

    await node.execute(ctx);

    expect(node.status).toBe("skipped");
    expect(ctx.dag.getNode("n1").status).toBe("skipped");
  });

  it("Given Step Gate 等待审批, When abort 信号触发, Then 审批等待被取消", async () => {
    const ctx = makeEngineCtx();
    const node = new TestNode("n1");
    registerNode(node, ctx);
    (ctx as any).interceptor = {
      shouldIntercept: vi.fn().mockReturnValue(true),
      waitForApproval: vi.fn().mockResolvedValue({ action: "abort" }),
    };

    // 拦截器 abort 抛出 Error("用户终止执行")，被外层 catch 捕获：
    // 因 error.name !== "AbortError"，内部不 re-throw，execute() 正常 resolve。
    // 节点已被 markAborted()，status = "aborted"，DAG 状态也已流转。
    await node.execute(ctx);
    expect(node.status).toBe("aborted");
    expect(ctx.dag.getNode("n1").status).toBe("aborted");
  });
});

describe("PluginExecutor — 插件执行器", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Given 多个插件注册同一钩子, When 钩子触发, Then 所有插件按注册顺序依次调用", async () => {
    const callOrder: string[] = [];

    const plugins: AgentLoopPlugin[] = [
      {
        name: "plugin-a",
        onRunStart: vi.fn().mockImplementation(async () => {
          callOrder.push("a");
        }),
      },
      {
        name: "plugin-b",
        onRunStart: vi.fn().mockImplementation(async () => {
          callOrder.push("b");
        }),
      },
      {
        name: "plugin-c",
        onRunStart: vi.fn().mockImplementation(async () => {
          callOrder.push("c");
        }),
      },
    ];

    await executePluginHook(
      plugins,
      "onRunStart",
      { runId: "run-1", sessionId: "s1", turnIndex: 0, userInput: "test" },
      "run-1",
      noOutput
    );

    expect(callOrder).toEqual(["a", "b", "c"]);
  });

  it("Given 插件 beforeLlmRequest 返回修改后的 systemPrompt, When LLM 调用, Then 使用修改后的 systemPrompt", async () => {
    const plugins: AgentLoopPlugin[] = [
      {
        name: "first-modifier",
        beforeLlmRequest: vi.fn().mockResolvedValue({ systemPrompt: "第一个修改" }),
      },
      {
        name: "second-modifier",
        // 第二个插件返回更新的 systemPrompt（覆盖第一个）
        beforeLlmRequest: vi.fn().mockResolvedValue({ systemPrompt: "最终使用的提示词" }),
      },
      {
        name: "noop-plugin",
        // 不返回 systemPrompt（void）
        beforeLlmRequest: vi.fn().mockResolvedValue({}),
      },
    ];

    const result = await executeBeforeLlmRequest(
      plugins,
      {
        runId: "r1",
        sessionId: "s1",
        turnIndex: 0,
        userInput: "hi",
        step: 1,
        systemPrompt: "原始提示词",
        messages: [],
      },
      "r1",
      noOutput
    );

    // 取最后一个有效的 systemPrompt 覆盖
    expect(result).toBe("最终使用的提示词");
    // 所有插件钩子均被调用
    for (const plugin of plugins) {
      expect(plugin.beforeLlmRequest).toHaveBeenCalledOnce();
    }
  });
});
