/**
 * 文件作用：DAG 语义测试矩阵，覆盖环路/死锁/依赖缺失/重试/超时/审批恢复/off-on-step 一致性。
 */
import { DagExecutionGraph } from "../dist/runtime/dag-graph.js";
import { AgentRuntime } from "../dist/agent/run-agent.js";
import { MemoryStore } from "../dist/memory/memory-store.js";
import { ToolRegistry } from "../dist/tools/tool-registry.js";
import { WeavePlugin } from "../dist/weave/weave-plugin.js";

async function main() {
  const baseConfig = {
    provider: "qwen",
    model: "fake-model",
    baseUrl: "http://localhost",
    apiKey: "fake-api-key"
  };

  verifyCycleDetection();
  verifyMissingDependency();
  verifyFsmConstraint();
  verifyDeadlockScenario();

  await verifyRetryRecovery(baseConfig);
  await verifyTimeoutPath(baseConfig);
  await verifyApprovalInterruptRecovery(baseConfig);
  await verifyOffOnStepConsistency(baseConfig);

  console.log("DAG matrix verification passed.");
}

function verifyCycleDetection() {
  const graph = new DagExecutionGraph();
  graph.addNode({ id: "a", type: "llm", status: "pending" });
  graph.addNode({ id: "b", type: "tool", status: "pending" });
  graph.addEdge("a", "b");

  expectThrows(() => graph.addEdge("b", "a"), "cycle should be rejected");
}

function verifyMissingDependency() {
  const graph = new DagExecutionGraph();
  graph.addNode({ id: "a", type: "llm", status: "pending" });

  expectThrows(() => graph.addEdge("missing", "a"), "missing control dependency should be rejected");
  expectThrows(
    () => graph.addDataEdge({ fromNodeId: "missing", toNodeId: "a", toKey: "input" }),
    "missing data dependency should be rejected"
  );
}

function verifyFsmConstraint() {
  const graph = new DagExecutionGraph();
  graph.addNode({ id: "n1", type: "tool", status: "pending" });

  graph.transitionStatus("n1", "ready");
  graph.transitionStatus("n1", "running");
  graph.transitionStatus("n1", "success");

  expectThrows(() => graph.transitionStatus("n1", "running"), "terminal node should reject illegal transition");
}

function verifyDeadlockScenario() {
  const graph = new DagExecutionGraph();
  graph.addNode({ id: "n1", type: "tool", status: "blocked" });

  const ready = graph.getReadyNodeIds();
  assert(ready.length === 0, "deadlock graph should have no ready nodes");
  assert(graph.hasPendingWork(), "deadlock graph should still have pending work");
}

async function verifyRetryRecovery(config) {
  process.env.WEAVE_DAG_TOOL_RETRIES = "1";
  process.env.WEAVE_DAG_TOOL_TIMEOUT_MS = "1000";

  let executeCount = 0;
  const { runtime, events } = createRuntime(config, async (_input, callCount) => {
    if (callCount === 1) {
      return {
        content: null,
        tool_calls: [
          {
            id: "call_retry",
            type: "function",
            function: {
              name: "demo_tool",
              arguments: JSON.stringify({ value: 1 })
            }
          }
        ]
      };
    }

    return {
      content: "retry-ok",
      tool_calls: []
    };
  });

  installTool(runtime, {
    name: "demo_tool",
    description: "demo",
    inputSchema: { type: "object", properties: { value: { type: "number" } } },
    execute: async () => {
      executeCount += 1;
      if (executeCount === 1) {
        return { ok: false, content: "first-failed" };
      }
      return { ok: true, content: "second-ok" };
    }
  });

  const finalText = await runtime.runOnceStream("retry test", {
    plugins: [new WeavePlugin()],
    autoMode: true
  });

  assert(finalText === "retry-ok", "retry path should still finish with final response");
  assert(executeCount === 2, "retry path should execute tool twice");
  assert(
    events.some((event) => event.type === "plugin.output" && (
      event.payload?.outputType === "weave.dag.node" ||
      event.payload?.outputType === "weave.dag.edge" ||
      event.payload?.outputType === "weave.dag.event"
    )),
    "retry path should emit weave dag events"
  );
}

async function verifyTimeoutPath(config) {
  process.env.WEAVE_DAG_TOOL_RETRIES = "0";
  process.env.WEAVE_DAG_TOOL_TIMEOUT_MS = "40";

  const { runtime, events } = createRuntime(config, async (_input, callCount) => {
    if (callCount === 1) {
      return {
        content: null,
        tool_calls: [
          {
            id: "call_timeout",
            type: "function",
            function: {
              name: "slow_tool",
              arguments: JSON.stringify({})
            }
          }
        ]
      };
    }

    return {
      content: "timeout-finished",
      tool_calls: []
    };
  });

  installTool(runtime, {
    name: "slow_tool",
    description: "slow",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      await sleep(120);
      return { ok: true, content: "late-success" };
    }
  });

  const finalText = await runtime.runOnceStream("timeout test", {
    plugins: [new WeavePlugin()]
  });

  assert(finalText === "timeout-finished", "timeout path should keep loop alive and finish");
  assert(
    events.some(
      (event) =>
        event.type === "tool.execution.end" &&
        event.payload?.toolStatus === "fail" &&
        String(event.payload?.toolResultText || "").includes("超时")
    ),
    "timeout path should emit fail status containing timeout reason"
  );
}

async function verifyApprovalInterruptRecovery(config) {
  process.env.WEAVE_DAG_TOOL_RETRIES = "0";
  process.env.WEAVE_DAG_TOOL_TIMEOUT_MS = "1000";

  const { runtime, events } = createRuntime(config, async (_input, callCount) => {
    if (callCount === 1) {
      return {
        content: null,
        tool_calls: [
          {
            id: "call_approval",
            type: "function",
            function: {
              name: "demo_tool",
              arguments: JSON.stringify({ x: 1 })
            }
          }
        ]
      };
    }

    return {
      content: "approval-ok",
      tool_calls: []
    };
  });

  installTool(runtime, {
    name: "demo_tool",
    description: "demo",
    inputSchema: { type: "object", properties: { x: { type: "number" } } },
    execute: async () => ({ ok: true, content: "ok" })
  });

  const finalText = await runtime.runOnceStream("approval test", {
    plugins: [new WeavePlugin()],
    stepMode: true,
    approveToolCall: async () => {
      await sleep(20);
      return { action: "approve" };
    }
  });

  assert(finalText === "approval-ok", "approval path should recover and finish");
  assert(
    events.some((event) => event.type === "node.pending_approval"),
    "approval path should emit pending event"
  );
  assert(
    events.some((event) => event.type === "node.approval.resolved" && event.payload?.approvalAction === "approve"),
    "approval path should emit resolved approve event"
  );

  // 新版单一执行路径：审批流程通过 node.pending_approval / node.approval.resolved 事件表达
  // DAG runner 的 dag.node.transition(blocked/approval-resumed) 已由统一事件取代
  assert(
    events.some((event) => event.type === "node.pending_approval"),
    "approval path should include pending approval event"
  );
  assert(
    events.some((event) => event.type === "node.approval.resolved" && event.payload?.approvalAction === "approve"),
    "approval path should include approval resolved event"
  );
}

async function verifyOffOnStepConsistency(config) {
  process.env.WEAVE_DAG_TOOL_RETRIES = "0";
  process.env.WEAVE_DAG_TOOL_TIMEOUT_MS = "1000";

  const off = createRuntime(config, async () => ({ content: "CONSISTENT", tool_calls: [] }));
  const on = createRuntime(config, async () => ({ content: "CONSISTENT", tool_calls: [] }));
  const step = createRuntime(config, async () => ({ content: "CONSISTENT", tool_calls: [] }));

  const offText = await off.runtime.runOnceStream("consistency off");
  const onText = await on.runtime.runOnceStream("consistency on", {
    plugins: [new WeavePlugin()]
  });
  const stepText = await step.runtime.runOnceStream("consistency step", {
    plugins: [new WeavePlugin()],
    stepMode: true,
    approveToolCall: async () => ({ action: "approve" })
  });

  assert(offText === "CONSISTENT", "off mode final text mismatch");
  assert(onText === "CONSISTENT", "on mode final text mismatch");
  assert(stepText === "CONSISTENT", "step mode final text mismatch");
}

function createRuntime(config, responder) {
  const registry = new ToolRegistry();
  const runtime = new AgentRuntime(config, new MemoryStore("memories"), registry);
  runtime.startSession(`test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

  let callCount = 0;
  runtime.llmClient = {
    chat: async () => "{}",
    chatWithTools: async (input) => {
      callCount += 1;
      const result = await responder(input, callCount);
      return {
        role: "assistant",
        content: result.content,
        tool_calls: result.tool_calls
      };
    }
  };

  const events = [];
  runtime.on("event", (event) => {
    events.push(event);
  });

  return { runtime, events };
}

function installTool(runtime, tool) {
  runtime.toolRegistry.register(tool);
}

function expectThrows(fn, message) {
  let ok = false;
  try {
    fn();
  } catch {
    ok = true;
  }
  if (!ok) {
    throw new Error(message);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
