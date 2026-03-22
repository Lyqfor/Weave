/*
 * 文件作用：提供本地 WS 网关，按会话 token 广播图协议事件，并支持前端发送 gate.action 审批消息。
 */

import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import {
  type GraphEnvelope,
  type ClientMessageEnvelope,
  type ServerResponseMessageEnvelope,
  GRAPH_SCHEMA_VERSION,
  type GateActionPayload,
  type StartRunPayload,
  type StartRunResponsePayload,
  type RunSubscribePayload,
  type RunSubscribeResponsePayload,
  type RunAbortPayload,
  type RunAbortResponsePayload,
  type RpcErrorPayload
} from "../protocol/graph-events.js";
import type { RuntimeRawEvent } from "../projection/graph-projector.js";
import { RunRegistry } from "../runtime/run-registry.js";
import type { AbortRunResult, StartRunResult } from "../runtime/runtime-bridge.js";

export interface GateDecision {
  action: "approve" | "edit" | "skip" | "abort";
  params?: string;
}

export type ValidationHandler = (nodeId: string, params: string) => Promise<{ ok: boolean; error?: string }>;

interface RunCommandHandlers {
  startRun?: (payload: StartRunPayload) => Promise<StartRunResult>;
  abortRun?: (runId: string) => Promise<AbortRunResult>;
  replayRunEvents?: (runId: string) => Promise<Array<GraphEnvelope<unknown>> | null>;
}

export interface GraphGateway {
  port: number;
  token: string;
  ingestUrl: string;
  publish(event: GraphEnvelope<unknown>): void;
  registerRuntimeIngestHandler(handler: (event: RuntimeRawEvent) => void): void;
  registerRunCommandHandlers(handlers: RunCommandHandlers): void;
  registerValidationHandler(handler: ValidationHandler): void;
  getGateDecision(gateId: string): GateDecision | undefined;
  clearGateDecision(gateId: string): void;
  /**
   * 测试辅助能力：主动断开当前全部 WS 客户端连接，用于验证前端重连恢复链路。
   */
  disconnectAllClients(reason?: string): void;
  /**
   * 测试辅助能力：查询网关是否已收到某个 RPC 请求。
   */
  hasObservedRpcRequest(reqId: string): boolean;
  close(): Promise<void>;
  httpServer: HttpServer;
}

export async function createGraphGateway(staticDir?: string): Promise<GraphGateway> {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  if (staticDir) {
    app.use(express.static(staticDir));
  }

  const token = randomBytes(16).toString("hex");
  let runtimeIngestHandler: ((event: RuntimeRawEvent) => void) | null = null;
  let validationHandler: ValidationHandler = async () => ({ ok: true });
  let runCommandHandlers: RunCommandHandlers = {};
  const observedRpcReqIds = new Set<string>();
  let seqSeed = 0;
  const maxReplayEvents = 1000;
  const eventsByRunId = new Map<string, Array<GraphEnvelope<unknown>>>();
  const runRegistry = new RunRegistry();

  // 存储来自 Web 前端的 gate 审批决策，key=gateId（即 toolCallId）
  const pendingGateDecisions = new Map<string, GateDecision>();

  app.post("/ingest/runtime-event", (req, res) => {
    const incomingToken = req.headers["x-graph-token"];
    if (incomingToken !== token) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }

    if (!runtimeIngestHandler) {
      res.status(503).json({ ok: false, error: "ingest-handler-not-ready" });
      return;
    }

    runtimeIngestHandler(req.body as RuntimeRawEvent);
    console.log(`[graph-server] ingest accepted type=${String((req.body as RuntimeRawEvent)?.type ?? "unknown")}`);
    res.status(202).json({ ok: true });
  });

  // CLI 轮询端点：获取 Web 前端已做的 gate 审批决策
  app.get("/api/gate/decision/:gateId", (req, res) => {
    const incomingToken = req.headers["x-graph-token"];
    if (incomingToken !== token) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }

    const gateId = req.params["gateId"] ?? "";
    const decision = pendingGateDecisions.get(gateId);
    if (!decision) {
      res.status(204).end();
      return;
    }

    console.log(`[graph-server] gate decision picked up gateId=${gateId} action=${decision.action}`);
    res.status(200).json(decision);
  });

  // Blob 按需拉取端点（供前端 Inspector 大内容懒加载）
  app.get("/api/blob/:blobRef", (req, res) => {
    const blobRef = req.params["blobRef"] ?? "";
    if (!blobRef || !/^[0-9a-f]{32}$/.test(blobRef)) {
      res.status(400).json({ ok: false, error: "invalid-blob-ref" });
      return;
    }

    const filePath = join(tmpdir(), "dagent-blobs", `${blobRef}.json`);
    readFile(filePath, "utf-8")
      .then((data) => {
        res.setHeader("Content-Type", "application/json");
        res.status(200).send(data);
      })
      .catch(() => {
        res.status(404).json({ ok: false, error: "blob-not-found" });
      });
  });

  // CLI 清除已消费的 gate 决策
  app.delete("/api/gate/decision/:gateId", (req, res) => {
    const incomingToken = req.headers["x-graph-token"];
    if (incomingToken !== token) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }

    const gateId = req.params["gateId"] ?? "";
    pendingGateDecisions.delete(gateId);
    res.status(204).end();
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  // 辅助函数：发送 RPC 响应
  const sendResponse = (ws: WebSocket, reqId: string, ok: boolean, error?: string, payload?: unknown) => {
    if (ws.readyState !== ws.OPEN) return;
    const response: ServerResponseMessageEnvelope = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      eventType: "server.response",
      reqId,
      ok,
      error,
      payload
    };
    ws.send(JSON.stringify(response));
  };

  const sendRpcError = (ws: WebSocket, reqId: string | undefined, code: RpcErrorPayload["code"], message: string) => {
    if (!reqId) return;
    sendResponse(ws, reqId, false, message, { code, message } satisfies RpcErrorPayload);
  };

  const pushRunEvent = (event: GraphEnvelope<unknown>) => {
    const cached = eventsByRunId.get(event.runId) ?? [];
    cached.push(event);
    if (cached.length > maxReplayEvents) {
      cached.splice(0, cached.length - maxReplayEvents);
    }
    eventsByRunId.set(event.runId, cached);
  };

  const locateReplayFromBuffer = (
    buffer: Array<GraphEnvelope<unknown>>,
    lastEventId?: string
  ): { replayEvents: Array<GraphEnvelope<unknown>>; cursorFound: boolean } => {
    if (!lastEventId) {
      return { replayEvents: buffer, cursorFound: true };
    }

    const index = buffer.findIndex((item) => item.eventId === lastEventId);
    if (index < 0) {
      return { replayEvents: [], cursorFound: false };
    }

    return { replayEvents: buffer.slice(index + 1), cursorFound: true };
  };

  const publishToAll = (event: GraphEnvelope<unknown>) => {
    pushRunEvent(event);
    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  };

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const incomingToken = url.searchParams.get("token") ?? "";

    if (incomingToken !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\\r\\n\\r\\n");
      socket.destroy();
      return;
    }

    if (
      req.headers.origin &&
      !String(req.headers.origin).startsWith("http://127.0.0.1") &&
      !String(req.headers.origin).startsWith("http://localhost")
    ) {
      socket.write("HTTP/1.1 403 Forbidden\\r\\n\\r\\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    clients.add(ws);

    const pingTimer = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      }
    }, 10_000);

    // 接收来自前端的消息（RPC 模式或旧版直接发送）
    ws.on("message", async (raw) => {
      let rawData: unknown;
      try {
        rawData = JSON.parse(String(raw));
      } catch (error) {
        console.error(`[graph-server] Failed to parse message: ${String(error)}`);
        return;
      }

      // 路径 A: 新版 RPC 信封 (ClientMessageEnvelope)
      if (rawData && typeof rawData === "object" && "type" in rawData && "payload" in rawData) {
        const msg = rawData as ClientMessageEnvelope<any>;
        const { type, reqId, payload } = msg;
        if (reqId) {
          observedRpcReqIds.add(reqId);
        }

        try {
          if (type === "start.run") {
            const runPayload = payload as StartRunPayload;
            const inputText = runPayload.userInput?.trim();
            if (!inputText) {
              sendRpcError(ws, reqId, "INVALID_ARGUMENT", "输入不能为空");
              return;
            }
            const sessionId = runPayload.sessionId?.trim() || `web-session-${randomBytes(6).toString("hex")}`;

            if (!runRegistry.canStart(sessionId)) {
              sendRpcError(ws, reqId, "AGENT_BUSY", "当前会话已有任务执行中，请等待或先终止");
              return;
            }

            const commandInput: StartRunPayload = {
              userInput: inputText,
              sessionId,
              clientRequestId: runPayload.clientRequestId
            };

            const started = runCommandHandlers.startRun
              ? await runCommandHandlers.startRun(commandInput)
              : {
                  runId: `web-run-${randomBytes(8).toString("hex")}`,
                  sessionId,
                  acceptedAt: new Date().toISOString()
                };

            runRegistry.start(started.runId, started.sessionId, started.acceptedAt);

            const responsePayload: StartRunResponsePayload = {
              runId: started.runId,
              sessionId: started.sessionId,
              acceptedAt: started.acceptedAt,
              status: "accepted"
            };
            if (reqId) {
              sendResponse(ws, reqId, true, undefined, responsePayload);
            }

            // 兼容回退：当未挂载 RuntimeBridge 时，网关自行广播 run.start。
            if (!runCommandHandlers.startRun) {
              const envelope: GraphEnvelope<any> = {
                schemaVersion: GRAPH_SCHEMA_VERSION,
                eventId: `${started.runId}:${seqSeed + 1}`,
                seq: ++seqSeed,
                runId: started.runId,
                dagId: started.runId,
                eventType: "run.start",
                timestamp: started.acceptedAt,
                payload: {
                  dagId: started.runId,
                  sessionId,
                  userInputSummary: inputText.length > 72 ? `${inputText.slice(0, 72)}...` : inputText
                }
              };
              publishToAll(envelope);
            }
            console.log(`[graph-server] RPC start.run accepted runId=${started.runId}`);
            return;
          }

          if (type === "run.subscribe") {
            const subscribePayload = payload as RunSubscribePayload;
            const runId = subscribePayload.runId?.trim();
            if (!runId) {
              sendRpcError(ws, reqId, "INVALID_ARGUMENT", "runId 不能为空");
              return;
            }

            const lastEventId = subscribePayload.lastEventId?.trim();
            const runMeta = runRegistry.get(runId);
            let sourceBuffer = eventsByRunId.get(runId);
            let replayEvents: Array<GraphEnvelope<unknown>> = [];
            let cursorFound = true;

            if (sourceBuffer) {
              const located = locateReplayFromBuffer(sourceBuffer, lastEventId);
              replayEvents = located.replayEvents;
              cursorFound = located.cursorFound;
            }

            // 内存 RingBuffer miss 时，尝试 WAL 降级回放。
            if ((!sourceBuffer || !cursorFound) && runCommandHandlers.replayRunEvents) {
              const replayedFromWal = await runCommandHandlers.replayRunEvents(runId);
              if (replayedFromWal && replayedFromWal.length > 0) {
                sourceBuffer = replayedFromWal;
                const keep = replayedFromWal.slice(-maxReplayEvents);
                eventsByRunId.set(runId, keep);
                const located = locateReplayFromBuffer(replayedFromWal, lastEventId);
                replayEvents = located.replayEvents;
                cursorFound = located.cursorFound;
              }
            }

            if (lastEventId && !cursorFound) {
              sendRpcError(ws, reqId, "RESYNC_REQUIRED", "事件游标已失效，请清空本地缓存后全量重订阅");
              return;
            }

            if (!sourceBuffer && !runMeta) {
              sendRpcError(ws, reqId, "RUN_NOT_FOUND", `未找到 run: ${runId}`);
              return;
            }

            for (const replayEvent of replayEvents) {
              if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify(replayEvent));
              }
            }

            if (reqId) {
              const response: RunSubscribeResponsePayload = {
                runId,
                replayedCount: replayEvents.length
              };
              sendResponse(ws, reqId, true, undefined, response);
            }
            return;
          }

          if (type === "run.abort") {
            const abortPayload = payload as RunAbortPayload;
            const runId = abortPayload.runId?.trim();
            if (!runId) {
              sendRpcError(ws, reqId, "INVALID_ARGUMENT", "runId 不能为空");
              return;
            }

            const runMeta = runRegistry.get(runId);
            if (!runMeta) {
              sendRpcError(ws, reqId, "RUN_NOT_FOUND", `未找到 run: ${runId}`);
              return;
            }

            const abortedAt = new Date().toISOString();
            let status: RunAbortResponsePayload["status"] = "not-running";
            if (runMeta.state === "running") {
              const abortResult = runCommandHandlers.abortRun
                ? await runCommandHandlers.abortRun(runId)
                : { runId, status: "aborted" as const, abortedAt };
              status = abortResult.status;

              runRegistry.mark(runId, status === "aborted" ? "aborted" : "failed", abortResult.abortedAt);

              // 兼容回退：当未挂载 RuntimeBridge 时，网关自行广播 run.end。
              if (!runCommandHandlers.abortRun && status === "aborted") {
                const endEnvelope: GraphEnvelope<any> = {
                  schemaVersion: GRAPH_SCHEMA_VERSION,
                  eventId: `${runId}:${seqSeed + 1}`,
                  seq: ++seqSeed,
                  runId,
                  dagId: runId,
                  eventType: "run.end",
                  timestamp: abortResult.abortedAt,
                  payload: {
                    ok: false,
                    finalSummary: "run 已被手动终止"
                  }
                };
                publishToAll(endEnvelope);
              }
            }

            if (reqId) {
              const response: RunAbortResponsePayload = { runId, status, abortedAt };
              sendResponse(ws, reqId, true, undefined, response);
            }
            return;
          }

          if (type === "gate.action") {
            const gatePayload = payload as GateActionPayload;
            const { gateId, action, params } = gatePayload;

            // 二次校验拦截 (Double Validation)
            if (action === "edit" && params) {
              const valResult = await validationHandler(gateId, params);
              if (!valResult.ok) {
                if (reqId) sendResponse(ws, reqId, false, valResult.error);
                return;
              }
            }

            const decision: GateDecision = { action, params };
            pendingGateDecisions.set(gateId, decision);
            console.log(`[graph-server] RPC gate.action received gateId=${gateId} action=${action}`);

            if (reqId) sendResponse(ws, reqId, true);
          } else {
            console.warn(`[graph-server] Unknown RPC message type: ${type}`);
            if (reqId) sendResponse(ws, reqId, false, `Unknown command: ${type}`);
          }
          return;
        } catch (error) {
          // 关键修复：业务异常也必须回包，避免前端请求悬挂。
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[graph-server] Failed to handle RPC type=${type}: ${message}`);
          if (reqId) {
            sendResponse(ws, reqId, false, message);
          }
          return;
        }
      }

      // 路径 B: 兼容旧版散装 JSON (向后兼容)
      const msg = rawData as { type?: string; gateId?: string; action?: string; params?: string };
      if (msg.type === "gate.action" && msg.gateId && msg.action) {
        const decision: GateDecision = {
          action: msg.action as GateDecision["action"],
          params: msg.params
        };
        pendingGateDecisions.set(msg.gateId, decision);
        console.log(`[graph-server] legacy gate.action received gateId=${msg.gateId} action=${msg.action}`);
      }
    });

    ws.on("close", () => {
      clearInterval(pingTimer);
      clients.delete(ws);
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    token,
    ingestUrl: `http://127.0.0.1:${port}/ingest/runtime-event`,
    httpServer,
    publish(event) {
      const normalizedEvent: GraphEnvelope<unknown> = {
        ...event,
        eventId: event.eventId || `${event.runId}:${event.seq}`
      };

      if (normalizedEvent.eventType === "run.end") {
        const existing = runRegistry.get(normalizedEvent.runId);
        if (existing?.state === "running") {
          const endPayload = (normalizedEvent.payload ?? {}) as { ok?: boolean };
          runRegistry.mark(normalizedEvent.runId, endPayload.ok === false ? "failed" : "completed", normalizedEvent.timestamp);
        }
      }

      console.log(`[graph-server] publish event=${normalizedEvent.eventType} run=${normalizedEvent.runId} clients=${clients.size}`);
      publishToAll(normalizedEvent);
    },
    registerRuntimeIngestHandler(handler) {
      runtimeIngestHandler = handler;
    },
    registerRunCommandHandlers(handlers) {
      runCommandHandlers = { ...handlers };
    },
    registerValidationHandler(handler) {
      validationHandler = handler;
    },
    getGateDecision(gateId) {
      return pendingGateDecisions.get(gateId);
    },
    clearGateDecision(gateId) {
      pendingGateDecisions.delete(gateId);
    },
    disconnectAllClients(reason = "test-force-disconnect") {
      for (const client of clients) {
        try {
          client.close(1012, reason);
        } catch {
          // ignore
        }
      }
    },
    hasObservedRpcRequest(reqId) {
      return observedRpcReqIds.has(reqId);
    },
    async close() {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    }
  };
}
