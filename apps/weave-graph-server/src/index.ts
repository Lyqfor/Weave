/*
 * 文件作用：后端入口骨架，连接 Runtime 事件源 -> GraphProjector -> WS 网关。
 */

import { GraphProjector, type RuntimeRawEvent } from "./projection/graph-projector.js";
import { createGraphGateway } from "./gateway/ws-gateway.js";

async function main(): Promise<void> {
  const projector = new GraphProjector();
  const gateway = await createGraphGateway();

  // 注册二次校验钩子 (Double Validation)
  // 后续可进一步接入 ToolRegistry 进行 Schema 校验
  gateway.registerValidationHandler(async (nodeId, params) => {
    try {
      JSON.parse(params);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `后端校验失败：无效的 JSON 格式 (${String(e)})` };
    }
  });

  console.log(`[graph-server] ws://127.0.0.1:${gateway.port}/?token=${gateway.token}`);
  console.log(`[graph-server] ingest=${gateway.ingestUrl} token=${gateway.token}`);

  // 这里应替换为真实 Runtime 事件订阅：
  // runtime.on("event", (evt) => forward(evt))
  const forward = (evt: RuntimeRawEvent): void => {
    const graphEvents = projector.project(evt);
    for (const graphEvent of graphEvents) {
      gateway.publish(graphEvent);
    }
  };

  gateway.registerRuntimeIngestHandler(forward);

  // Demo: 用于验证协议链路通路。
  forward({
    runId: "demo-run-1",
    type: "run.start",
    timestamp: new Date().toISOString(),
    payload: { userInput: "ls -a" }
  });
}

main().catch((error) => {
  console.error("[graph-server] failed", error);
  process.exitCode = 1;
});
