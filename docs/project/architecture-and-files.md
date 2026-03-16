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
  src/
    agent/
      plugins/
    runtime/
    config/
    llm/
    tui/
    tools/
    weave/
    types/
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

10. 运行器层（Runner Layer）
- 提供执行内核抽象（legacy / dag）与选择器。
- 当前默认走 legacy 运行器，保持行为兼容。
- 为后续 DagRunner 渐进替换预留扩展位。

## 文件职责说明

### 根目录文件
- `package.json`
  - 定义脚本（`dev`、`build`、`start`）与依赖。
- `tsconfig.json`
  - 定义 TypeScript 编译目标与严格模式配置。
- `.env.example`
  - 环境变量模板（`QWEN_API_KEY`）。
- `.gitignore`
  - 忽略本地密钥和构建产物。

### 配置文件
- `config/llm.config.template.json`
  - 模型配置模板，供复制后按需修改。
  - 同时支持配置文件直写密钥（`apiKey`）和环境变量读取（`apiKeyEnv`）。
- `config/llm.config.json`
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
  - 在 `weave=off` 时走 legacy；`weave=on/step` 时走 DagRunner。
  - DagRunner 以节点/依赖图驱动执行，保留现有插件钩子与 Step Gate 事件。
  - 在流式调用过程中发布 `run.start`、`llm.request`、`llm.delta`、`llm.completed`、`run.completed`、`run.error` 事件。
  - 新增工具事件：`tool.execution.start`、`tool.execution.end`。
  - 新增 Step Gate 事件：`node.pending_approval`、`node.approval.resolved`。
  - `runOnceStream` 支持 Step 模式审批回调（`approve/edit/skip/abort`）。
  - 新增插件输出事件：`plugin.output`。
  - 在 Agent-loop 预留插件钩子：`beforeLlmRequest`、`afterLlmResponse`、`beforeToolExecution`、`afterToolExecution`。
  - 对事件发布、调用开始/结束/异常进行日志打标。
- `src/agent/message-dispatcher.ts`
  - 输入分发层：统一对用户输入做命令拦截、模式切换与问答消息分类。
  - 将控制命令（如 `/weave on`、`/q`）与问答执行解耦，避免 UI/入口层重复分支逻辑。
- `src/runtime/runner-types.ts`
  - 定义 Runner 抽象契约与运行参数类型（含 Step Gate 审批类型）。
- `src/runtime/runner-legacy.ts`
  - legacy 运行器适配层：将执行请求委托给现有 Agent-loop。
- `src/runtime/runner-dag.ts`
  - Dag 运行器适配层：将执行请求委托给 DAG 执行内核。
- `src/runtime/runner-selector.ts`
  - 运行器选择器：按模式选择执行内核。
  - 当前支持 `legacy` 与 `dag` 双运行器选择。
- `src/runtime/dag-graph.ts`
  - 最小 DAG 图模型：支持节点依赖、就绪判定与环路检测。
- `src/index.ts`
  - CLI 入口，启动 Ink TUI 多轮会话（单次命令常驻）。
  - 显式初始化 `MemoryStore` 并注入 Agent Runtime。
  - 装配 TUI 应用并负责会话收尾（chain log / session 文件路径输出）。
  - 负责会话生命周期管理（sessionId、退出命令、双 Ctrl+C）。
  - 支持会话级 `/weave on|off|step` 模式切换，并兼容 `/weave + 问题` 行内触发。
  - 新增非 TTY 回退执行模式（脚本/管道输入）：支持按行多轮处理与 `/q` 退出。
  - 会话结束时输出单独调用链路文档，且不记录流式分片正文。
  - 对输入接收、事件消费、运行结果进行日志打标。
- `src/tui/agent-ui-events.ts`
  - TUI 事件网关：将 Runtime 事件映射为 UI 语义事件（`agent:start`、`agent:thought`、`tool:start`、`tool:end`、`agent:finish`、`agent:error`）。
  - 支持解析 Weave 结构化事件：`weave.dag.node` 与 `weave.dag.detail`。
- `src/tui/use-agent-state.ts`
  - 顶层状态 Hook：监听 UI 事件并维护状态树（状态、思考文本、工具历史、当前工具、对话记录）。
  - 维护 Weave DAG 节点状态（父子关系、状态、时间戳、过程明细）。
- `src/tui/App.tsx`
  - Ink 组件树入口，渲染消息流与 WEAVE DAG 树；负责交互输入与多轮调用调度。
  - DAG 支持当前节点高亮、节点耗时、明细折叠/展开（空输入下 `↑/↓` 选中，`Enter` 切换）。
  - Step Gate 模式下支持审批键位交互：`Enter` 放行、`E` 编辑参数、`S` 跳过、`Q` 终止。
  - 输入监听在非 TTY 场景自动失活，避免 raw mode 报错。
- `src/tui/weave-mode.ts`
  - 统一封装 Weave 模式与行内 `/weave` 解析逻辑，供 `App.tsx` 与 `index.ts` 复用。
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
- `src/tools/builtins/index.ts`
  - 导出内置工具集合，供入口统一注册。
- `src/agent/plugins/agent-plugin.ts`
  - 定义 Agent-loop 插件接口、钩子上下文与插件输出结构。
  - 支持插件钩子返回单条或多条输出事件。
- `src/weave/weave-plugin.ts`
  - 实现 Weave 观察者插件：监听 Agent 原生动作并输出实时 DAG 事件。
  - 输出双通道事件：`weave.dag.node`（节点状态）与 `weave.dag.detail`（节点过程明细）。
- `src/weave/weave-dag-prompt.md`
  - Weave 历史提示词文档（当前观察者模式不再依赖运行时注入）。

### 项目文档
- `docs/project/development-progress.md`
  - 持续记录开发进度与待解决问题。
- `docs/project/architecture-and-files.md`
  - 记录当前架构快照与文件职责映射（本文档）。
- `docs/project/weave-dag-runtime-architecture.md`
  - 记录 Weave 的完整能力定义、DAG Runtime 底层架构、三种模式语义与迁移路线。

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
- Gateway 层（WebSocket/HTTP）。
- 统一事件总线治理与跨端事件协议收敛。

## 更新规则
- 每次新增目录/模块或职责变更时，必须同步更新本文件。
