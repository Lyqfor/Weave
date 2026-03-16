# Dagent 开发进度追踪

## 文档目的
用于记录每次问题解决后的变更、验证结果、待解决事项与下一步计划。

## 更新规则
- 每解决一个问题，追加一条新的进度记录。
- 每条记录必须包含：范围、改动、验证、待解决问题、下一步。

## 进度记录

### 2026-03-16 - Entry 038 - TUI 事件分层优化：默认隐藏协议迁移节点

#### 范围
解决 Weave DAG 视图中“业务节点 + 协议迁移节点”双层混显导致的信息冗余问题。

#### 改动
- 优化 TUI 事件网关：
  - `src/tui/agent-ui-events.ts`
  - 对 `weave.dag.event` 的 `dag.node.transition` 事件默认不映射为 DAG 树节点。
  - 新增调试开关：`WEAVE_TUI_SHOW_PROTOCOL_NODES=1` 时可恢复协议迁移节点显示。
- 架构文档补充事件分层策略：
  - `docs/project/architecture-and-files.md`

#### 影响文件
- src/tui/agent-ui-events.ts
- docs/project/architecture-and-files.md

#### 验证
- 构建通过：`corepack pnpm build`。
- P0 回归通过：`corepack pnpm verify:p0`。

#### 待解决问题
- 目前协议迁移事件仅用于调试显示开关，尚未形成独立“诊断面板”视图。

#### 下一步
- 增加可切换的调试面板，将协议事件与业务节点彻底分区展示。

### 2026-03-16 - Entry 037 - 底层重构第 4 步：协议与状态总线 + DAG 语义测试矩阵

#### 范围
完成 DAG 事件契约与版本化策略，接入最小 StateStore 与数据边，并为节点状态迁移增加有限状态机约束；补齐 P0 语义测试矩阵。

#### 改动
- 新增 DAG 事件契约模块：
  - `src/runtime/dag-event-contract.ts`
  - 定义 `weave.dag.event.v1` 版本化信封（`schemaVersion/eventId/eventType`）
- 新增最小状态总线：
  - `src/runtime/state-store.ts`
  - 统一管理运行上下文、节点输出、数据边输入解析
- 升级 DAG 图模型：
  - `src/runtime/dag-graph.ts`
  - 增加数据边、图完整性校验、节点状态机合法迁移约束
- 升级 DagRunner 执行链路：
  - `src/agent/run-agent.ts`
  - 接入 StateStore 与数据边映射
  - 增加工具执行重试与超时控制（支持环境变量覆盖）
  - 增加 `weave.dag.event` 协议事件输出
  - 对所有 Runtime 事件补充统一 `schemaVersion/eventId`
- TUI 网关兼容版本化 DAG 协议：
  - `src/tui/agent-ui-events.ts` 支持解析 `weave.dag.event`
- 新增 DAG 语义测试矩阵脚本：
  - `scripts/verify-dag-matrix.mjs`
  - 覆盖环路、死锁、依赖缺失、重试、超时、审批中断恢复、off/on/step 一致性
- 更新脚本入口：
  - `package.json` 新增 `verify:step-gate`、`verify:dag-matrix`、`verify:p0`

#### 影响文件
- src/runtime/dag-event-contract.ts
- src/runtime/state-store.ts
- src/runtime/dag-graph.ts
- src/agent/run-agent.ts
- src/tui/agent-ui-events.ts
- scripts/verify-dag-matrix.mjs
- package.json

#### 验证
- 构建通过：`corepack pnpm build`。
- Step Gate 回归通过：`node scripts/verify-step-gate.mjs`。
- DAG 语义矩阵通过：`node scripts/verify-dag-matrix.mjs`。

#### 待解决问题
- 目前状态总线为最小实现，尚未引入持久化快照与跨回合状态回放。
- 目前并行/join/条件分支仍未实现，DAG 仍以串行 ready 节点优先策略执行。

#### 下一步
进入下一轮增强：
- 增加条件节点与 join 节点语义；
- 引入并行调度与冲突合并策略；
- 增加 DAG 事件协议 schema 演进测试（向后兼容断言）。

### 2026-03-16 - Entry 036 - 底层重构第 3 步：DagRunner 最小骨架接入

#### 范围
实现最小 DagRunner 执行链路（llm/tool/final 节点），并在 weave 模式下灰度启用，off 模式继续走 legacy。

#### 改动
- 新增最小 DAG 图模型：
  - `src/runtime/dag-graph.ts`（节点、依赖边、ready 判定、环路检测）
- 新增 DagRunner 适配层：
  - `src/runtime/runner-dag.ts`
- 运行器选择器升级：
  - `src/runtime/runner-selector.ts` 支持 `legacy/dag` 双运行器
- AgentRuntime 接入双运行器并按请求动态路由：
  - `weave=off` -> legacy
  - `weave=on/step` -> dag
- 在 `run-agent.ts` 新增 `runOnceStreamDag` 与 `runAgentDagLoop`：
  - 以 DAG 节点/依赖驱动执行顺序
  - 预留并复用现有插件钩子与 Step Gate 审批事件
  - 保持工具执行层接口不变

#### 影响文件
- src/runtime/dag-graph.ts
- src/runtime/runner-dag.ts
- src/runtime/runner-selector.ts
- src/agent/run-agent.ts
- docs/project/architecture-and-files.md

#### 验证
- 构建通过：`corepack pnpm build`。
- 回归通过：`node scripts/verify-step-gate.mjs`。

#### 待解决问题
- 当前 DagRunner 仍为最小线性图执行，不含条件/并行/join 节点。

#### 下一步
进入重构第 4 步：抽离 DAG 事件协议与节点数据结构类型，增加数据边与状态总线（StateStore）最小实现。

### 2026-03-16 - Entry 035 - 底层重构第 2 步：Runner 双轨抽象（先兼容）

#### 范围
在保持现有行为不变前提下，完成执行内核抽象层（Runner Layer），为 DagRunner 渐进替换做准备。

#### 改动
- 新增运行器类型与选择器：
  - `src/runtime/runner-types.ts`
  - `src/runtime/runner-legacy.ts`
  - `src/runtime/runner-selector.ts`
- `AgentRuntime` 接入 Runner 抽象：
  - 对外 `runOnceStream` 改为统一调用 `runner.run(...)`
  - 新增 `runOnceStreamLegacy(...)` 承载原有执行逻辑
  - 默认 `runnerMode=legacy`，确保 off/on/step 当前行为一致
- 架构文档补充 Runner Layer 分层与文件职责。

#### 影响文件
- src/runtime/runner-types.ts
- src/runtime/runner-legacy.ts
- src/runtime/runner-selector.ts
- src/agent/run-agent.ts
- docs/project/architecture-and-files.md

#### 验证
- 构建验证：`corepack pnpm build`。
- 回归验证：`node scripts/verify-step-gate.mjs`。

#### 待解决问题
- 目前 `dag` 模式仍回落到 `legacy`，尚未实现独立 DagRunner 调度。

#### 下一步
进入重构第 3 步：实现 DagRunner 最小骨架（llm/tool/final 节点），并在 on/step 模式下灰度接入。

### 2026-03-16 - Entry 034 - 底层重构第 1 步：输入分发层解耦

#### 范围
在不改网关层与不改变现有 TUI 协议的前提下，先完成“消息分发层”解耦，统一命令拦截与问答路由。

#### 改动
- 新增输入分发模块 `src/agent/message-dispatcher.ts`：
  - 统一处理 `/q|/quit|/exit` 退出命令
  - 统一处理 `/weave on|off|step` 模式切换命令
  - 统一输出问答消息分发结果（question + weave 选项）
- TUI 会话链路改造：`App.tsx` 从“直接 parse + 分支”改为“先 dispatch 再执行”。
- 非 TTY 批处理链路改造：`index.ts` 复用同一分发器，避免两条链路语义漂移。
- 架构文档补充 `message-dispatcher` 文件职责说明。

#### 影响文件
- src/agent/message-dispatcher.ts
- src/tui/App.tsx
- src/index.ts
- docs/project/architecture-and-files.md

#### 验证
- 构建通过：`corepack pnpm build`。
- 行为回归通过：`node scripts/verify-step-gate.mjs`。

#### 待解决问题
- 当前仍使用 Legacy loop 执行，尚未进入 DagRunner 调度器替换阶段。

#### 下一步
进入重构第 2 步：抽象 runner 接口（legacy/dag 双 runner），先保持默认走 legacy，确保 off 模式零行为变化。

### 2026-03-16 - Entry 033 - Weave 架构补充：数据流与运行时安全治理

#### 范围
根据架构评审结论，对 Weave DAG Runtime 文档补充数据流模型与运行时安全治理章节。

#### 改动
- 在 Weave 架构文档新增 4 个关键补充章节：
  - 数据流模型（StateStore/ContextBus、输入输出声明、边映射）
  - 图安全校验（构建期环路检测 + 运行期死锁检测）
  - 执行器错误域（错误分层、重试与降级策略）
  - 事件协议治理（schemaVersion、eventId、幂等与回放约束）

#### 影响文件
- docs/project/weave-dag-runtime-architecture.md

#### 验证
- 文档检查通过：新增章节与原有模式/迁移路线语义一致。
- 架构一致性检查通过：补充内容可直接映射到后续 runtime 实现。

#### 待解决问题
- 尚未将上述设计转化为具体 `src/runtime/*` 接口定义与代码实现。

#### 下一步
落地最小数据流协议与事件协议类型定义，并在 DagRunner 原型中实现构建期环路检测。

### 2026-03-16 - Entry 032 - Weave DAG Runtime 技术架构文档沉淀

#### 范围
将近期关于 Weave 的产品定位、三种模式、DAG 运行时重构思路与中长期演进策略沉淀为可执行技术文档。

#### 改动
- 新增 Weave 专项架构文档，覆盖：
  - `weave=off/on/step` 模式语义与运行机制
  - DAG 节点/边模型、状态机与 Step Gate Promise 拦截机制
  - Agent-loop 到 DAG Runtime 的分阶段迁移路线
  - 与工具执行链路的兼容性与一致性保障策略
  - 规划-执行架构 Agent 的适配策略
  - 中间件化与独立 Agent 化的阶段性判断标准
- 在架构总览文档中登记该专项文档。

#### 影响文件
- docs/project/weave-dag-runtime-architecture.md
- docs/project/architecture-and-files.md

#### 验证
- 文档结构检查通过：章节覆盖功能定义、底层架构、迁移与风险。
- 交叉引用检查通过：架构总览文档已包含新文档登记。

#### 待解决问题
- 目前为架构设计阶段，尚未落地 `src/runtime/*` 目录和 DagRunner 最小实现。

#### 下一步
进入实现阶段，先完成事件协议标准化，再抽象 runner 接口并落地最小 DagRunner。

### 2026-03-15 - Entry 001 - Agent 调用 LLM 最小闭环（Qwen）

#### 范围
完成首个端到端的 Agent -> LLM 单轮调用，支持模型与 API Key 配置。

#### 改动
- 初始化 Dagent TypeScript 运行工程。
- 增加 Qwen 兼容的配置模板与运行配置文件。
- 增加基于 Zod 的配置加载与校验，支持环境变量回退。
- 增加 Qwen 客户端封装（OpenAI 兼容方式）。
- 增加 Agent 运行时 `runOnce` 与 CLI 入口。

#### 新增文件
- package.json
- tsconfig.json
- .gitignore
- .env.example
- config/llm.config.template.json
- config/llm.config.json
- src/types/config.ts
- src/config/load-llm-config.ts
- src/llm/qwen-client.ts
- src/agent/run-agent.ts
- src/index.ts

#### 验证
- 依赖安装完成：`pnpm install`。
- TypeScript 构建通过：`pnpm build`。
- 运行冒烟测试：
  - 首次因未配置 API Key 失败（符合预期）。
  - 终端上下文显示后续 `pnpm dev -- "hi"` 退出码为 0。

#### 待解决问题
- 需要补齐结构化工具调用循环（当前仅单轮文本生成）。
- 需要将会话记忆（jsonl）接入运行时流程。
- 需要接入 Gateway 层（HTTP/WebSocket），替代纯 CLI 入口。

#### 下一步
实现最小 Tool Registry，并让 Runtime 支持一轮工具调用流程。

### 2026-03-15 - Entry 002 - 文档与注释中文化规范落地

#### 范围
落实“所有文档与代码注释使用中文”的开发规范，并同步更新现有内容。

#### 改动
- 将项目跟踪文档与架构文档由英文改为中文。
- 为现有源码文件补充中文文件头注释。
- 为核心函数补充中文逻辑注释。
- 将该规范写入长期工作记忆，后续自动遵循。

#### 影响文件
- docs/project/development-progress.md
- docs/project/architecture-and-files.md
- src/types/config.ts
- src/config/load-llm-config.ts
- src/llm/qwen-client.ts
- src/agent/run-agent.ts
- src/index.ts

#### 验证
- 文档检查：两份项目文档内容已全部中文化。
- 代码检查：核心文件均包含中文文件头与关键逻辑注释。

#### 待解决问题
- 新增文件模板尚未自动化，当前仍依赖人工遵守注释规范。

#### 下一步
在后续新增文件时默认应用“中文文件头 + 核心函数中文注释”模板。

### 2026-03-15 - Entry 003 - 事件驱动流式输出实现（Qwen）

#### 范围
实现用户输入后的大模型流式输出，并采用事件驱动方式编排运行过程。

#### 改动
- 在 LLM 客户端增加 `chatStream`，支持逐段消费模型输出。
- 在 Agent Runtime 增加 `runOnceStream`，发布标准生命周期事件。
- 在 CLI 入口订阅事件并实时打印 `llm.delta`，实现终端流式体验。

#### 影响文件
- src/llm/qwen-client.ts
- src/agent/run-agent.ts
- src/index.ts

#### 验证
- 构建校验通过：`pnpm build`。
- 运行时可按事件输出增量文本（依赖有效 API Key）。

#### 待解决问题
- 事件尚未落盘，暂不支持 run 回放。
- 尚未接入 WebSocket Gateway 向前端转发同一事件流。

#### 下一步
将 `event` 事件接入 Gateway，并以统一协议推送给前端。

### 2026-03-15 - Entry 004 - 独立记忆系统接入（系统提示词/风格/长期记忆）

#### 范围
将 Prompt 配置从单一配置项扩展为独立文件化记忆系统，并接入 Agent 调用链。

#### 改动
- 新增 `memories/` 目录，拆分存储系统提示词、Agent 风格、用户风格、长期记忆。
- 新增 `MemoryStore`，支持模板文件自动补齐、快照读取和系统提示词组装。
- 在 `AgentRuntime` 中接入 `MemoryStore`，每次调用前自动注入组合后的系统提示词。
- 在入口层显式创建并传入 `MemoryStore`。

#### 影响文件
- memories/SYSTEM_PROMPT.md
- memories/SOUL.md
- memories/USER.md
- memories/MEMORY.md
- src/memory/memory-store.ts
- src/agent/run-agent.ts
- src/index.ts

#### 验证
- 构建校验通过：`pnpm build`。
- 运行验证通过：`pnpm dev -- "介绍一下你自己"`。

#### 待解决问题
- 目前为读取型长期记忆，尚未实现自动摘要写回 `MEMORY.md`。

#### 下一步
增加长期记忆写回策略（例如每 N 轮自动摘要沉淀）。

### 2026-03-15 - Entry 005 - 核心代码块注释增强与链路日志系统

#### 范围
在核心调用链路上补充代码块级中文注释，并接入统一日志打标系统；实现“每次文档创建生成独立日志文件”。

#### 改动
- 新增统一日志模块，支持按模块与标签输出日志，并落盘到 `logs/runtime/`。
- 在配置加载、记忆系统、LLM 客户端、Agent Runtime、CLI 入口接入日志打标。
- 在记忆文档创建流程中，新增“单文档独立调用链路日志”输出到 `logs/docs/`。
- 对核心代码链路增加更细粒度中文注释（不仅是函数级）。

#### 影响文件
- src/logging/app-logger.ts
- src/config/load-llm-config.ts
- src/memory/memory-store.ts
- src/llm/qwen-client.ts
- src/agent/run-agent.ts
- src/index.ts
- .gitignore

#### 验证
- 构建校验通过：`pnpm build`。
- 运行验证通过：`pnpm dev -- "请总结一下当前调用链路"`。
- 日志输出验证：
  - 核心链路日志：`logs/runtime/*.log`
  - 文档创建独立链路日志：`logs/docs/doc-create-*.log`（在文档首次创建时生成）

#### 待解决问题
- 目前 `llm.delta` 日志粒度较细，长回复场景日志量较大，后续可增加采样/节流。

#### 下一步
将运行日志与 runId 对齐为单 run 文件，增强问题定位效率。

### 2026-03-15 - Entry 006 - 用户风格文件命名修复与文档日志验证

#### 范围
修复用户风格记忆文件命名不一致问题，并验证“文档创建生成独立日志”机制可用。

#### 改动
- 将记忆系统主文件名统一为 `USER_STYLE.md`。
- 增加兼容读取：当 `USER_STYLE.md` 不存在时回退读取 `USER.md`。
- 运行时触发 `USER_STYLE.md` 创建并自动生成独立文档链路日志。

#### 影响文件
- src/memory/memory-store.ts
- memories/USER_STYLE.md
- logs/docs/doc-create-1773586604558-USER_STYLE.md.log

#### 验证
- 构建校验通过：`pnpm build`。
- 运行验证通过：`pnpm dev -- "请说明用户风格来源"`。
- 文档创建独立日志验证通过：`logs/docs/` 下已生成对应链路日志文件。

#### 待解决问题
- 历史遗留 `USER.md` 暂未自动迁移，当前采用兼容读取策略。

#### 下一步
增加一次性迁移脚本，将历史 `USER.md` 规范迁移至 `USER_STYLE.md`。

### 2026-03-15 - Entry 007 - 日志静默化与按对话链路文档落盘

#### 范围
优化日志策略：日志不再输出到终端；每次对话生成独立链路文档；流式输出不做分片日志记录。

#### 改动
- 日志模块默认关闭终端输出，仅写入文件。
- 日志策略从“文档创建日志”改为“每次对话（run）链路日志文档”。
- 对话链路日志记录关键阶段：开始、模型请求前、输出开始、结束/失败。
- 明确不记录流式分片正文（不逐 delta 落日志）。
- 记忆策略调整：不再使用 `SYSTEM_PROMPT.md`，改由 `SOUL.md` 承载系统行为；用户风格统一读取 `USER.md`。

#### 影响文件
- src/logging/app-logger.ts
- src/agent/run-agent.ts
- src/memory/memory-store.ts
- docs/project/architecture-and-files.md

#### 验证
- 构建校验通过：`pnpm build`。
- 运行验证通过：`pnpm dev -- "请用一句话介绍当前链路"`。
- 对话链路文档验证通过：`logs/conversations/` 下生成 `conversation-*.md`。

#### 待解决问题
- 历史文件 `SYSTEM_PROMPT.md`、`USER_STYLE.md` 仍可能存在于本地，需要清理或迁移。

#### 下一步
执行一次性清理迁移，移除旧文件并保留 `SOUL.md`、`USER.md` 作为唯一配置来源。

### 2026-03-15 - Entry 008 - 终端多轮会话与 session 记录落地

#### 范围
实现单次命令启动后的常驻多轮对话，支持 sessionId、退出命令/双 Ctrl+C 退出，并记录会话 jsonl。

#### 改动
- 重构 CLI 入口为终端常驻会话模式，启动时生成唯一 `sessionId`。
- 支持连续提问，多轮上下文在同一会话内持续生效。
- 支持退出指令：`/quit`、`/q`、`/exit`。
- 支持连续两次 Ctrl+C 退出当前会话。
- 新增 `SessionRecorder`，按会话输出 `sessions/session-{sessionId}.jsonl`。
- 会话结束后生成一份会话级调用链路文档到 `logs/conversations/`。
- 调整 Agent Runtime 与 QwenClient：支持历史消息注入实现真正多轮上下文。

#### 影响文件
- src/index.ts
- src/agent/run-agent.ts
- src/llm/qwen-client.ts
- src/session/session-recorder.ts
- src/logging/app-logger.ts
- .gitignore

#### 验证
- 构建校验通过：`pnpm build`。
- 运行验证通过：`pnpm dev`（进入常驻会话），可连续提问并正常退出。
- 记录验证通过：
  - 会话消息记录：`sessions/session-*.jsonl`
  - 会话链路文档：`logs/conversations/conversation-*.md`

#### 待解决问题
- 当前会话历史仅驻留内存，尚未实现进程重启后的会话恢复。

#### 下一步
接入会话恢复能力：启动时可选加载历史 `session-*.jsonl` 继续对话。

### 2026-03-15 - Entry 009 - 工具系统与 Agent-loop 解耦实现

#### 范围
实现可扩展工具系统，并在 Agent Runtime 中引入 loop 机制：当模型需要工具时先执行工具，再基于工具结果继续推理。

#### 改动
- 新增工具抽象层：工具类型定义、注册中心、模型工具导出。
- 新增两个内置工具：
  - `command_exec`：命令行执行工具。
  - `read_file`：文件读取工具（支持行区间）。
- 扩展 Qwen 客户端：新增 `chatWithTools` 支持工具调用响应。
- 改造 AgentRuntime：引入 Agent loop，支持多步“模型决策 -> 工具执行 -> 结果回填 -> 继续推理”。
- 新增工具执行事件：`tool.execution.start` / `tool.execution.end`。
- 入口层接入工具注册中心并注册内置工具。

#### 影响文件
- src/tools/tool-types.ts
- src/tools/tool-registry.ts
- src/tools/builtins/command-exec-tool.ts
- src/tools/builtins/read-file-tool.ts
- src/tools/builtins/index.ts
- src/llm/qwen-client.ts
- src/agent/run-agent.ts
- src/index.ts

#### 验证
- 构建校验通过：`pnpm build`。
- 运行验证通过：`pnpm dev -- "请调用read_file工具读取src/index.ts第1到8行并简要说明"`。
- 已观察到工具执行链路输出：`[工具执行中] read_file` -> `[工具执行完成] read_file`。

#### 待解决问题
- `command_exec` 当前为通用命令执行，后续需按安全策略补充白名单/黑名单。

#### 下一步
增加工具安全策略层（参数校验、命令白名单、超时分级配置）。

### 2026-03-15 - Entry 010 - 流式输出恢复与工具阶段流式提示优化

#### 范围
修复 Agent-loop 改造后“最终答案非流式”的体验回退问题，并让工具执行过程具备流式可见反馈。

#### 改动
- 在 `AgentRuntime` 中新增统一分片发射器 `emitTextAsStream`，恢复可见流式输出。
- 将最终答案输出改为分片 `llm.delta` 连续发射，不再一次性整段输出。
- 工具执行前后通过同一发射器输出进度提示（如“工具执行中/完成”），实现工具阶段流式反馈。
- 在 CLI 层移除工具事件的重复终端输出，避免与 `llm.delta` 流式文本冲突。

#### 影响文件
- src/agent/run-agent.ts
- src/index.ts

#### 验证
- 构建校验通过：`pnpm build`。
- 非工具流式验证通过：`pnpm dev -- "请用三句话介绍你自己"`。
- 工具阶段流式验证通过：`pnpm dev -- "请调用read_file工具读取src/index.ts第1到6行并说明"`。

#### 待解决问题
- 当前工具模式下的“模型原生 token 流”仍未启用，现阶段为运行时分片流式发射。

#### 下一步
评估接入模型原生 stream + tool_call 增量解析方案，进一步提升真实流式一致性。

### 2026-03-15 - Entry 011 - Weave 钩子插件与 DAG 渲染实现

#### 范围
解决“工具执行后短暂卡顿感”并在 Agent-loop 中加入 Weave 插件钩子，支持 `/weave + 问题` 按轮启用。

#### 改动
- 在 Agent-loop 中新增插件钩子体系，预留关键扩展点：
  - LLM 输入前：`beforeLlmRequest`（可改写提示词）
  - LLM 输出后：`afterLlmResponse`
  - 工具执行前后：`beforeToolExecution` / `afterToolExecution`
  - 运行结束/失败：`onRunCompleted` / `onRunError`
- 新增 Weave 插件最小实现：
  - 注入 Weave 提示词
  - 采集 DAG 节点（含工具调用节点）
  - 渲染 Mermaid 图并通过插件事件输出
- 入口层支持 `/weave + 问题` 开关；不使用 `/weave` 时保持原有流程。
- 在工具执行后增加“正在根据工具结果继续推理”流式状态提示，降低等待阶段的感知卡顿。

#### 影响文件
- src/agent/plugins/agent-plugin.ts
- src/weave/weave-plugin.ts
- src/agent/run-agent.ts
- src/index.ts

#### 验证
- 构建校验通过：`pnpm build`。
- Weave 运行验证通过：
  - `pnpm dev -- "/weave 请调用read_file工具读取src/index.ts第1到5行并按DAG结构总结"`
  - 已输出工具节点 + Mermaid DAG 渲染结果。

#### 待解决问题
- 当前工具模式下仍使用“工具决策非流式 + 最终文本分片流式”的混合模式。

#### 下一步
尝试接入模型原生增量 tool_call 解析，进一步减小工具后首 token 等待时间。

### 2026-03-15 - Entry 012 - Weave DAG 提示词文档化与动态注入

#### 范围
在 Weave 插件目录下创建独立 DAG 提示词文档，并改造插件为“从文档读取后拼接注入 LLM system prompt”。

#### 改动
- 新增 `src/weave/weave-dag-prompt.md`，沉淀 WEAVE Master Architect 提示词规范。
- 改造 `WeavePlugin.beforeLlmRequest` 为异步读取模式，优先读取提示词文档再拼接注入。
- 增加提示词读取缓存与候选路径回退（`src` / `dist`），提升运行稳定性。
- 文件缺失时提供最小 fallback 提示，避免 Weave 模式硬失败。

#### 影响文件
- src/weave/weave-dag-prompt.md
- src/weave/weave-plugin.ts
- docs/project/architecture-and-files.md

#### 验证
- 构建校验通过：`pnpm build`。

#### 待解决问题
- 当前提示词为静态文档，后续可支持按任务类型切换多套模板。

#### 下一步
增加 Weave 提示词模板选择机制（例如 architecture / migration / debug 三种角色模板）。

### 2026-03-15 - Entry 013 - 基于 Ink 的动态 TUI 重构（事件驱动）

#### 范围
将原有 console.log 刷屏式输出重构为 Ink 动态 TUI，保持记忆系统与底层工具执行逻辑不变，仅做 UI 层劫持。

#### 改动
- 安装 `ink`、`react`、`ink-spinner`，并补齐 `@types/react`。
- 更新 TypeScript 配置，启用 `jsx: react`。
- 在 Runtime 事件载荷中补充工具参数摘要、结果摘要与状态字段，便于 UI 精细展示。
- 新增 TUI 事件网关，将 Runtime 事件映射为：
  - `agent:start`
  - `agent:thought`
  - `tool:start`
  - `tool:end`
  - `agent:finish`
  - `agent:error`
- 新增 `useAgentState` Hook 监听事件并维护状态树：
  - `status(idle/thinking/using_tool/done/error)`
  - `thoughtText`
  - `toolHistory`
  - `currentTool`
  - `chatLogs`
- 新增 `App.tsx` 构建 Ink 组件树：
  - 顶部状态与思考区
  - 中部动态工具区（Spinner -> 成功/失败状态）
  - 底部固定高度日志/对话区
- 重构 `src/index.ts` 入口为 Ink 渲染模式，保留 `SessionRecorder` 和会话链路文档收尾逻辑。

#### 影响文件
- package.json
- tsconfig.json
- src/agent/run-agent.ts
- src/index.ts
- src/tui/agent-ui-events.ts
- src/tui/use-agent-state.ts
- src/tui/App.tsx
- docs/project/architecture-and-files.md

#### 验证
- 构建校验通过：`pnpm build`。
- 启动冒烟通过：`pnpm dev -- "介绍一下你自己"`（已显示 Ink TUI 动态界面与对话区）。

#### 待解决问题
- 当前输入组件为轻量手写输入框，后续可评估接入 `ink-text-input` 获得更强编辑能力。

#### 下一步
补充 TUI 单元测试（事件到状态映射）与工具区历史滚动优化。

### 2026-03-16 - Entry 014 - TUI 对话风格优化与输入抖动抑制

#### 范围
优化 Ink TUI 视觉样式为“对话窗口”形式，并减少每次输入/流式更新导致的界面抖动。

#### 改动
- 将主界面调整为 OpenClaw 风格对话布局：状态区、工具轨迹区、对话窗口区、输入区。
- 对状态文本、工具参数、工具结果、聊天消息增加单行摘要截断，避免长文本撑高布局。
- 对三个核心面板设置固定高度并补齐空行，降低输入过程中的重排与跳动。
- 对话记录改为气泡化文本（你 / Dagent / 系统）以提升可读性。

#### 影响文件
- src/tui/App.tsx

#### 验证
- 构建校验通过：`pnpm build`。
- 运行冒烟通过：`pnpm dev -- "你好"`（界面已按对话风格渲染，布局稳定）。

#### 待解决问题
- 终端尺寸特别窄时，仍可能出现轻微换行；后续可按 stdout 宽度做自适应截断。

#### 下一步
按终端宽度动态计算每个区域的最大字符数，进一步消除极端窄屏抖动。

### 2026-03-16 - Entry 015 - TUI 淡紫主色主题落地

#### 范围
按用户要求将 TUI 主色调切换为低饱和淡紫风格，并统一状态色、边框色与文本层级色。

#### 改动
- 在 `App.tsx` 中新增统一主题常量（淡紫主色、边框、弱文本、成功/失败色）。
- 将头部、状态区、工具区、对话区、输入区配色全部切换到同一紫色体系。
- 保留已有防抖动策略（固定高度 + 文本摘要截断），确保换色不引入新抖动。

#### 影响文件
- src/tui/App.tsx

#### 验证
- 构建校验通过：`pnpm build`。
- Ink 交互式冒烟在当前终端采集环境未返回可视输出（交互 UI 输出受限），但编译链路正常。

#### 待解决问题
- 不同终端主题对紫色对比度感知不同，后续可增加“主题级别”开关（soft/medium/high）。

#### 下一步
增加主题配置项，让用户可在启动参数中切换紫色深浅和对比度。

### 2026-03-16 - Entry 016 - 单消息流布局与角色分色优化

#### 范围
响应“不要多个框”的反馈，将 TUI 从多面板框布局改为单消息流布局，并使用颜色区分用户与 Agent 回复。

#### 改动
- 移除状态区/工具区/对话区的大块框布局，改为单一消息流展示。
- 对话行改为纯文本前缀格式：`你:`、`Dagent:`、`系统:`，不再使用气泡框线。
- 工具调用状态与工具历史并入消息流和底部状态行，减少视觉切割。
- 维持固定消息行数（填充空行）以减少输入与流式更新时的界面抖动。

#### 影响文件
- src/tui/App.tsx

#### 验证
- 构建校验通过：`pnpm build`。

#### 待解决问题
- 极窄终端下分隔线长度仍为常量，后续可按终端宽度动态计算。

#### 下一步
基于终端宽度自适应计算摘要长度与分隔线长度，进一步提升窄屏体验。

### 2026-03-16 - Entry 017 - 输入框贴近历史与抖动治理

#### 范围
修复“输入框与历史消息距离过远”问题，并进一步降低输入时抖动。

#### 改动
- 取消历史区固定高度填充空行逻辑，历史消息改为紧贴输入框上方显示。
- 历史区显示改为固定最大行数（仅截取最近 N 行），新增消息以“向上顶”方式更新可视区。
- 移除工具状态行中的 Spinner 动画，改为静态 `...`，减少高频重绘导致的视觉抖动。

#### 影响文件
- src/tui/App.tsx

#### 验证
- 构建校验通过：`pnpm build`。

#### 待解决问题
- 仍可继续按终端宽度动态计算分隔线长度，避免超窄屏时的截断感。

#### 下一步
增加终端宽度感知，动态调整分隔线与消息摘要长度。

### 2026-03-16 - Entry 018 - 工具消息并流与输入光标修正

#### 范围
处理“工具调用输出很怪异、工具消息应作为对话项上顶、输入光标位置不对”的问题。

#### 改动
- 在 `useAgentState` 中将 `tool:start` / `tool:end` 写入 `chatLogs`，工具调用与用户/助手消息统一进入历史流。
- 在 `App.tsx` 中移除额外工具历史拼接，历史消息直接贴近输入框上方显示。
- 输入框文本末尾增加可见光标字符 `█`，使光标视觉上位于输入框内部。
- 将 `command_exec` 在 Windows 下执行前切换 code page：`chcp 65001>nul & <command>`，降低 `dir` 中文输出乱码概率。

#### 影响文件
- src/tui/use-agent-state.ts
- src/tui/App.tsx
- src/tools/builtins/command-exec-tool.ts

#### 验证
- 构建校验通过：`pnpm build`。

#### 待解决问题
- Windows 控制台在特定环境仍可能出现历史输出乱码（与宿主终端字体/code page/历史缓存有关），后续可增加输出编码兜底策略。

#### 下一步
为 `command_exec` 增加 Windows 输出编码兜底解码（UTF-8/GBK 自动探测），进一步提升中文命令输出稳定性。

### 2026-03-16 - Entry 019 - Windows 命令输出乱码修复验证

#### 范围
完成 `command_exec` 在 Windows 下中文输出乱码的兜底修复，并做端到端验证。

#### 改动
- `command_exec` 改为 `encoding: buffer` 读取原始字节。
- 在 Windows 平台增加 UTF-8/GBK 自动解码兜底。
- 保留 `chcp 65001>nul` 预处理，优先提升命令输出一致性。

#### 影响文件
- src/tools/builtins/command-exec-tool.ts

#### 验证
- 构建校验通过：`pnpm build`。
- 运行验证通过：`pnpm dev -- "请调用command_exec工具执行dir并只返回首行"`。
- 观察结果：`dir` 输出已从乱码恢复为中文可读文本（如“驱动器 D 中的卷是 DATA1”）。

#### 待解决问题
- 极少数系统缺失 `TextDecoder("gbk")` 支持时会回退 UTF-8。

#### 下一步
若需进一步增强兼容性，可引入 iconv-lite 作为 GBK 解码兜底实现。

### 2026-03-16 - Entry 020 - 终端宽度自适应排版收尾

#### 范围
完成轻前缀消息流的终端宽度自适应，解决固定常量截断在窄屏场景下的观感与稳定性问题。

#### 改动
- 在 `App.tsx` 中新增宽度约束计算（`clamp`），基于 `process.stdout.columns` 动态推导：
  - 分隔线长度
  - 历史消息摘要长度
  - 输入框摘要长度
- 将原固定值（`94`、`92`、`86`）替换为动态长度，保持 `› / ‹ / ·` 轻前缀风格不变。
- 修正一次 Ink API 兼容性问题：移除不存在的 `useStdoutDimensions`，改用 Node stdout 列宽。

#### 影响文件
- src/tui/App.tsx

#### 验证
- 构建校验通过：`pnpm build`。

#### 待解决问题
- 当前宽度读取为渲染时取值，若终端运行中频繁改宽，后续可再加 resize 监听增强实时性。

#### 下一步
如有需要，可继续做“窗口尺寸变化实时重算 + 行内更细粒度截断策略（按中英文宽度）”。

### 2026-03-16 - Entry 021 - 输出完整显示与轮次分隔优化

#### 范围
修复“Agent 输出被截断”和“run:start/done 噪音标记”问题，并继续降低输入时视觉抖动。

#### 改动
- 在 `use-agent-state.ts` 中移除 `run:xxx start/done` 路径日志。
- 在每轮对话开始时插入系统分隔标记（`__turn_divider__`），用于渲染轮次间隔线。
- 在 `App.tsx` 中调整消息渲染策略：
  - 用户/助手消息按原文展示（支持多行），不再做摘要截断。
  - 系统消息继续保留轻量摘要，避免工具超长输出导致界面噪音。
  - 分隔标记渲染为整行横线，只用于轮次边界。
- 输入框预览改为“尾部保留裁剪”策略（`fitInputPreview`），减少输入过程中因文本变化产生的抖动感。
- 提升历史可见行上限，减少长回答被过早裁切的体感。

#### 影响文件
- src/tui/use-agent-state.ts
- src/tui/App.tsx

#### 验证
- 构建校验通过：`pnpm build`。
- 交互冒烟验证通过：`pnpm dev -- "请输出三段较长文本，并调用一次command_exec执行dir"`。
- 观察结果：
  - 用户/助手长文本不再出现 `...` 截断。
  - `run:start/done` 标记已移除。
  - 不同轮次间有清晰分隔线。

#### 待解决问题
- 工具结果仍为系统摘要展示（有意保留），若需要可增加“展开查看完整工具输出”模式。

#### 下一步
可选实现“系统工具输出可折叠/可展开”与“按终端高度动态分配历史区域”，进一步平衡完整性和稳定性。

### 2026-03-16 - Entry 022 - Weave 隐式动态 DAG（Observer 模式）

#### 范围
按“/weave 时触发、基于原生动作实时生长 DAG”的目标重构 Weave，实现不改模型 Prompt 的动态可视化执行树。

#### 改动
- `WeavePlugin` 改为纯观察者模式：
  - 不再注入/改写 system prompt。
  - 监听 Agent 原生生命周期动作并输出 DAG 事件（`weave.dag.event`）。
- 动态节点策略：
  - LLM 决策开始：`[◓] Node n: 大模型决策中...`
  - 决策为工具调用：`[•] Node n: 决策为调用工具`
  - 工具开始：`[ ] Node n.m: 执行 <tool>`
  - 工具结束：`[✔]/[✖] Node n.m: 执行 <tool>`
  - 本轮完成：`[✔] Node n: 本轮完成`
- 扩展插件接口与运行时：
  - 允许 `onRunStart / beforeLlmRequest / afterLlmResponse / beforeToolExecution / afterToolExecution`
    在执行中返回插件输出。
  - Runtime 在每个钩子点即时转发 `plugin.output`，形成实时事件流。
- TUI 事件桥接：
  - 在 `agent-ui-events.ts` 将 `plugin.output(weave.dag.event)` 映射为 `weave:dag`。
  - 在 `use-agent-state.ts` 订阅 `weave:dag` 并写入消息流，实现终端实时显示。

#### 影响文件
- src/weave/weave-plugin.ts
- src/agent/plugins/agent-plugin.ts
- src/agent/run-agent.ts
- src/tui/agent-ui-events.ts
- src/tui/use-agent-state.ts

#### 验证
- 构建校验通过：`pnpm build`。
- 功能冒烟通过：
  - `pnpm dev -- "/weave 请先思考，再调用read_file读取src/index.ts前5行，最后总结"`
  - 观测到 DAG 节点按“决策 -> 工具 -> 决策 -> 完成”实时生长输出。

#### 待解决问题
- 当前为文本化 DAG 事件流，尚未做 Mermaid/图形终端动画渲染。

#### 下一步
可选将 `weave.dag.event` 扩展为结构化 payload（节点/边/状态），为后续图形化 DAG 渲染做准备。

### 2026-03-16 - Entry 023 - Weave 树形渲染（结构化节点）

#### 范围
将 Weave 文本事件流升级为结构化 DAG 节点事件，并在 TUI 中实现实时树形渲染。

#### 改动
- `WeavePlugin` 输出由文本改为结构化节点事件：
  - `outputType: weave.dag.node`
  - `outputText` 为 JSON：`{ nodeId, parentId?, label, status }`
- `AgentUiEventGateway` 新增 `weave.dag.node` 解析与映射：
  - 解析 JSON 后发射 `weave:dag` 语义事件。
- `useAgentState` 增加 `weaveDagNodes` 状态：
  - 按 `nodeId` 增量更新节点状态（running/waiting/success/fail）。
  - 新一轮 `agent:start` 时清空 DAG 视图状态。
- `App.tsx` 增加 WEAVE DAG 树形区块：
  - 按父子关系实时渲染树。
  - 使用 `◓ • ✔ ✖` + 颜色区分节点状态。
  - 增加层级连接符（`├─` / `└─` / `│`）形成可读树形结构。

#### 影响文件
- src/weave/weave-plugin.ts
- src/tui/agent-ui-events.ts
- src/tui/use-agent-state.ts
- src/tui/App.tsx

#### 验证
- 构建校验通过：`pnpm build`。
- `/weave` 冒烟验证通过：
  - 在 TUI 顶部可见 `WEAVE DAG` 区块。
  - 节点状态会随 LLM 决策与工具执行实时更新。

#### 待解决问题
- 当前树形区块为“实时状态视图”，未保留每次状态变迁历史时间线。

#### 下一步
可选增加“当前节点高亮 + 折叠历史轮次 + 节点耗时(ms)”以进一步提升观感与诊断能力。

### 2026-03-16 - Entry 024 - Weave 节点状态修复与高亮耗时增强

#### 范围
修复 Node 1 在工具分支后停留 waiting 的问题，增强 `/weave` 触发鲁棒性，并补齐“当前节点高亮 + 节点耗时”。

#### 改动
- 插件输出链路支持批量事件：
  - `AgentLoopPlugin` 钩子允许返回 `AgentPluginOutput[]`。
  - Runtime 统一支持单条/多条插件事件转发。
- Weave 节点状态迁移修复：
  - 在下一次 LLM 决策开始前，将上一决策节点补发为 success（`工具阶段完成，继续推理`）。
  - 避免根节点长期停留 waiting。
- `/weave` 指令识别增强：
  - 解析规则升级为 `^[/／](weave|w)`，支持全角斜杠与短别名。
- DAG 渲染增强：
  - `use-agent-state` 为节点增加 `startedAtMs/endedAtMs/updatedAtMs`。
  - `App.tsx` 显示节点耗时（ms/s）。
  - 当前运行/等待节点增加高亮前缀 `➤` 与强调色。

#### 影响文件
- src/agent/plugins/agent-plugin.ts
- src/agent/run-agent.ts
- src/weave/weave-plugin.ts
- src/tui/use-agent-state.ts
- src/tui/App.tsx

#### 验证
- 构建验证通过：`pnpm build`。
- `/weave input` 触发验证通过：可进入 weave 模式并展示 DAG 区块。

#### 待解决问题
- 运行中高亮属于实时状态，执行极快的节点在最终快照中可能只看到完成态。

#### 下一步
如需更强可视反馈，可增加“状态变迁历史行”与“最短显示时长（避免一闪而过）”。

### 2026-03-16 - Entry 025 - Weave 节点过程明细与折叠交互

#### 范围
完成 Weave 节点下“运行过程明细”链路接入，支持终端内折叠/展开，并移除高频计时刷新导致的输入抖动源。

#### 改动
- Weave 插件扩展为双通道输出：
  - `weave.dag.node`：节点状态（running/waiting/success/fail）。
  - `weave.dag.detail`：节点过程明细（args/result 摘要）。
- TUI DAG 树增强：
  - 节点显示折叠标记（`[-]` / `[+]`）。
  - 运行中节点默认展开明细，完成后默认折叠（可手动展开）。
  - 明细行挂在节点下方，形成“节点 + 过程”结构。
- 增加键盘交互：
  - 空输入状态下 `↑/↓` 选择 DAG 节点。
  - 空输入状态下 `Enter` 切换当前节点明细折叠/展开。
- `/weave` 解析鲁棒性继续增强：
  - 支持去除零宽字符。
  - 支持无斜杠形式（`weave ...` / `w ...`）。
- 抖动治理：
  - 移除 `nowMs` 的 300ms 定时刷新。
  - 节点耗时改为基于事件时间戳（`endedAtMs` 或 `updatedAtMs`）计算，避免全局高频重渲染。

#### 影响文件
- src/weave/weave-plugin.ts
- src/tui/agent-ui-events.ts
- src/tui/use-agent-state.ts
- src/tui/App.tsx

#### 验证
- 构建验证通过：`pnpm build`。

#### 待解决问题
- 当前折叠交互为“键盘选择 + 回车切换”，尚未提供更丰富的快捷键提示面板。

#### 下一步
可选增加“仅显示当前节点明细”过滤开关，进一步提升长链路场景的可读性。

### 2026-03-16 - Entry 026 - Weave 输出即 DAG（单视图模式）

#### 范围
落实“开启 /weave 后输出就是 DAG 图”的交互要求，消除 DAG 区与聊天输出区分离的问题。

#### 改动
- `App.tsx` 增加 weave 回合单视图开关：
  - 当前回合启用 `/weave` 时，隐藏聊天/系统流水区，仅显示 DAG 区。
  - 状态栏增加 `weave=dag-only` 标识，明确当前为 DAG 单视图。
- `WeavePlugin` 增强节点明细：
  - LLM 节点在工具分支时写入 `plan=tool_calls` 明细。
  - 回合完成时将最终回答写入当前 LLM 节点明细（`final=...`）。
  - 根节点“进入下一轮”文案调整为“决策完成，进入下一轮”，语义更准确。

#### 影响文件
- src/tui/App.tsx
- src/weave/weave-plugin.ts

#### 验证
- 构建验证通过：`pnpm build`。

#### 待解决问题
- 最终回答目前以摘要形式写入节点明细（防止超长刷屏）；如需完整正文可改为分页明细模式。

#### 下一步
可选增加“展开时显示完整 final 文本（按行截断）”开关，兼顾可读性与终端稳定性。

### 2026-03-16 - Entry 027 - DAG 明细对齐与视觉美化

#### 范围
优化 Weave DAG 可读性与审美：节点展开内容对齐、明细框包裹、颜色冲突收敛。

#### 改动
- 明细对齐：展开明细与所属节点起始列对齐（同一层级起点）。
- 明细包裹：为节点明细增加轻量边框线（`┌─ details` / `│ ...` / `└─`），区分结构更清晰。
- 视觉主题：重配 TUI 色板，降低紫色冲突，统一为冷色调层次（主色/弱色/成功/失败/工具等待）。
- DAG 容器：DAG 区改为圆角边框块渲染，形成更稳定的信息分区。

#### 影响文件
- src/tui/App.tsx

#### 验证
- 构建验证通过：`pnpm build`。

#### 待解决问题
- 明细框当前为文本线框风格，后续可按终端能力再尝试更丰富的分组样式。

#### 下一步
可选增加“紧凑/舒展”两档 DAG 排版密度，适配不同终端宽度与个人偏好。

### 2026-03-16 - Entry 028 - DAG 卡片并流与终节点自动展开

#### 范围
将 Weave DAG 从“顶部固定区”改为“消息流内卡片条目”，实现普通输出与 DAG 输出合流；并优化回合结束选中策略。

#### 改动
- DAG 改为消息流内卡片渲染（不再作为顶部独立区块）。
- 节点详情改为真实容器边框（Ink Box），而非字符手绘框。
- 详情容器按节点层级缩进，与节点起始位置对齐。
- 回合结束时：自动选中最后一个节点并默认展开其详情（用于直接展示最终输出）。
- Weave 回合中，系统工具流水行隐藏，避免与 DAG 详情重复噪音。

#### 影响文件
- src/tui/App.tsx

#### 验证
- 构建验证通过：`pnpm build`。

#### 待解决问题
- 终端对 Box 边框在极窄宽度下会有压缩现象，后续可增加窄屏降级样式。

#### 下一步
可选加入“DAG 卡片置底自动跟随（smart follow）”与“历史 DAG 卡片折叠归档”提升长会话体验。

### 2026-03-16 - Entry 029 - Step Gate 闭环与会话级 Weave 模式

#### 范围
落地 P0 级执行闸门（Step Gate）能力，并将 Weave 从“按轮触发”升级为“会话级模式切换（on/off/step）”；同时完成工具节点语义化标题渲染。

#### 改动
- `AgentRuntime` 增加审批闸门事件与决策通道：
  - 新增事件：`node.pending_approval`、`node.approval.resolved`。
  - `runOnceStream` 支持 `stepMode` 与 `approveToolCall`。
  - 支持审批动作：`approve`、`edit`、`skip`、`abort`。
  - `skip` 时返回合成结果并跳过真实工具执行。
- `App.tsx` 接入 Step Gate 交互闭环：
  - 待审批态键位：`Enter` 放行、`E` 编辑参数并放行、`S` 跳过、`Q` 终止本轮。
  - 编辑参数支持 JSON 校验与错误提示。
  - 新增 Step Gate 提示卡，展示当前待审批工具与参数摘要。
- `App.tsx` 增加会话级 weave 模式：
  - 支持 `/weave on`、`/weave off`、`/weave step`。
  - 状态栏持续显示当前会话模式（`weave=off|on|step`），避免模式切换后退化。
- `App.tsx` 修复选中位移问题与视觉优化：
  - DAG 选中前缀改为固定宽度（未选中也保留占位），避免光标位移感。
  - 主题色改为偏橙配色，降低冷紫冲突。
- `WeavePlugin` 增加工具语义化模板：
  - `command_exec` -> “执行命令”。
  - `read_file` -> “读取文件”（含 path 与行区间摘要）。
  - `write_file` -> “写入文件”。
  - 其他工具保留通用回退模板。

#### 影响文件
- src/agent/run-agent.ts
- src/tui/App.tsx
- src/weave/weave-plugin.ts

#### 验证
- 构建验证通过：`pnpm build`。

#### 待解决问题
- `node.pending_approval` / `node.approval.resolved` 尚未在 `agent-ui-events.ts` 与 `use-agent-state.ts` 做统一状态映射，目前由 `App.tsx` 直接处理审批交互。

#### 下一步
补齐审批事件在 UI 状态层的标准化映射，并为 Step Gate 增加“审批历史”与“重放可视化”能力。

### 2026-03-16 - Entry 030 - 非 TTY 回退执行与 Step Gate 可重复验证

#### 范围
解决 Ink 在非交互 stdin（脚本/管道）下 raw mode 崩溃问题，打通可脚本化多轮测试链路，并新增 Step Gate 确定性冒烟脚本。

#### 改动
- 新增共享解析模块 `src/tui/weave-mode.ts`：
  - 统一 `WeaveMode` 类型与 `/weave on|off|step` + 行内 `/weave` 解析逻辑。
  - `App.tsx` 与 `index.ts` 共用同一解析路径，避免语义漂移。
- `App.tsx` 输入层增强：
  - `useInput` 增加 `isActive` 门控，仅在 TTY 场景启用原始输入监听。
  - 防止非交互环境误触发 raw mode 报错。
- `index.ts` 增加非 TTY 批处理回退模式：
  - 检测 `process.stdin.isTTY`，非 TTY 时不渲染 Ink UI。
  - 支持按行处理多轮输入、会话级 `/weave` 模式切换与 `/q` 退出。
  - 在 step 模式下支持批处理审批决策 token（`s`/`q`/`e + JSON`）。
- 新增可重复验证脚本 `scripts/verify-step-gate.mjs`：
  - 通过 mock LLM + mock tool 确定性覆盖 `approve/edit/skip` 三路径。
  - 验证审批事件、参数编辑透传、skip 不执行真实工具等核心语义。

#### 影响文件
- src/tui/weave-mode.ts
- src/tui/App.tsx
- src/index.ts
- scripts/verify-step-gate.mjs

#### 验证
- 构建验证通过：`pnpm build`。
- 非 TTY 多轮验证通过：`$input | pnpm dev` 可执行多轮并由 `/q` 结束，日志记录 turnCount 正确。
- Step Gate 确定性验证通过：`node scripts/verify-step-gate.mjs` 输出 `Step Gate smoke tests passed.`。

#### 待解决问题
- VS Code Problems 面板存在一条 `App.tsx` 的模块解析误报（构建不受影响），需结合本地 TS Server 配置进一步确认。

#### 下一步
补充交互式 TTY 端到端自动测试（含键位序列回放）以覆盖 UI 侧审批按键体验。

### 2026-03-16 - Entry 031 - 抖动治理与 Weave Step 交互细节优化

#### 范围
修复多轮问答场景下输入框抖动问题，并优化 `/weave step` 提示区域位置、节点默认选中策略与节点详情显示完整性。

#### 改动
- 输入抖动治理：
  - `use-agent-state.ts` 不再在 `llm.delta` 高频事件中累积 `thoughtText`，减少无效重渲染。
  - `run-agent.ts` 移除工具执行阶段的合成流式进度文本（开始/结束/继续推理提示），降低渲染抖动源。
- Weave Step 提示区域：
  - `App.tsx` 中 Step Gate 选择提示框从 DAG 上方移动到 WEAVE DAG 框内底部。
  - 用户完成选择（approve/edit/skip/abort）后继续按既有逻辑即时移除提示框。
- 节点默认位置策略：
  - `App.tsx` 改为始终将当前选中节点定位为最后一个节点（最新节点）。
  - 同步确保最后一个节点默认展开，避免回到首节点。
- 节点详情完整展示：
  - 移除 DAG 详情行的截断渲染，展开后显示完整 detail 文本。

#### 影响文件
- src/tui/use-agent-state.ts
- src/agent/run-agent.ts
- src/tui/App.tsx

#### 验证
- 构建验证通过：`pnpm build`。
- Step Gate 冒烟验证通过：`node scripts/verify-step-gate.mjs`。
- 非 TTY 集成验证通过：`/weave step -> s -> /q` 链路可执行并正常结束会话。

#### 待解决问题
- 交互式 TTY 下的视觉“绝对无抖动”仍依赖真实终端字体/窗口尺寸，需在用户本机终端做最终观感验收。

#### 下一步
补充一轮真实 TTY 场景的录屏级验收（多轮输入 + DAG 展开收起 + Step Gate 选择）。

## 当前待办清单
- [ ] Tool registry + before/after hooks（M1）
- [ ] Session memory persistence（M1）
- [ ] Gateway（WebSocket first）（M1）
- [ ] Skill dynamic injection（M2）
- [ ] Event bus standardization for WEAVE-ready DAG events（M3）
