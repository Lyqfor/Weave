# Dagent Clean Architecture 蓝图

本项目严格遵循 **Clean Architecture (整洁架构)** 和 **Hexagonal Architecture (六边形架构/端口与适配器)** 原则进行重构，旨在实现极致的逻辑解耦、可测试性和“零副作用（Zero Side-effects）”的纯粹领域引擎。

## 🏗️ 分层结构 (Layers)

目录按依赖稳定性从内到外划分为 5 个核心层级。
**核心依赖铁律：依赖箭头始终单向指向内层** 
`Presentation -> Application -> Domain -> Core <- Infrastructure`

### 1. 🛡️ Core Layer (`src/core/`)
**最稳定的底层核心。** 包含基础引擎逻辑、通用工具以及**基础设施的抽象接口（Ports）**。该层绝对禁止包含任何对 Node.js 原生模块（如 `fs`, `path`）或第三方具体库的引入。
- `engine/`: DAG 调度的最小调度内核 (Graph, StateStore, Executor)。
- `ports/`: **[核心]** 定义基础设施能力契约（`ILogger`, `IBlobStore`），实现依赖倒置 (DIP)。
- `config/`: 环境配置类型。
- `types/`: 跨层共享的纯数据类型定义。
- `utils/`: 无状态纯函数 (Text, ID, Display Width)。

### 2. 🧩 Domain Layer (`src/domain/`)
**业务领域模型。** 包含智能体执行过程中的核心业务实体和契约。
- `nodes/`: 各种业务节点 (LlmNode, ToolNode, FinalNode) 的纯逻辑实现。节点对外部 IO 无感，仅通过上下文中的 Ports (如 `ctx.blobStore`) 交互。
- `event/`: 统一事件总线 (EventBus) 及纯事件契约 (`AgentRunEvent`)。

### 3. ⚙️ Application Layer (`src/application/`)
**应用逻辑编排。** 组合领域模型与核心内核，实现具体的 Agent 运行流程。
- `agent/`: AgentRuntime 核心类，负责驱动 LLM 与工具的闭环。
- `ports/`: **[核心]** 定义第三方服务的契约（如 `ILlmClient`），隔离对 OpenAI/Qwen 的强耦合。
- `session/`: 运行上下文 (RunContext) 的组装。
- `weave/`: Step Gate 拦截器、Pending 注册表等高级交互控制。

### 4. 🔌 Infrastructure Layer (`src/infrastructure/`)
**基础设施与外部系统集成 (Adapters)。** 包含所有 IO 密集型操作、第三方 SDK 调用以及数据库持久化。该层实现内层定义的 Ports。
- `llm/`: 实现了 `ILlmClient` 的具体客户端 (`QwenClient`)。
- `logging/`: 实现了 `ILogger` 的具体日志器 (`AppLogger`，包含 fs 落盘)。
- `storage/`: 实现了 `IBlobStore` 的具体存储，以及 Snapshot 快照落盘。
- `tools/`: 外部工具 (FileSystem, CLI Exec) 的具体能力实现。
- `wal/`: 预写式日志持久化引擎 (SQLite, WeaveWalManager)。
- `memory/`: 基于文件的 Agent 记忆存储系统。

### 5. 🖥️ Presentation Layer (`src/presentation/`)
**表现层与依赖注入装配根 (Composition Root)。**
- `tui/`: 基于 Ink + React 的终端图形界面。
- `index.ts`: CLI 命令行工具入口。**[核心]** 这是整个应用唯一实例化基础设施（`new WeaveDb`, `new AppLogger`）的地方，并将它们作为依赖注入（DI）传递给 `AgentRuntime`。

---

## ⚖️ 架构宪法 (Governance)

1. **依赖倒置 (DIP)：** 核心层 (`Core`, `Domain`, `Application`) 内部绝对禁止使用 `new` 实例化底层基础设施模块。必须通过接口 (Ports) 和依赖注入 (DI) 调用。
2. **禁止 Any 强转：** 核心逻辑必须维持严格的类型系统，杜绝使用 `as any` 逃逸，确保上下文 (Context) 安全传导。
3. **隔离副作用：** 所有文件读写、数据库事务、网络请求必须全部收敛在 `infrastructure` 层。
4. **深度熔断 (Deep Cancellation)：** 通过 `AbortSignal` 贯穿所有层级，直到物理切断 `infrastructure` 层的 Fetch / Exec 请求。
5. **绝对不可变历史 (WEAVE)：** DAG 的执行历史受 WAL 保护，拦截或修改参数必须触发分支 Fork，不可修改内存中已发生的状态。

---

## 🔄 Weave Graph 启动链路（2026-03-22 更新）

本次补充的是“开屏输入后立即进入工作布局”的链路职责，属于既有架构下的流程时序优化，不涉及 UI 风格变更。

- `apps/weave-graph-web/src/App.tsx`
	- 负责开屏提交入口（`handleSummonStart`）。
	- 在 `start.run` 成功后立即切换到工作布局，并触发草稿会话创建。
	- `run.subscribe` 在后台执行，避免订阅阶段阻塞首屏流程。

- `apps/weave-graph-web/src/store/graph-store.ts`
	- 负责图状态真相源（按 `dagId` 分桶）。
	- `createDraftRun` 用于开屏提交后的即时会话承接。
	- 在 `run.start` 到达且 `dagId != runId` 时执行键迁移，保证草稿会话与正式会话收敛到同一 DAG。

- `apps/weave-graph-server/src/gateway/ws-gateway.ts`
	- 负责 WebSocket RPC 命令处理与响应。
	- 业务异常必须按 `reqId` 返回失败回包，保障前端 pending 请求可被释放，避免“仅背景无流程”的悬挂状态。
