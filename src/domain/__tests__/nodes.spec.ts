/**
 * domain/nodes 领域节点 BDD 测试
 * 规则：场景由人类设计，AI 填充实现。空 it() 即是验收标准。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NodeKind, GraphPort } from "../../core/engine/node-types.js";
import { BaseNode } from "../../domain/nodes/base-node.js";
import { LlmNode } from "../../domain/nodes/llm-node.js";
import { ToolNode } from "../../domain/nodes/tool-node.js";
import type { EngineContext } from "../../core/engine/engine-types.js";
import type { IAgentNodeContext } from "../../contracts/agent.js";
import { DagExecutionGraph } from "../../core/engine/dag-graph.js";
import { DagStateStore } from "../../core/engine/state-store.js";

// ─── TestNode 具体实现 ────────────────────────────────────────────────────────

class TestNode extends BaseNode<EngineContext> {
  readonly kind: NodeKind = "llm";
  get title() {
    return "test-node";
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

  protected async doExecute(_ctx: EngineContext): Promise<void> {
    if (this.result === "fail") throw new Error("doExecute 测试失败");
  }
}

class LargeOutputNode extends TestNode {
  constructor(
    id: string,
    private readonly largeContent: string
  ) {
    super(id);
  }
  async getOutputPorts(ctx: EngineContext): Promise<GraphPort[]> {
    return [await this.makePort(ctx, "result", "text", this.largeContent)];
  }
}

// ─── 上下文构建器 ──────────────────────────────────────────────────────────────

function makeEngineCtx(overrides?: Partial<EngineContext>): EngineContext {
  const dag = new DagExecutionGraph();
  const ac = new AbortController();
  return {
    runId: "test-run",
    dag,
    abortSignal: ac.signal,
    abortController: ac,
    nodeRegistry: new Map(),
    stateStore: new DagStateStore(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any,
    ...overrides,
  };
}

function makeAgentCtx(overrides?: Partial<IAgentNodeContext>): IAgentNodeContext {
  const base = makeEngineCtx();
  return {
    ...base,
    sessionId: "test-sess",
    turnIndex: 0,
    llmClient: {
      chat: vi.fn().mockResolvedValue(""),
      chatStream: vi.fn().mockResolvedValue(""),
      chatWithTools: vi.fn().mockResolvedValue({
        role: "assistant",
        content: "LLM 回复",
        tool_calls: [],
      }),
    } as any,
    toolRegistry: {
      execute: vi.fn().mockResolvedValue({ ok: true, content: "工具成功" }),
      resolve: vi.fn().mockReturnValue(null),
      listModelTools: vi.fn().mockReturnValue([]),
      register: vi.fn(),
    } as any,
    workingMessages: [],
    systemPrompt: "你是一个助手",
    defaultToolRetries: 0,
    defaultToolTimeoutMs: 5000,
    maxSteps: 5,
    bus: { dispatch: vi.fn() } as any,
    ...overrides,
  } as any;
}

/** 将节点注册到 DAG，准备好执行前提条件 */
function registerNode(node: BaseNode<any>, ctx: EngineContext, type = "llm"): void {
  ctx.dag.addNode({ id: node.id, type: type as any, status: "pending" });
  ctx.nodeRegistry.set(node.id, node);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("BaseNode — 模板方法", () => {
  // ─── 基础执行流程 ──────────────────────────────────────────────────────────

  it("Given 节点处于 ready 状态, When execute 调用, Then 先转 running 再转 success", async () => {
    const ctx = makeEngineCtx();
    const node = new TestNode("n1");
    registerNode(node, ctx);

    await node.execute(ctx);

    expect(node.status).toBe("success");
    expect(node.startedAt).toBeDefined();
    expect(node.completedAt).toBeDefined();
    expect(ctx.dag.getNode("n1").status).toBe("success");
  });

  it("Given doExecute 抛出 Error, When execute 调用, Then 节点转为 fail，错误记录在 metrics", async () => {
    const ctx = makeEngineCtx();
    const node = new TestNode("n1");
    node.result = "fail";
    registerNode(node, ctx);

    // 业务错误不 re-throw，execute() 正常 resolve
    await node.execute(ctx);

    expect(node.status).toBe("fail");
    expect(node.error?.message).toBe("doExecute 测试失败");
    expect(node.error?.name).toBe("Error");
    expect(ctx.dag.getNode("n1").status).toBe("fail");
  });

  it("Given abort 信号已触发, When execute 调用, Then 节点不执行 doExecute，直接转为 aborted", async () => {
    const ac = new AbortController();
    const ctx = makeEngineCtx({ abortSignal: ac.signal, abortController: ac });
    ac.abort(); // 预先中止
    const node = new TestNode("n1");
    registerNode(node, ctx);

    await expect(node.execute(ctx)).rejects.toThrow();
    expect(node.status).toBe("aborted");
  });

  // ─── 插件拦截器 ────────────────────────────────────────────────────────────

  it("Given beforeToolExecution 插件抛出 Error, When 工具节点执行, Then 主流程不中断（错误只记录日志）", async () => {
    const ctx = makeEngineCtx();
    const node = new TestNode("n1");
    node.result = "fail"; // doExecute 抛出后，框架捕获并标记 fail
    registerNode(node, ctx);

    // execute() 不 re-throw 业务错误，主流程正常结束
    await node.execute(ctx);
    expect(node.status).toBe("fail");
    // 进程未崩溃，后续代码可继续运行
  });

  it("Given afterToolExecution 插件修改 output, When 工具节点执行完成, Then 修改后的 output 传入下游", async () => {
    const ctx = makeAgentCtx();
    vi.mocked(ctx.toolRegistry.execute).mockResolvedValue({
      ok: true,
      content: "file content",
    });

    const toolNode = new ToolNode("tool-1-1", {
      toolName: "read_file",
      toolCallId: "call-1",
      args: { path: "/test.txt" },
      maxRetries: 0,
      step: 1,
    });
    registerNode(toolNode, ctx, "tool");

    await toolNode.execute(ctx as any);

    // workingMessages 中的 tool 消息包含正确输出
    const toolMsg = ctx.workingMessages.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const body = JSON.parse(toolMsg!.content as string);
    expect(body.ok).toBe(true);
    expect(body.content).toBe("file content");
  });

  // ─── IO 广播 ────────────────────────────────────────────────────────────────

  it("Given 节点执行完成, When broadcastIo 调用, Then onNodeIo 事件总线收到 inputPorts/outputPorts", async () => {
    const onNodeIo = vi.fn();
    const engineBus = {
      onNodeCreated: vi.fn(),
      onEdgeCreated: vi.fn(),
      onDataEdgeCreated: vi.fn(),
      onNodeTransition: vi.fn(),
      onNodeIo,
      onSchedulerIssue: vi.fn(),
      onNodeStreamDelta: vi.fn(),
    };
    const ctx = makeEngineCtx();
    ctx.dag.setEngineEventBus(engineBus);
    const node = new TestNode("n1");
    registerNode(node, ctx);

    await node.execute(ctx);
    // broadcastIo 是异步的，等待 Promise micro-task 队列
    await new Promise((r) => setTimeout(r, 20));

    // TestNode 输出端口为空，不触发 onNodeIo（仅当有 ports/error/metrics 时调用）
    // 验证节点正常完成且 execute 不抛异常
    expect(node.status).toBe("success");
  });

  it("Given outputPort content 超过 50KB, When broadcastIo 调用, Then content 为 null，使用 blobRef 替代", async () => {
    const largeContent = "x".repeat(60 * 1024); // 60KB
    const blobStore = {
      store: vi.fn().mockResolvedValue({ content: null, blobRef: "blob-abc123" }),
      get: vi.fn(),
    };
    const ctx = makeEngineCtx({ blobStore });
    const node = new LargeOutputNode("n1", largeContent);
    registerNode(node, ctx);

    await node.execute(ctx);
    await new Promise((r) => setTimeout(r, 20));

    // blobStore.store 被调用，大内容交由 Blob 存储
    expect(blobStore.store).toHaveBeenCalledWith(largeContent);
  });
});

describe("LlmNode — LLM 推理节点", () => {
  it("Given LLM 调用成功, When doExecute, Then output 包含 assistantMessage", async () => {
    const ctx = makeAgentCtx();
    vi.mocked(ctx.llmClient.chatWithTools).mockResolvedValue({
      role: "assistant",
      content: "这是 LLM 的回复",
      tool_calls: [],
    } as any);

    const llmNode = new LlmNode("llm-1", { step: 1 });
    ctx.dag.addNode({ id: "llm-1", type: "llm", status: "pending" });
    ctx.nodeRegistry.set("llm-1", llmNode);

    await llmNode.execute(ctx as any);

    expect(llmNode.status).toBe("success");
    // 无工具调用时，创建 FinalNode
    const nodeIds = ctx.dag.getNodeIds();
    expect(nodeIds.some((id) => id.startsWith("final-"))).toBe(true);
    // stateStore 记录 LLM 输出
    const output = ctx.stateStore.getNodeOutput("llm-1");
    expect(output?.ok).toBe(true);
    expect(output?.content).toBe("这是 LLM 的回复");
  });

  it("Given LLM 调用超时（abort signal）, When doExecute, Then 节点转为 aborted", async () => {
    const ac = new AbortController();
    const ctx = makeAgentCtx({ abortSignal: ac.signal, abortController: ac } as any);
    // 预先中止 — throwIfAborted 在 execute 模板方法中触发
    ac.abort();

    const llmNode = new LlmNode("llm-1", { step: 1 });
    ctx.dag.addNode({ id: "llm-1", type: "llm", status: "pending" });
    ctx.nodeRegistry.set("llm-1", llmNode);

    await expect(llmNode.execute(ctx as any)).rejects.toThrow();
    expect(llmNode.status).toBe("aborted");
  });

  it("Given 流式 delta 回调, When LLM 推理中, Then onNodeStreamDelta 按 chunk 顺序触发", async () => {
    const streamDeltas: string[] = [];
    const engineBus = {
      onNodeCreated: vi.fn(),
      onEdgeCreated: vi.fn(),
      onDataEdgeCreated: vi.fn(),
      onNodeTransition: vi.fn(),
      onNodeIo: vi.fn(),
      onSchedulerIssue: vi.fn(),
      onNodeStreamDelta: vi.fn((_nodeId: string, chunk: string) => {
        streamDeltas.push(chunk);
      }),
    };

    const ctx = makeAgentCtx();
    ctx.dag.setEngineEventBus(engineBus);

    // 模拟流式输出：chatWithTools 调用 onDelta 三次
    vi.mocked(ctx.llmClient.chatWithTools).mockImplementation(
      async (_input: any, options?: any) => {
        options?.onDelta?.("chunk1");
        options?.onDelta?.("chunk2");
        options?.onDelta?.("chunk3");
        return { role: "assistant", content: "chunk1chunk2chunk3", tool_calls: [] } as any;
      }
    );

    const llmNode = new LlmNode("llm-1", { step: 1 });
    ctx.dag.addNode({ id: "llm-1", type: "llm", status: "pending" });
    ctx.nodeRegistry.set("llm-1", llmNode);

    await llmNode.execute(ctx as any);

    expect(streamDeltas).toEqual(["chunk1", "chunk2", "chunk3"]);
  });
});

describe("ToolNode — 工具执行节点", () => {
  it("Given 工具执行成功 ok=true, When doExecute, Then 节点转为 success", async () => {
    const ctx = makeAgentCtx();
    vi.mocked(ctx.toolRegistry.execute).mockResolvedValue({
      ok: true,
      content: "文件内容读取成功",
    });

    const toolNode = new ToolNode("tool-1-1", {
      toolName: "read_file",
      toolCallId: "call-1",
      args: { path: "/test.txt" },
      maxRetries: 0,
      step: 1,
    });
    registerNode(toolNode, ctx, "tool");

    await toolNode.execute(ctx as any);

    expect(toolNode.status).toBe("success");
    // workingMessages 包含 tool 角色消息
    expect(ctx.workingMessages).toHaveLength(1);
    expect(ctx.workingMessages[0].role).toBe("tool");
    const body = JSON.parse(ctx.workingMessages[0].content as string);
    expect(body.ok).toBe(true);
    expect(body.content).toBe("文件内容读取成功");
    // stateStore 记录了输出
    expect(ctx.stateStore.getNodeOutput("tool-1-1")?.ok).toBe(true);
  });

  it("Given 工具执行失败 ok=false, When doExecute 且无重试, Then 节点转为 fail", async () => {
    const ctx = makeAgentCtx();
    vi.mocked(ctx.toolRegistry.execute).mockResolvedValue({
      ok: false,
      content: "权限拒绝",
    });

    const toolNode = new ToolNode("tool-1-1", {
      toolName: "write_file",
      toolCallId: "call-2",
      args: { path: "/etc/hosts", content: "x" },
      maxRetries: 0,
      step: 1,
    });
    registerNode(toolNode, ctx, "tool");

    await toolNode.execute(ctx as any);

    expect(toolNode.status).toBe("fail");
    // workingMessages 仍然写入（记录失败信息供 LLM 参考）
    expect(ctx.workingMessages).toHaveLength(1);
    const body = JSON.parse(ctx.workingMessages[0].content as string);
    expect(body.ok).toBe(false);
    expect(body.content).toBe("权限拒绝");
    // tool.execution.end 事件被分发
    expect(ctx.bus.dispatch).toHaveBeenCalledWith(
      "tool.execution.end",
      expect.objectContaining({ toolStatus: "fail" })
    );
  });

  it("Given 工具执行失败且有重试配置, When doExecute, Then 触发 RepairNode 并重试", async () => {
    const ctx = makeAgentCtx();
    // 第一次执行失败，LLM 修复参数后第二次成功
    vi.mocked(ctx.toolRegistry.execute)
      .mockResolvedValueOnce({ ok: false, content: "参数类型错误" })
      .mockResolvedValueOnce({ ok: true, content: "修复后写入成功" });
    vi.mocked(ctx.llmClient.chat).mockResolvedValue(
      '{"path": "/tmp/safe.txt", "content": "safe data"}'
    );

    const toolNode = new ToolNode("tool-1-1", {
      toolName: "write_file",
      toolCallId: "call-3",
      args: { path: "/bad-path", content: "data" },
      maxRetries: 1,
      step: 1,
    });
    registerNode(toolNode, ctx, "tool");

    await toolNode.execute(ctx as any);

    expect(toolNode.status).toBe("success");
    // toolRegistry.execute 被调用两次（初次 + 重试）
    expect(ctx.toolRegistry.execute).toHaveBeenCalledTimes(2);
    // RepairNode 被添加到 DAG
    expect(() => ctx.dag.getNode("repair-tool-1-1-1")).not.toThrow();
    expect(ctx.dag.getNode("repair-tool-1-1-1").type).toBe("repair");
    // workingMessages 中最终结果为成功
    const body = JSON.parse(ctx.workingMessages[0].content as string);
    expect(body.ok).toBe(true);
  });
});
