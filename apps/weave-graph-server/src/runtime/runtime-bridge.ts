/*
 * 文件作用：提供网关到运行时的桥接接口与本地实现，隔离后续替换真实 AgentRuntime 的改造成本。
 */

import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RuntimeRawEvent } from "../projection/graph-projector.js";

export interface StartRunCommand {
  userInput: string;
  sessionId: string;
  clientRequestId?: string;
}

export interface StartRunResult {
  runId: string;
  sessionId: string;
  acceptedAt: string;
}

export interface AbortRunResult {
  runId: string;
  status: "aborted" | "not-running";
  abortedAt: string;
}

export interface LoadRunEventsResult {
  runId: string;
  events: RuntimeRawEvent[];
}

export interface RuntimeBridge {
  startRun(command: StartRunCommand): Promise<StartRunResult>;
  abortRun(runId: string): Promise<AbortRunResult>;
  loadRunEvents?(runId: string): Promise<LoadRunEventsResult | null>;
}

interface RuntimeBridgeFactoryOptions {
  onRuntimeEvent: (event: RuntimeRawEvent) => void;
}

interface WalEventRecordLike {
  event_type: string;
  payload: string;
  created_at?: string;
}

interface WalDaoLike {
  getExecutionWalEvents: (runId: string) => WalEventRecordLike[];
}

interface LocalRuntimeBridgeOptions {
  onRuntimeEvent: (event: RuntimeRawEvent) => void;
}

export class LocalRuntimeBridge implements RuntimeBridge {
  private readonly timersByRunId = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: LocalRuntimeBridgeOptions) {}

  async startRun(command: StartRunCommand): Promise<StartRunResult> {
    const runId = `web-run-${randomBytes(8).toString("hex")}`;
    const acceptedAt = new Date().toISOString();

    // 当前为占位实现：先发 run.start，再异步发 run.completed，后续替换为真实 AgentRuntime。
    this.options.onRuntimeEvent({
      runId,
      type: "run.start",
      timestamp: acceptedAt,
      payload: {
        userInput: command.userInput,
        sessionId: command.sessionId
      }
    });

    const timer = setTimeout(() => {
      this.options.onRuntimeEvent({
        runId,
        type: "run.completed",
        timestamp: new Date().toISOString(),
        payload: {
          finalText: "[local-runtime] run completed"
        }
      });
      this.timersByRunId.delete(runId);
    }, 1500);

    this.timersByRunId.set(runId, timer);

    return {
      runId,
      sessionId: command.sessionId,
      acceptedAt
    };
  }

  async abortRun(runId: string): Promise<AbortRunResult> {
    const timer = this.timersByRunId.get(runId);
    const abortedAt = new Date().toISOString();
    if (!timer) {
      return {
        runId,
        status: "not-running",
        abortedAt
      };
    }

    clearTimeout(timer);
    this.timersByRunId.delete(runId);

    this.options.onRuntimeEvent({
      runId,
      type: "run.error",
      timestamp: abortedAt,
      payload: {
        errorMessage: "run 已被手动终止"
      }
    });

    return {
      runId,
      status: "aborted",
      abortedAt
    };
  }

  async loadRunEvents(): Promise<LoadRunEventsResult | null> {
    return null;
  }
}

interface AgentRuntimeLike {
  startSession: (sessionId: string) => void;
  runOnceStream: (userInput: string, options?: { abortSignal?: AbortSignal }) => Promise<string>;
  on: (event: "event", listener: (evt: any) => void) => void;
}

class AgentRuntimeBridge implements RuntimeBridge {
  private readonly runtimeBySession = new Map<string, AgentRuntimeLike>();
  private readonly abortByRunId = new Map<string, AbortController>();
  private readonly activeRunBySession = new Map<string, string>();
  private walDao?: WalDaoLike;

  constructor(
    private readonly options: RuntimeBridgeFactoryOptions,
    private readonly deps: {
      loadLlmConfig: () => any;
      AgentRuntimeCtor: new (cfg: any, llm: any, mem: any, tools: any, dao: any, log: any, blob?: any) => AgentRuntimeLike;
      MemoryStoreCtor: new (baseDir?: string) => any;
      ToolRegistryCtor: new () => any;
      builtinTools: Array<any>;
      createWalDao: (repoRoot: string) => WalDaoLike;
      createLlmClient: (cfg: any) => any;
      createLogger: (mod: string) => any;
      createBlobStore: () => any;
      repoRoot: string;
    }
  ) {}

  private createRuntime(sessionId: string): AgentRuntimeLike {
    const llmConfig = this.deps.loadLlmConfig();
    const memoryStore = new this.deps.MemoryStoreCtor(join(this.deps.repoRoot, "memories"));
    const toolRegistry = new this.deps.ToolRegistryCtor();
    for (const tool of this.deps.builtinTools) {
      toolRegistry.register(tool);
    }

    const llmClient = this.deps.createLlmClient(llmConfig);
    const walDao = this.deps.createWalDao(this.deps.repoRoot);
    const logger = this.deps.createLogger("agent-runtime");
    const blobStore = this.deps.createBlobStore();

    const runtime = new this.deps.AgentRuntimeCtor(
      llmConfig,
      llmClient,
      memoryStore,
      toolRegistry,
      walDao,
      logger,
      blobStore
    );
    runtime.startSession(sessionId);
    runtime.on("event", (evt: any) => {
      this.options.onRuntimeEvent({
        runId: String(evt?.runId ?? ""),
        type: String(evt?.type ?? "unknown"),
        timestamp: String(evt?.timestamp ?? new Date().toISOString()),
        payload: (evt?.payload ?? {}) as Record<string, unknown>
      });
    });
    return runtime;
  }

  async startRun(command: StartRunCommand): Promise<StartRunResult> {
    const existingRunId = this.activeRunBySession.get(command.sessionId);
    if (existingRunId) {
      throw new Error(`session is busy with run=${existingRunId}`);
    }

    const runtime = this.runtimeBySession.get(command.sessionId) ?? this.createRuntime(command.sessionId);
    this.runtimeBySession.set(command.sessionId, runtime);

    const abortController = new AbortController();

    const started = await new Promise<StartRunResult>((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          reject(new Error("run.start timeout"));
        }
      }, 3000);

      const onEvent = (evt: any) => {
        if (evt?.type !== "run.start") return;
        if (String(evt?.payload?.sessionId ?? "") !== command.sessionId) return;

        const runId = String(evt?.runId ?? "");
        if (!runId) return;

        resolved = true;
        clearTimeout(timeout);
        this.abortByRunId.set(runId, abortController);
        this.activeRunBySession.set(command.sessionId, runId);
        resolve({
          runId,
          sessionId: command.sessionId,
          acceptedAt: String(evt?.timestamp ?? new Date().toISOString())
        });
      };

      runtime.on("event", onEvent);

      void runtime
        .runOnceStream(command.userInput, { abortSignal: abortController.signal })
        .catch(() => {
          // 错误事件由 runtime event 通道广播，这里避免未处理拒绝。
        })
        .finally(() => {
          const activeRunId = this.activeRunBySession.get(command.sessionId);
          if (activeRunId) {
            this.activeRunBySession.delete(command.sessionId);
            this.abortByRunId.delete(activeRunId);
          }
        });
    });

    return started;
  }

  async abortRun(runId: string): Promise<AbortRunResult> {
    const abortController = this.abortByRunId.get(runId);
    const abortedAt = new Date().toISOString();
    if (!abortController) {
      return { runId, status: "not-running", abortedAt };
    }

    abortController.abort(new Error("gateway abort"));
    this.abortByRunId.delete(runId);
    for (const [sessionId, activeRunId] of this.activeRunBySession.entries()) {
      if (activeRunId === runId) {
        this.activeRunBySession.delete(sessionId);
      }
    }
    return { runId, status: "aborted", abortedAt };
  }

  async loadRunEvents(runId: string): Promise<LoadRunEventsResult | null> {
    if (!this.deps.createWalDao) {
      return null;
    }

    this.walDao ??= this.deps.createWalDao(this.deps.repoRoot);
    const records = this.walDao.getExecutionWalEvents(runId);
    if (!records.length) {
      return null;
    }

    const events: RuntimeRawEvent[] = records.map((record: WalEventRecordLike) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(record.payload) as Record<string, unknown>;
      } catch {
        payload = {};
      }

      return {
        runId,
        type: String(record.event_type || "unknown"),
        timestamp: String(record.created_at || new Date().toISOString()),
        payload
      };
    });

    return { runId, events };
  }
}

export async function createRuntimeBridge(options: RuntimeBridgeFactoryOptions): Promise<RuntimeBridge> {
  const localFallback = new LocalRuntimeBridge({ onRuntimeEvent: options.onRuntimeEvent });

  try {
    const runtimeDir = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(runtimeDir, "../../../../");

    const importFirstAvailable = async (candidates: string[]): Promise<any> => {
      let lastError: unknown;
      for (const candidate of candidates) {
        try {
          return await import(pathToFileURL(join(repoRoot, candidate)).href);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("module import failed");
    };

    const [
      configMod,
      agentMod,
      memoryMod,
      toolRegistryMod,
      builtinsMod,
      llmMod,
      loggingMod,
      storageMod,
      walMod,
      walDaoMod
    ] = await Promise.all([
      importFirstAvailable(["src/infrastructure/config/load-llm-config.ts", "dist/infrastructure/config/load-llm-config.js"]),
      importFirstAvailable(["src/application/agent/run-agent.ts", "dist/application/agent/run-agent.js"]),
      importFirstAvailable(["src/infrastructure/memory/memory-store.ts", "dist/infrastructure/memory/memory-store.js"]),
      importFirstAvailable(["src/infrastructure/tools/tool-registry.ts", "dist/infrastructure/tools/tool-registry.js"]),
      importFirstAvailable(["src/infrastructure/tools/builtins/index.ts", "dist/infrastructure/tools/builtins/index.js"]),
      importFirstAvailable(["src/infrastructure/llm/qwen-client.ts", "dist/infrastructure/llm/qwen-client.js"]),
      importFirstAvailable(["src/infrastructure/logging/app-logger.ts", "dist/infrastructure/logging/app-logger.js"]),
      importFirstAvailable(["src/infrastructure/storage/blob-store.ts", "dist/infrastructure/storage/blob-store.js"]),
      importFirstAvailable(["src/infrastructure/wal/weave-db.ts", "dist/infrastructure/wal/weave-db.js"]),
      importFirstAvailable(["src/infrastructure/wal/wal-dao.ts", "dist/infrastructure/wal/wal-dao.js"])
    ]);

    return new AgentRuntimeBridge(options, {
      loadLlmConfig: () => {
        const configPath = join(repoRoot, "config/llm.config.json");
        return configMod.loadLlmConfig(configPath);
      },
      AgentRuntimeCtor: agentMod.AgentRuntime,
      MemoryStoreCtor: memoryMod.MemoryStore,
      ToolRegistryCtor: toolRegistryMod.ToolRegistry,
      builtinTools: builtinsMod.builtinTools,
      createWalDao: (root: string) => {
        const dbPath = join(root, ".dagent", "weave.db");
        const db = new walMod.WeaveDb(dbPath);
        return new walDaoMod.WalDao(db);
      },
      createLlmClient: (cfg: any) => new llmMod.QwenClient(cfg),
      createLogger: (mod: string) => new loggingMod.AppLogger(mod),
      createBlobStore: () => new storageMod.BlobStore(),
      repoRoot
    });
  } catch (error) {
    console.warn(`[graph-server] fallback to LocalRuntimeBridge: ${String(error)}`);
    return localFallback;
  }
}
