# Dagent 当前项目架构与文件职责

## 文档目标
说明当前项目架构分层，并解释关键文件的作用与职责。

## 当前目录结构（MVP 阶段）

```text
dagent/
  logs/
    runtime/
    conversations/
  sessions/
  memories/
  config/
  docs/
    project/
      development-progress.md
      architecture-and-files.md
      weave-dag-runtime-architecture.md
      weave-2d-graph-blueprint.md
  apps/
    weave-graph-server/
    weave-graph-web/
  src/
    agent/
      plugins/
    engine/
    nodes/
    session/
    event/
    config/
    llm/
    tui/
    tools/
    weave/
    utils/
    types/
    errors/
    index.ts
  package.json
  tsconfig.json
  .env.example
  .gitignore
```

## 当前分层映射

1. 配置层（Config Layer）
- 负责模型配置读取、参数校验与 API Key 解析。

2. 记忆层（Memory Layer）
- 负责系统提示词、Agent 风格、用户风格和长期记忆的文件化存储与加载。

3. 日志层（Logging Layer）
- 负责核心调用链路日志打标与落盘。
- 负责每次对话（run）生成单独调用链路日志文档。

4. Agent 层（Agent Layer）
- 提供面向上层调用的运行时抽象，当前支持单轮调用与事件驱动流式调用。

5. LLM 适配层（LLM Adapter Layer）
- 封装 Provider 调用细节（当前为 Qwen 的 OpenAI 兼容接口），支持一次性与流式两种调用方式。

6. 工具层（Tools Layer）
- 提供统一工具定义、注册中心与执行接口。
- 运行时通过注册中心解耦调用具体工具实现。

7. 应用入口层（App Entry Layer）
- 提供 CLI 启动入口，用于本地联调与冒烟验证。

8. 插件扩展层（Plugin Layer）
- 在 Agent-loop 关键节点提供钩子扩展（LLM 输入前、LLM 输出后、工具执行前后、运行完成/失败）。
- 支持按需启用 Weave 插件，不影响默认非 Weave 运行路径。

9. 终端界面层（TUI Layer）
- 基于 Ink（React for CLI）实现动态终端界面。
- 通过事件网关监听 Runtime 事件并驱动细粒度 UI 状态更新。

10. 调度引擎层（Engine Layer）
- 提供 DAG 执行内核（`executeDag`）与 `WeaveDAGEngine` 面向对象封装。
- `EngineContext` 接口定义引擎最小依赖集（runId/dag/abortSignal 等），与智能体层解耦。
- `TurnEngineBusAdapter` 将引擎事件桥接到 WeaveEventBus（Layer 3 适配器）。

11. 二维图投影层（Graph Projection Layer）
- 负责将 Runtime 原始事件归一化为图协议事件（node/edge/status/io）。
- 负责协议版本控制、序号去重基础与前端可消费结构。

12. 二维图网关层（Graph WS Gateway Layer）
- 负责本地 WebSocket 推送图协议事件。
- 负责 token 校验、Origin 限制、心跳保活。

13. 二维图前端层（Graph Web Layer）
- 负责 Zustand 图状态管理、React Flow 渲染与 Dagre 自动布局。
- 预留 Worker 布局管线，后续可升级 ELK 增量布局。

## 文件职责说明

### 根目录文件
- `package.json`
  - 定义脚本（`dev`、`build`、`start`、`verify:*`）与依赖。
  - 新增二维图一键脚本入口：`dev:graph:all`、`dev:graph:stop`。
  - 新增浏览器级恢复链路验证入口：`verify:browser-recovery-e2e`。
- `tsconfig.json`
  - 定义 TypeScript 编译目标与严格模式配置。
- `.env.example`
  - 环境变量模板（`QWEN_API_KEY`）。
- `.gitignore`
  - 忽略本地密钥和构建产物。

### 配置文件
  - 模型配置模板，供复制后按需修改。
  - 同时支持配置文件直写密钥（`apiKey`）和环境变量读取（`apiKeyEnv`）。
- `config/llm.config.json`
  - 新增恢复链路一键回归入口：`verify:recovery-all`（逻辑级 + 网关级 + 浏览器级 E2E）。
  - 应用实际运行时读取的配置文件。
### 记忆文件
- `memories/SOUL.md`
  - 存放 Agent 系统行为与风格语气（包含原系统提示词内容）。
- `memories/USER.md`
  - 存放用户风格偏好。
- `memories/MEMORY.md`
  - 存放长期记忆摘要。

### 源码文件
- `src/types/config.ts`
  - 定义 LLM 配置共享类型。
- `src/config/load-llm-config.ts`
  - 读取并校验配置。
  - 从配置文件或环境变量解析 API Key。
  - 对配置读取、校验、Key 缺失等关键节点进行日志打标。
- `src/llm/qwen-client.ts`
  - 封装对 Qwen 接口的 chat completion 调用。
  - 提供 `chatStream`，支持增量文本回调。
  - 支持多轮历史消息注入（historyMessages）。
  - 提供 `chatWithTools`，用于 Agent loop 的工具调用决策。
  - 对调用开始、响应完成、流式分片统计进行日志打标。
- `src/memory/memory-store.ts`
  - 提供文件化记忆读取能力与模板自动创建。
  - 提供系统提示词组合逻辑（基础提示词 + SOUL + USER + 长期记忆）。
- `src/logging/app-logger.ts`
  - 提供统一日志接口（INFO/ERROR + 标签）。
  - 输出核心调用链路日志到 `logs/runtime/`。
  - 提供对话链路日志写入函数，输出到 `logs/conversations/`。
- `src/agent/run-agent.ts`
  - 提供 `AgentRuntime` 抽象，当前暴露 `runOnce(userInput)` 和 `runOnceStream(userInput)`。
  - 提供 `startSession(sessionId)` 初始化会话，并维护多轮历史上下文。
  - 在调用前通过 `MemoryStore` 组装系统提示词并注入模型。
  - 内置双执行路径：Legacy loop 与最小 DagRunner。
  - 在 `weave=off` 时走 legacy；`weave=observe/step/auto` 时走 DagRunner（`on` 兼容映射到 `observe`）。
  - DagRunner 以节点/依赖图驱动执行，保留现有插件钩子与 Step Gate 事件。
  - 新增 LLM 调用复用层（`invokeLlmWithTools` / `invokeLlmText`），供主链路与工具重试共享。
  - 新增工具意图派生（intent/goal）与轻量重试机制：失败重试仅携带意图、上次参数、最近一次结果。
  - 新增 `autoMode` 运行参数：仅在 auto 模式开启失败自动修复重试；observe 模式默认不自动重试。
  - DAG 工具节点增加 `displayNodeId(step.index)`，用于将 `intent/goal/retry` detail 事件稳定映射到 TUI 可见节点（如 `1.1`）。
  - 重试过程透明化：在工具节点下输出“尝试子节点 + 修复子节点”，完整呈现失败、局部修复、自动重试链路。
  - 新增重试生命周期运行事件：`tool.retry.start` / `tool.retry.end`，用于诊断与外部观测。
  - 可读性策略：主工具节点仅输出状态与重试汇总，详细失败原因/修复结果下沉到子节点，降低重复噪声。
  - 局部修复节点按 LLM 决策语义输出：展示 `llm_output` 与 `repaired_args`，不再重复回放上一次错误文本。
  - 在流式调用过程中发布 `run.start`、`llm.request`、`llm.delta`、`llm.completed`、`run.completed`、`run.error` 事件。
  - 新增工具事件：`tool.execution.start`、`tool.execution.end`。
  - 新增 Step Gate 事件：`node.pending_approval`、`node.approval.resolved`。
  - `runOnceStream` 支持 Step 模式审批回调（`approve/edit/skip/abort`）。
  - 新增插件输出事件：`plugin.output`。
  - 在 Agent-loop 预留插件钩子：`beforeLlmRequest`、`afterLlmResponse`、`beforeToolExecution`、`afterToolExecution`。
  - 对事件发布、调用开始/结束/异常进行日志打标。
- `src/agent/message-dispatcher.ts`
  - 输入分发层：统一对用户输入做命令拦截、模式切换与问答消息分类。
  - 将控制命令（如 `/weave observe|auto|step|off`、`/q`）与问答执行解耦，避免 UI/入口层重复分支逻辑。
- `src/engine/engine-types.ts`
  - `EngineContext` 接口：调度引擎最小依赖集（runId/dag/abortSignal/abortController/nodeRegistry/stateStore/snapshotStore/logger）。
  - ⛔️ 不含 pendingRegistry（Step Gate 人机交互层，不得下沉到引擎层）。
- `src/engine/dag-executor.ts`
  - `executeDag(dag, ctx: EngineContext)` — DAG 主调度循环，Promise.all 并发 + AbortController 熔断。
  - `WeaveDAGEngine` — 面向对象封装，便于依赖注入与单元测试。
- `src/engine/engine-event-bus.ts`
  - `IEngineEventBus` 接口：引擎事件总线（onNodeCreated/onEdgeCreated/onNodeTransition/onNodeIo/onSchedulerIssue/onNodeStreamDelta?）。
  - 零外部依赖，实现由 Layer 3（TurnEngineBusAdapter）注入。
- `src/engine/dag-graph.ts`
  - DAG 图模型：支持节点依赖、数据边、就绪判定、环路检测与状态机迁移约束。
  - 同时充当广播站：addNode/addEdge/transitionStatus 自动通过 IEngineEventBus 发射引擎事件。
- `src/engine/state-store.ts`
  - 最小状态总线：管理运行上下文、节点输出与数据边输入解析。
- `src/engine/runner-types.ts`
  - 定义 Runner 抽象契约与运行参数类型（含 Step Gate 审批类型与 `autoMode` 开关）。
- `src/engine/runner-legacy.ts`
  - legacy 运行器适配层：将执行请求委托给现有 Agent-loop。
- `src/engine/runner-dag.ts`
  - Dag 运行器适配层：将执行请求委托给 DAG 执行内核。
- `src/engine/runner-selector.ts`
  - 运行器选择器：按模式选择执行内核。
- `src/engine/snapshot-store.ts`
  - 快照存储层：节点状态冻结/异步装配/落盘（回溯基础设施）。
- `src/engine/blob-store.ts`
  - BlobStore：大内容引用机制，防止节点端口数据膨胀。
- `src/agent/turn-engine-bus-adapter.ts`
  - `TurnEngineBusAdapter` — 将 `IEngineEventBus` 事件桥接到 `WeaveEventBus`（Layer 3 适配器）。
  - 实现 `onNodeStreamDelta`：LLM 流式 delta 广播，供 Web UI 节点实时展示。
- `src/nodes/base-node.ts`
  - `BaseNode<C extends EngineContext = any>` 抽象基类，模板方法控制流（拦截器→执行→状态收口）。
  - 泛型参数：LlmNode/ToolNode/FinalNode 使用 RunContext，容器节点使用 EngineContext。
- `src/nodes/llm-node.ts`
  - `LlmNode extends BaseNode<RunContext>`：LLM 推理决策节点，支持流式旁路 delta 广播。
- `src/nodes/tool-node.ts`
  - `ToolNode extends BaseNode<RunContext>`：工具调用节点，含重试链与 RepairNode/EscalationNode 子图。
- `src/nodes/final-node.ts`
  - `FinalNode extends BaseNode<RunContext>`：最终回答节点，负责流式输出文本。
- `src/nodes/input-node.ts`
  - `InputNode extends BaseNode<EngineContext>`：用户输入节点（DAG 起始点，已完成态）。
- `src/nodes/repair-node.ts`
  - `RepairNode extends BaseNode<EngineContext>`：参数修复 LLM 调用节点（可视化用）。
- `src/nodes/attempt-node.ts`
  - `AttemptNode extends BaseNode<EngineContext>`：工具重试执行尝试节点（可视化用）。
- `src/nodes/escalation-node.ts`
  - `EscalationNode extends BaseNode<EngineContext>`：重试耗尽升级节点（可视化用）。
- `src/nodes/node-types.ts`
  - 节点类型枚举、端口类型、错误/指标类型定义。
- `src/nodes/safe-serialize.ts`
  - `safeClone()` — 安全深拷贝（处理循环引用、BigInt 等不可序列化类型）。
- `src/session/run-context.ts`
  - `RunContext extends EngineContext`：DAG 节点执行上下文，叠加 LLM/工具/插件/Step Gate 层依赖。
- `src/index.ts`
  - CLI 入口，启动 Ink TUI 多轮会话（单次命令常驻）。
  - 显式初始化 `MemoryStore` 并注入 Agent Runtime。
  - 装配 TUI 应用并负责会话收尾（chain log / session 文件路径输出）。
  - 负责会话生命周期管理（sessionId、退出命令、双 Ctrl+C）。
  - 支持会话级 `/weave observe|auto|step|off` 模式切换，并兼容 `/weave on` 与 `/weave + 问题` 行内触发。
  - 新增非 TTY 回退执行模式（脚本/管道输入）：支持按行多轮处理与 `/q` 退出。
  - 会话结束时输出单独调用链路文档，且不记录流式分片正文。
  - 对输入接收、事件消费、运行结果进行日志打标。
  - 新增二维图事件转发：可通过 `WEAVE_GRAPH_INGEST_URL/WEAVE_GRAPH_TOKEN` 将 Runtime 事件转发到图服务。
- `src/tui/agent-ui-events.ts`
  - TUI 事件网关：将 Runtime 事件映射为 UI 语义事件（`agent:start`、`agent:thought`、`tool:start`、`tool:end`、`agent:finish`、`agent:error`）。
  - 支持解析 Weave 结构化事件：`weave.dag.node`、`weave.dag.detail`、`weave.dag.event`。
  - 协议层与展示层解耦：默认不将 `weave.dag.event` 的状态迁移事件渲染为 DAG 树节点，避免重复信息；可通过 `WEAVE_TUI_SHOW_PROTOCOL_NODES=1` 打开调试显示。
- `src/tui/use-agent-state.ts`
  - 顶层状态 Hook：监听 UI 事件并维护状态树（状态、思考文本、工具历史、当前工具、对话记录）。
  - 维护 Weave DAG 节点状态（父子关系、状态、时间戳、过程明细）。
  - 工具重试可视化：识别 `retry=x/y` detail，并将节点临时切换为 `retrying` 状态，保存重试计数。
- `src/tui/App.tsx`
  - Ink 组件树入口，渲染消息流与 WEAVE DAG 树；负责交互输入与多轮调用调度。
  - DAG 支持当前节点高亮、节点耗时、明细折叠/展开（空输入下 `↑/↓` 选中，`Enter` 切换）。
  - DAG 状态图标支持重试中计数展示：`↻(x/y)`；最终状态回落 `✔/✖`。
  - Step Gate 模式下支持审批键位交互：`Enter` 放行、`E` 编辑参数、`S` 跳过、`Q` 终止。
  - 输入监听在非 TTY 场景自动失活，避免 raw mode 报错。
- `src/tui/weave-mode.ts`
  - 统一封装 Weave 模式与行内 `/weave` 解析逻辑，供 `App.tsx` 与 `index.ts` 复用。
  - 支持 `off|observe|step|auto`，其中 `on` 作为 `observe` 兼容别名。
- `src/session/session-recorder.ts`
  - 管理会话级 jsonl 记录，按 sessionId 持久化每轮输入输出。
  - 记录 `session_start` / `session_end` / `message` / `error` 事件。
- `src/tools/tool-types.ts`
  - 定义工具抽象类型（工具定义、执行上下文、执行结果）。
- `src/tools/tool-registry.ts`
  - 提供工具注册、解析、执行，以及向模型导出的工具定义能力。
- `src/tools/builtins/command-exec-tool.ts`
  - 内置命令行执行工具 `command_exec`。
- `src/tools/builtins/read-file-tool.ts`
  - 内置文件读取工具 `read_file`（支持按行区间读取）。
- `src/tools/builtins/write-file-tool.ts`
  - 内置文件写入工具 `write_file`（支持覆盖/追加写入，带工作区路径约束）。
- `src/tools/builtins/index.ts`
  - 导出内置工具集合，供入口统一注册。
- `src/agent/plugins/agent-plugin.ts`
  - 定义 Agent-loop 插件接口、钩子上下文与插件输出结构。
  - 支持插件钩子返回单条或多条输出事件。
- `scripts/verify-dag-matrix.mjs`
  - DAG 语义测试矩阵脚本：覆盖环路、死锁、依赖缺失、重试、超时、审批中断恢复、一致性回归。
- `scripts/verify-graph-recovery.ts`
  - 恢复链路验证脚本：覆盖重订阅计划去重、离线队列淘汰、FIFO 刷新与并发上限控制。
- `apps/weave-graph-server/scripts/verify-gateway-reconnect.mjs`
  - 网关重连回放集成脚本：覆盖跨连接 `run.subscribe` 增量回放与 `run.abort` 后回放一致性。
- `scripts/verify-rpc-pending.ts`
  - RPC Pending 状态机验证脚本：覆盖“未发送不超时、发送后超时、取消语义、成功消费”关键语义。
- `scripts/verify-ws-recovery-controller.ts`
  - WS 恢复控制器联动验证脚本：覆盖离线入队、队列淘汰取消、重连刷空与重订阅并发上限。
- `scripts/verify-browser-recovery-e2e.ts`
  - 浏览器级 E2E 验证脚本：覆盖页面启动、WS 强制断开、离线 RPC 入队、自动重连后补发与响应接收。
- `src/weave/weave-dag-prompt.md`
  - Weave 历史提示词文档（当前观察者模式不再依赖运行时注入）。

### 项目文档
- `docs/project/development-progress.md`
  - 持续记录开发进度与待解决问题。
- `docs/project/architecture-and-files.md`
  - 记录当前架构快照与文件职责映射（本文档）。
- `docs/project/weave-dag-runtime-architecture.md`
  - 记录 Weave 的完整能力定义、DAG Runtime 底层架构、三种模式语义与迁移路线。
- `docs/project/weave-2d-graph-blueprint.md`
  - 记录二维图工程蓝图、协议设计与联调步骤。

### 启停脚本
- `scripts/start-weave-graph-all.ps1`
  - 一键启动主 CLI、图后端、图前端，并自动注入图转发环境变量。
- `scripts/stop-weave-graph-all.ps1`
  - 一键停止上述三服务并清理 PID 状态文件。

### 二维图骨架文件
- `apps/weave-graph-server/src/protocol/graph-events.ts`
  - 图协议类型定义（schemaVersion、node/edge/status/io 等事件）。
- `apps/weave-graph-server/src/projection/graph-projector.ts`
  - Runtime 事件到图协议事件的归一化投影器。
- `apps/weave-graph-server/src/gateway/ws-gateway.ts`
  - 本地 WS 网关（127.0.0.1 + token + Origin 校验 + 心跳）。
  - 提供 `POST /ingest/runtime-event` 接口，接收主 CLI 转发的 Runtime 事件。
  - 新增可插拔命令处理器：`registerRunCommandHandlers(startRun/abortRun/replayRunEvents)`，隔离网关与执行器实现。
  - 新增会话互斥与游标回放能力：`run.subscribe(lastEventId)` 增量补发、`AGENT_BUSY` 快速失败、`run.abort` 占用释放。
  - 回放策略已升级为三级：内存 RingBuffer 命中 -> WAL 重建回放降级 -> 游标失效返回 `RESYNC_REQUIRED`。
  - 提供 E2E 测试辅助能力：支持断开全部客户端与观测 RPC `reqId`，用于验证断线重连补发链路。
- `apps/weave-graph-server/src/index.ts`
  - 服务端装配入口：连接 Runtime 事件投影链，并装配 `createRuntimeBridge`（真实 AgentRuntime 优先，失败回退本地桥接）与网关命令处理器。
- `apps/weave-graph-server/src/runtime/run-registry.ts`
  - 运行状态注册表：维护 run 与 session 占用关系，提供 Fast-Fail 并发守卫与状态迁移。
- `apps/weave-graph-server/src/runtime/runtime-bridge.ts`
  - 运行时桥接接口：定义 `startRun/abortRun` 契约，并提供自动桥接工厂 `createRuntimeBridge`。
  - 当前策略：优先动态装配真实 AgentRuntime（含 LLM 配置加载与内置工具注册）；装配失败时自动回退本地桥接，保证网关联调链路不断。
  - 动态装配路径采用 `dist/*.js` 优先与 `src/*.ts` 回退双策略，兼容构建态与开发态启动方式。
  - 新增可选回放能力：`loadRunEvents(runId)`，由 AgentRuntimeBridge 通过 `WeaveDb + WalDao` 读取 WAL 原始事件，供网关订阅降级回放使用。
- `apps/weave-graph-web/src/store/graph-store.ts`
  - Zustand 图状态单一真相源与增量事件应用（含默认 label 可见性策略）。
  - 新增 `eventId` 去重与 `lastEventId` 游标记录，支撑断线重连补发。
  - 新增 `RESYNC_REQUIRED` 自动恢复：游标失效时自动清理 run 本地状态并发起无游标 `run.subscribe` 重订阅。
  - RPC 超时改为“请求真正写入 WS 后计时”，并支持请求级主动取消（队列溢出/组件销毁场景）。
- `apps/weave-graph-web/src/layout/dagre-layout.ts`
  - Dagre 自动布局管线（首阶段全量布局）。
- `apps/weave-graph-web/src/lib/recovery-utils.ts`
  - 恢复链路纯函数工具：run 重订阅计划构建、离线队列上限控制、队列刷空、受控并发执行。
  - 供 `App.tsx` 与验证脚本复用，降低恢复逻辑回归风险。
- `apps/weave-graph-web/src/lib/rpc-pending-manager.ts`
  - RPC Pending 生命周期管理器：统一处理注册、发送后计时、取消、消费语义。
  - 作为 `graph-store` 的请求状态机底座，保证超时语义稳定可测。
- `apps/weave-graph-web/src/lib/ws-recovery-controller.ts`
  - WS 恢复控制器：封装离线队列、重连刷空、run 重订阅恢复与销毁取消。
  - 与 `recovery-utils`、`rpc-pending-manager` 组合形成可测试的恢复链路模块。
- `apps/weave-graph-web/src/workers/layout.worker.ts`
  - 布局 Worker 预留骨架（后续 ELK 增量布局）。
- `apps/weave-graph-web/src/App.tsx`
  - React Flow 主界面骨架与 WS 接入。
  - 新增 Summon -> `start.run` RPC 启动逻辑，成功后才切换到 DAG 主画布。
  - 新增 WebSocket 自动重连与已知 run 批量重订阅（断网/服务重启后自动恢复）。
  - 新增断线期间 RPC 出站队列与重连后自动 flush，降低瞬断时 RPC 丢失概率。
  - 批量重订阅已升级为受控并发执行，提升多 run 场景恢复速度。
  - 出站请求发送后会回调 store 标记 `dispatched`，保证超时基于真实网络发送时刻。

## 对照 PRD 的当前实现状态

### 已完成（初始）
- 已接入 1 个模型提供方（Qwen）。
- 已打通 Agent Runtime 首次调用链路。
- 已支持基于配置文件模板的模型与 API Key 配置。
- 已打通事件驱动的流式输出链路（CLI 场景）。
- 已接入独立文件化记忆系统（系统提示词/风格/长期记忆）。
- 已接入核心调用链路日志系统与文档创建独立日志能力。
- 已支持终端多轮对话会话模式（sessionId + 持续提问 + 指令/双 Ctrl+C 退出）。
- 已支持每次会话 jsonl 记录与会话级链路文档输出。
- 已支持解耦工具系统与 Agent loop（可按需调用工具并继续推理）。
- 已支持 Weave 插件按轮启用（`/weave`），并在 TUI 中实时展示结构化 DAG 树（节点 + 过程明细）。

### 尚未实现
- Orchestrator 队列与 run 生命周期管理。
- 记忆子系统（session + long-term 持久化）。
- 工具调用循环与 hooks 生命周期。
- 统一事件总线治理与跨端事件协议收敛。
- 浏览器侧恢复链路自动化测试（重连 + 队列 flush + 重订阅 + RESYNC 自愈）尚未实现。

## 更新规则
- 每次新增目录/模块或职责变更时，必须同步更新本文件。
