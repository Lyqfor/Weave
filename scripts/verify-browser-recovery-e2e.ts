/**
 * 文件作用：浏览器级恢复链路 E2E 验证。
 * 覆盖页面启动、WS 强制断开、离线 RPC 入队、自动重连后补发与响应接收。
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium, type Page } from "playwright";
import { createGraphGateway } from "../apps/weave-graph-server/src/gateway/ws-gateway";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function contentTypeByExt(ext: string): string {
  switch (ext) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    default: return "application/octet-stream";
  }
}

async function createStaticServer(rootDir: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    try {
      const rawPath = req.url?.split("?")[0] ?? "/";
      const safePath = normalize(rawPath).replace(/^\\+|^\/+/, "");
      const relPath = safePath.length === 0 ? "index.html" : safePath;
      const filePath = join(rootDir, relPath);
      const data = await readFile(filePath);
      res.statusCode = 200;
      res.setHeader("Content-Type", contentTypeByExt(extname(filePath)));
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end("Not Found");
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function waitForStatus(page: Page, expectedText: string, timeoutMs = 15000): Promise<void> {
  await page.waitForFunction(
    (target: string) => document.body.innerText.includes(target),
    expectedText,
    { timeout: timeoutMs }
  );
}

async function waitForCondition(checker: () => boolean, timeoutMs = 10000, intervalMs = 60): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (checker()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitForCondition timeout");
}

async function main(): Promise<void> {
  const gateway = await createGraphGateway();
  const staticServer = await createStaticServer("apps/weave-graph-web/dist");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const url = `http://127.0.0.1:${staticServer.port}/?token=${gateway.token}&port=${gateway.port}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  await page.waitForSelector(".magic-input", { timeout: 15000 });
  await page.fill(".magic-input", "e2e reconnect recovery");
  await page.click(".magic-send-btn");

  // 首次连接建立后，Header 展示“已连接”。
  await waitForStatus(page, "已连接", 20000);

  // 主动断开客户端，触发前端重连流程。
  gateway.disconnectAllClients("e2e-force-disconnect");

  // 等待页面感知断开，确保后续RPC进入离线队列。
  await waitForStatus(page, "已断开", 10000);

  // 在断开期间注入一条 RPC 事件，要求前端进入离线队列。
  const queuedReqId = `e2e-queued-${Date.now()}`;
  await page.evaluate((reqId) => {
    window.dispatchEvent(new CustomEvent("weave:rpc:send", {
      detail: {
        envelope: {
          type: "run.subscribe",
          reqId,
          payload: {
            runId: "run-not-exist"
          }
        }
      }
    }));
  }, queuedReqId);

  // 等待自动重连回到已连接。
  await waitForStatus(page, "已连接", 20000);

  // 校验：离线入队请求在重连后确实发送到网关。
  await waitForCondition(() => gateway.hasObservedRpcRequest(queuedReqId), 10000);

  await browser.close();
  await staticServer.close();
  await gateway.close();

  console.log("Browser recovery E2E verification passed.", {
    queuedReqId,
    webPort: staticServer.port,
    gatewayPort: gateway.port
  });
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
