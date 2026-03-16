/**
 * 文件作用：提供可重复执行的 Step Gate 冒烟验证脚本，覆盖 approve/skip/edit 三条关键路径。
 */
import { AgentRuntime } from "../dist/agent/run-agent.js";
import { MemoryStore } from "../dist/memory/memory-store.js";
import { ToolRegistry } from "../dist/tools/tool-registry.js";

async function main() {
  const baseConfig = {
    provider: "qwen",
    model: "fake-model",
    baseUrl: "http://localhost",
    apiKey: "fake-api-key"
  };

  await verifySkipPath(baseConfig);
  await verifyEditPath(baseConfig);
  await verifyApprovePath(baseConfig);

  console.log("Step Gate smoke tests passed.");
}

async function verifySkipPath(config) {
  let executeCount = 0;
  const { runtime, events } = createRuntime(config, async () => ({
    content: null,
    tool_calls: [
      {
        id: "call_skip",
        type: "function",
        function: {
          name: "demo_tool",
          arguments: JSON.stringify({ value: 1 })
        }
      }
    ]
  }));

  installTool(runtime, {
    name: "demo_tool",
    description: "demo",
    inputSchema: { type: "object", properties: { value: { type: "number" } } },
    execute: async () => {
      executeCount += 1;
      return { ok: true, content: "executed" };
    }
  });

  await runtime.runOnceStream("skip test", {
    stepMode: true,
    approveToolCall: async () => ({ action: "skip" })
  });

  assert(executeCount === 0, "skip path should not execute real tool");
  assert(events.some((event) => event.type === "node.pending_approval"), "skip path should emit node.pending_approval");
  assert(
    events.some((event) => event.type === "node.approval.resolved" && event.payload?.approvalAction === "skip"),
    "skip path should emit resolved action=skip"
  );
  assert(
    events.some((event) => event.type === "tool.execution.end" && event.payload?.toolStatus === "fail"),
    "skip path should emit tool.execution.end fail"
  );
}

async function verifyEditPath(config) {
  let seenArg = 0;
  const { runtime, events } = createRuntime(config, async (_input, count) => {
    if (count === 1) {
      return {
        content: null,
        tool_calls: [
          {
            id: "call_edit",
            type: "function",
            function: {
              name: "demo_tool",
              arguments: JSON.stringify({ value: 2 })
            }
          }
        ]
      };
    }

    return {
      content: "done",
      tool_calls: []
    };
  });

  installTool(runtime, {
    name: "demo_tool",
    description: "demo",
    inputSchema: { type: "object", properties: { value: { type: "number" } } },
    execute: async (_context, args) => {
      const value = args?.value ?? 0;
      seenArg = value;
      return { ok: true, content: "edited" };
    }
  });

  const finalText = await runtime.runOnceStream("edit test", {
    stepMode: true,
    approveToolCall: async () => ({ action: "edit", editedArgs: { value: 9 } })
  });

  assert(finalText === "done", "edit path should continue and return final text");
  assert(seenArg === 9, "edit path should pass edited args to tool execute");
  assert(
    events.some((event) => event.type === "node.approval.resolved" && event.payload?.approvalAction === "edit"),
    "edit path should emit resolved action=edit"
  );
}

async function verifyApprovePath(config) {
  let executeCount = 0;
  const { runtime, events } = createRuntime(config, async (_input, count) => {
    if (count === 1) {
      return {
        content: null,
        tool_calls: [
          {
            id: "call_approve",
            type: "function",
            function: {
              name: "demo_tool",
              arguments: JSON.stringify({ value: 3 })
            }
          }
        ]
      };
    }

    return {
      content: "approved-done",
      tool_calls: []
    };
  });

  installTool(runtime, {
    name: "demo_tool",
    description: "demo",
    inputSchema: { type: "object", properties: { value: { type: "number" } } },
    execute: async () => {
      executeCount += 1;
      return { ok: true, content: "approved" };
    }
  });

  const finalText = await runtime.runOnceStream("approve test", {
    stepMode: true,
    approveToolCall: async () => ({ action: "approve" })
  });

  assert(finalText === "approved-done", "approve path should complete final response");
  assert(executeCount === 1, "approve path should execute tool exactly once");
  assert(
    events.some((event) => event.type === "node.approval.resolved" && event.payload?.approvalAction === "approve"),
    "approve path should emit resolved action=approve"
  );
}

function createRuntime(config, responder) {
  const registry = new ToolRegistry();
  const runtime = new AgentRuntime(config, new MemoryStore("memories"), registry);
  runtime.startSession(`test_${Date.now()}`);

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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
