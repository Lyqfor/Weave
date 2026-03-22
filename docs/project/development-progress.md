# Dagent 开发进度追踪

## 文档目的
用于记录每次问题解决后的变更、验证结果、待解决事项与下一步计划。

## 更新规则
- 每解决一个问题，追加一条新的进度记录。
- 每条记录必须包含：范围、改动、验证、待解决问题、下一步。

## 进度记录

### 2026-03-19 - Entry 068 - 调度引擎重构：EngineContext/BaseNode 泛型化 + TurnEngineBusAdapter + 流式旁路

#### 范围
`src/engine/`（原 `src/runtime/`）、`src/nodes/`（原 `src/runtime/nodes/`）、`src/session/run-context.ts`、`src/agent/`、`src/llm/`、`src/event/`

#### 改动
- **`src/engine/engine-types.ts`（新建）**：
  - `EngineContext` 接口：调度引擎最小依赖集（runId/dag/abortSignal/abortController/nodeRegistry/stateStore/snapshotStore/logger）
  - ⛔️ 不含 `pendingRegistry`（Step Gate 人机交互层，禁止下沉到引擎层）
- **`src/session/run-context.ts`**：
  - `RunContext extends EngineContext`，移除与 EngineContext 重复字段
  - `pendingRegistry?` 保留在 RunContext（Step Gate 层）
- **`src/engine/dag-executor.ts`**：
  - `executeDag(dag, ctx: EngineContext)` 收窄参数类型
  - 删除 `ctx.pendingRegistry?.rejectAll(...)` 调用（引擎不再负责 Step Gate 清理）
  - 新增 `WeaveDAGEngine` 类（面向对象封装）
- **`src/nodes/base-node.ts`**：
  - `BaseNode<C extends EngineContext = any>` 泛型化
  - `execute(ctx: C)` / `doExecute(ctx: C)` / `transitionInDag(ctx: C)` / `broadcastIo(ctx: C)` 全泛型
  - 拦截器/bus 通过 `(ctx as any)` 安全访问（仅 RunContext 场景持有）
- **`src/nodes/llm-node.ts` / `tool-node.ts` / `final-node.ts`**：`extends BaseNode<RunContext>`
- **`src/nodes/input-node.ts` / `repair-node.ts` / `attempt-node.ts` / `escalation-node.ts`**：`extends BaseNode<EngineContext>`
- **`src/agent/turn-engine-bus-adapter.ts`（新建）**：
  - `TurnEngineBusAdapter implements IEngineEventBus`
  - 将 run-agent.ts 中 30 行内联匿名对象提升为具名类
  - 实现 `onNodeStreamDelta`（流式旁路）
- **`src/agent/run-agent.ts`**：
  - 删除内联 `engineBus` 对象，替换为 `new TurnEngineBusAdapter(bus, runId, sessionId)`
  - Layer 3 自绑定：`abortController.signal.addEventListener("abort", () => pendingRegistry.rejectAll(...))`
- **`src/engine/engine-event-bus.ts`**：新增 `onNodeStreamDelta?(nodeId, chunkText): void`
- **`src/llm/qwen-client.ts`**：
  - `chatWithTools(input, options?: { onDelta? })` 新增流式路径
  - 流式路径：逐 delta 回调 + 完整工具调用聚合（保证结构正确性）
- **`src/nodes/llm-node.ts`**：`onDelta: (delta) => ctx.dag.getEngineEventBus()?.onNodeStreamDelta?.(this.id, delta)`
- **`src/event/event-types.ts`**：新增 `engine.node.stream.delta` 事件类型
- **目录迁移**：`src/runtime/` → `src/engine/`，`src/runtime/nodes/` → `src/nodes/`（删除全部 runtime/ 文件）
- **`scripts/verify-dag-matrix.mjs`**：修复路径 `dist/runtime/` → `dist/engine/`，删除已废弃 WeavePlugin 引用

#### 验证
- 构建通过：`pnpm build`
- Step Gate 回归通过：`node scripts/verify-step-gate.mjs`
- DAG 语义回归通过：`node scripts/verify-dag-matrix.mjs`
- 完整 P0 套件通过：`pnpm verify:p0`

#### 待解决问题
- `src/engine/dag-graph.ts` 中 `runner-types.ts` 迁移路径有 3 行差异（已在 chore 提交中处理）
- `verify-dag-matrix.mjs` 的一致性测试删除了 WeavePlugin；若后续重新引入观察者插件需补充测试用例

#### 下一步
- Phase 1B 流式旁路可在 `pnpm dev:graph:all` 中验证（Web UI 节点实时显示 LLM 推理文字）
- EngineContext 中 `nodeRegistry: Map<string, any>` 可在 TypeScript 5.x 中通过接口自引用改善类型精度

### 2026-03-17 - Entry 067 - 架构重构：单一执行路径 + 丰富钩子上下文 + TurnDAGBuilder

#### 范围
合并 Legacy/DAG 双执行路径为单一 `runAgentLoop`；丰富插件钩子上下文携带重试信息；WeavePlugin 重构为 TurnDAGBuilder 模式，支持完整节点类型体系。

#### 改动
- **`src/agent/plugins/agent-plugin.ts`**：
  - `BeforeToolExecutionContext` 新增：`intentSummary?`、`attempt`（1-indexed）、`maxRetries`、`previousError?`、`repairedFrom?`
  - `AfterToolExecutionContext` 新增：`intentSummary?`、`attempt`、`totalAttempts`、`wasRepaired`、`allFailed?`
- **`apps/shared/graph-protocol.ts`**：
  - `NodeUpsertPayload.kind` 新增：`"input" | "attempt" | "escalation" | "condition"`
  - `EdgeUpsertPayload` 新增：`fromPort?`、`toPort?`、`edgeKind?`（dependency/data/retry/condition_true/condition_false）
- **`src/agent/run-agent.ts`**：
  - `shouldUseDagRunner` 始终返回 `false`（单一执行路径）
  - `runAgentLoop` 重构工具执行内循环：每次尝试前后各调用 `beforeToolExecution`/`afterToolExecution`，携带完整重试上下文
  - 新增超时支持：使用 `executeToolWithTimeoutFn` 替代裸 `toolRegistry.execute`
- **`src/weave/weave-plugin.ts`**：
  - 新增 `TurnDAGBuilder` 类：管理节点状态，生成规范化节点 ID（`input`/`llm-N`/`tool-N`/`tool-N:attempt-M`/`tool-N:repair-M`/`tool-N:escalation`/`final`）
  - 新增 `buildDagEdge()` 及 `weave.dag.edge` 输出类型：显式声明节点间数据流边和重试链边
  - 节点事件新增 `kind` 字段（不再依赖 GraphProjector 的启发式推断）
  - 完整节点链路：InputNode → LlmNode → ToolNode → AttemptNode → RepairNode → AttemptNode → EscalationNode / FinalNode
- **`apps/weave-graph-server/src/projection/graph-projector.ts`**：
  - 处理新 `weave.dag.edge` 事件 → 转化为带 `fromPort`/`toPort`/`edgeKind` 的 `edge.upsert`
  - `weave.dag.node` 优先使用 `kind` 字段，回退到 `inferKind` 启发式推断
- **`apps/weave-graph-web/src/store/graph-store.ts`**：
  - `edge.upsert` 处理新增 `edgeKind`：retry 边虚线橙色，data 边动画
- **`scripts/verify-dag-matrix.mjs`**：
  - 更新断言以匹配新的事件类型（`weave.dag.node` 替代 `weave.dag.event`，`node.pending_approval` 替代 `dag.node.transition`）

#### 验证
- 构建通过：`pnpm build`
- Step Gate 回归通过：`node scripts/verify-step-gate.mjs`
- DAG 语义回归通过：`node scripts/verify-dag-matrix.mjs`
- 完整 P0 套件通过：`pnpm verify:p0`

#### 待解决问题
- DAG runner（`runAgentDagLoop`）代码仍保留在 run-agent.ts 中（已死代码），可在后续清理
- FinalNode 与 EscalationNode 的 I/O port 尚未填充（计划在 node.io 层丰富）

#### 下一步
- 补充 AttemptNode/RepairNode 的 `node.io` 数据（args 作为 inputPort，result 作为 outputPort）
- Step Gate 通过 `beforeToolExecution` 返回 deferred promise 实现（Phase 3）
- TUI 和 Web 统一事件流（Phase 4）

### 2026-03-17 - Entry 066 - 修复同轮双 DAG 分裂（run_xxx 与 session:turn 并存）

#### 范围
排查并修复“单次回答在前端出现两个 DAG”的链路问题，目标是将本轮最终输出稳定归并到同一 DAG 末尾节点。

#### 改动
- 运行时事件顺序修复：
  - [src/agent/run-agent.ts](src/agent/run-agent.ts)
  - 将插件收尾输出（`executeOnRunCompleted`）前移到 `run.completed` 事件之前。
  - 避免图投影层在 run 完结后再收到晚到插件事件，从而产生 `run_xxx` 新 DAG。
- 图投影容错增强：
  - [apps/weave-graph-server/src/projection/graph-projector.ts](apps/weave-graph-server/src/projection/graph-projector.ts)
  - 为已完成 run 增加短暂上下文保留窗口（grace period），吸收晚到 `plugin.output`。
  - 增加上下文上限与定期清理，避免内存无限增长。

#### 验证
- 构建通过：`pnpm build`
- Step Gate 回归通过：`node scripts/verify-step-gate.mjs`
- DAG 语义回归通过：`node scripts/verify-dag-matrix.mjs`
- 定向复现验证通过（模拟 `run.completed` 后晚到 `plugin.output`）：
  - 输出 `DAG_IDS ["s1:turn-3"]`
  - 输出 `PASS_SINGLE_DAG`

#### 待解决问题
- 目前该场景验证为脚本内定向验证，后续应补充为常驻单测用例防回归。

#### 下一步
- 在图服务或 runtime 层补充自动化用例：断言同一 run 的全部事件只能产生一个 dagId。

### 2026-03-17 - Entry 065 - 修复 /weave on 无节点（插件 this 绑定 + 动态配置读取）

#### 范围
针对“`/weave on` 下 TUI 未收到节点消息”进行全链路排查（runtime -> plugin -> ui-gateway -> state -> render），并在既有重构基础上做回归修复与验证。

#### 改动
- 修复插件钩子上下文丢失：
  - [src/agent/plugin-executor.ts](src/agent/plugin-executor.ts)
  - `executePluginHook` 从函数引用调用改为 `hook.call(plugin, context)`，确保 `WeavePlugin` 内部 `this.runStates` 可用。
- 修复运行时配置静态化回归：
  - [src/config/defaults.ts](src/config/defaults.ts)
  - 新增 `getDefaultToolRetries()` 与 `getDefaultToolTimeoutMs()` 运行时读取函数。
  - [src/agent/run-agent.ts](src/agent/run-agent.ts)
  - 重试与超时逻辑改为调用运行时 getter，避免模块加载时固化环境变量。
- 文档复盘与任务同步：
  - [docs/project/optimization-plan-v2.md](docs/project/optimization-plan-v2.md)
  - 增补本次链路根因，新增并标记完成 OPT-25。

#### 验证
- 构建通过：`pnpm build`
- Step Gate 回归通过：`node scripts/verify-step-gate.mjs`
- DAG 语义回归通过：`node scripts/verify-dag-matrix.mjs`
- 根因证据来自会话记录：
  - [sessions/session-session_1773720954447_bf57fd77f6a3.jsonl#L5](sessions/session-session_1773720954447_bf57fd77f6a3.jsonl#L5)
  - [sessions/session-session_1773720954447_bf57fd77f6a3.jsonl#L7](sessions/session-session_1773720954447_bf57fd77f6a3.jsonl#L7)

#### 待解决问题
- 目前缺少针对插件钩子调用语义（上下文绑定）的单元测试，存在后续重构回归风险。

#### 下一步
- 为 `plugin-executor` 增加单测：覆盖 `this` 绑定、空输出、异常路径。
- 为运行时配置增加单测：覆盖环境变量在运行期变更的场景。

### 2026-03-17 - Entry 064 - Inspector 三态交互 + 高亮懒加载 + stop 日志准确性修复

#### 范围
在上一轮视觉升级基础上继续优化：为 Inspector 增加摘要/展开/复制三态交互；高亮组件改为按需懒加载；修复 stop 过程中误报 `[ok]` 的日志准确性问题。

#### 改动
- Inspector 三态交互：
  - [apps/weave-graph-web/src/App.tsx](apps/weave-graph-web/src/App.tsx)
  - `renderPortSummary` 升级为 `InspectorTextBlock`。
  - 支持 `摘要` / `展开` / `复制` 三按钮。
  - 长文本默认摘要显示，展开后展示完整高亮块。
- 高亮按需加载：
  - [apps/weave-graph-web/src/App.tsx](apps/weave-graph-web/src/App.tsx)
  - 高亮库改为 `import()` 动态加载，仅在用户点击“展开”时加载。
  - 新增“正在加载高亮...”过渡态。
- 样式细化：
  - [apps/weave-graph-web/src/app.css](apps/weave-graph-web/src/app.css)
  - 新增 Inspector 工具栏按钮样式、激活态、代码块容器样式。
- stop 日志准确性修复：
  - [scripts/stop-weave-graph-all.ps1](scripts/stop-weave-graph-all.ps1)
  - `Stop-ProcessTree` 先校验 PID 是否存在，再执行 `taskkill /T /F`。
  - 按 `taskkill` 退出码判断成功/失败，避免“未找到进程却打印成功”。
- 依赖补充：
  - `react-syntax-highlighter`
  - `@types/react-syntax-highlighter`

#### 验证
- 构建验证通过：
  - `apps/weave-graph-web: pnpm build`
- stop 行为验证通过：
  - `pnpm dev:graph:all` 后执行 `pnpm dev:graph:stop`，无残留管理进程。

#### 待解决问题
- `react-syntax-highlighter` 仍会产生较多语言分片 chunk，后续可改为仅注册 json/bash 轻量语言集进一步瘦身。

#### 下一步
- 将高亮切换为轻量语言白名单（json/bash/powershell），继续优化包体与加载速度。

### 2026-03-17 - Entry 063 - stop 全终端清理修复 + 赛博曜石视觉升级

#### 范围
修复 `dev:graph:stop` 不能关闭所有已启动终端/进程的问题；按“赛博曜石”方案重构前端配色、节点、连线与面板观感。

#### 改动
- 终端/进程清理增强：
  - [scripts/start-weave-graph-all.ps1](scripts/start-weave-graph-all.ps1)
  - [scripts/stop-weave-graph-all.ps1](scripts/stop-weave-graph-all.ps1)
  - 启动时给所有子进程注入 `WEAVE_GRAPH_MANAGED=1` 标记。
  - stop 使用 `taskkill /T /F` 进行进程树关闭（含子进程）。
  - stop 增加残留扫描：按命令行特征清理 graph-server / graph-web / graph-cli 残留进程。
  - 即使 PID 文件丢失也可执行兜底清理。
- 视觉系统升级（赛博曜石）：
  - [apps/weave-graph-web/src/app.css](apps/weave-graph-web/src/app.css)
  - 画布切为曜石黑背景，Dots 点阵增强空间感。
  - 节点改为“左侧高亮强调线 + 毛玻璃 + 阴影悬浮”风格。
  - 语义色对齐：LLM 紫、Tool 蓝、Gate 橙、Error/Retry 红、Success 绿。
  - 时间轴改为克制 hover 高亮，去重边框噪声。
  - Inspector 增加空状态居中提示样式。
- 节点与连线语义优化：
  - [apps/weave-graph-web/src/nodes/semantic-node.tsx](apps/weave-graph-web/src/nodes/semantic-node.tsx)
  - [apps/weave-graph-web/src/App.tsx](apps/weave-graph-web/src/App.tsx)
  - 节点图标升级（🧠⚡⏸️✖️✔️）。
  - 连线默认淡灰，运行中动画蓝，成功绿，失败红。
- Inspector 代码高亮：
  - [apps/weave-graph-web/src/App.tsx](apps/weave-graph-web/src/App.tsx)
  - 引入 `react-syntax-highlighter` 渲染 JSON/长日志。
  - 依赖：`react-syntax-highlighter`、`@types/react-syntax-highlighter`。
- 协议语义补强：
  - [apps/weave-graph-server/src/protocol/graph-events.ts](apps/weave-graph-server/src/protocol/graph-events.ts)
  - [apps/weave-graph-server/src/projection/graph-projector.ts](apps/weave-graph-server/src/projection/graph-projector.ts)
  - 新增 `gate` 节点类型推断（Step Gate / 人工拦截/挂起）。

#### 验证
- stop 全清理验证通过：
  - `pnpm dev:graph:all` 后执行 `pnpm dev:graph:stop`。
  - 主 CLI、后端日志窗口、后台服务进程均被关闭。
  - 残留扫描结果：`MANAGED_LEFT_NONE`。
- 构建验证通过：
  - `apps/weave-graph-server: pnpm build`
  - `apps/weave-graph-web: pnpm build`

#### 待解决问题
- 代码高亮依赖引入后前端 bundle 体积上升，后续可做懒加载拆包优化。

#### 下一步
- 对 Inspector 的长日志增加“摘要/展开/复制”三态交互，降低信息负载。

### 2026-03-17 - Entry 062 - 四阶段前端改造完成（Timeline + Inspector + 语义节点 + 布局性能）

#### 范围
按既定顺序完成并验证 Phase 1 到 Phase 4：多 DAG 管理、详情面板、视觉语义化、布局性能与拖拽锁定。

#### 改动
- Phase 1（多 DAG 与时间轴）
  - [apps/weave-graph-web/src/store/graph-store.ts](apps/weave-graph-web/src/store/graph-store.ts)
  - [apps/weave-graph-web/src/App.tsx](apps/weave-graph-web/src/App.tsx)
  - 按 `dagId` 分桶存储图数据，左侧 Timeline 支持按轮次切换，中间仅渲染当前 DAG。
- Phase 2（Inspector 详情抽屉）
  - [apps/weave-graph-web/src/store/graph-store.ts](apps/weave-graph-web/src/store/graph-store.ts)
  - [apps/weave-graph-web/src/App.tsx](apps/weave-graph-web/src/App.tsx)
  - 支持节点选中与右侧详情展示（类型/状态/输入端口/输出端口）。
- Phase 3（语义节点与美学）
  - [apps/weave-graph-web/src/nodes/semantic-node.tsx](apps/weave-graph-web/src/nodes/semantic-node.tsx)
  - [apps/weave-graph-web/src/app.css](apps/weave-graph-web/src/app.css)
  - [apps/weave-graph-web/src/App.tsx](apps/weave-graph-web/src/App.tsx)
  - [apps/weave-graph-web/src/store/graph-store.ts](apps/weave-graph-web/src/store/graph-store.ts)
  - 深色三栏布局、语义配色节点、状态灯、平滑边线、运行中边线动画。
- Phase 4（布局节流与拖拽锁定）
  - [apps/weave-graph-web/src/layout/dagre-layout.ts](apps/weave-graph-web/src/layout/dagre-layout.ts)
  - [apps/weave-graph-web/src/store/graph-store.ts](apps/weave-graph-web/src/store/graph-store.ts)
  - [apps/weave-graph-web/src/App.tsx](apps/weave-graph-web/src/App.tsx)
  - 100ms 布局批处理；节点拖动后写入锁定集合，后续自动布局保留人工位置。
- 配套改动
  - [apps/weave-graph-web/src/types/graph-events.ts](apps/weave-graph-web/src/types/graph-events.ts)
  - 新增 `subtitle` 字段用于节点次级信息渲染。

#### 验证
- 阶段性构建验证全部通过：
  - 每个 Phase 完成后均执行 `apps/weave-graph-web: pnpm build`。
- 运行态验证通过：
  - `pnpm dev:graph:all` 启动成功。
  - 注入事件后收到 WS 消息，包含 `dagId: s-phase:turn-1`。
  - 后端事件日志窗口可见并持续输出。

#### 待解决问题
- 当前 Inspector 已可用，但尚未加入“长日志折叠/展开 + 一键复制 + blob 引用加载”。

#### 下一步
- 增加 `node.io` 大文本分级展示策略（摘要优先、长文按需加载）。

### 2026-03-17 - Entry 061 - 后端事件日志可视化 + DAG ID 落地 + 左右布局

#### 范围
响应“后端可见日志”和“每轮问答独立 DAG 标识”诉求，补齐启动可观测性与协议标识，并将画布方向切换为左到右。

#### 改动
- 启动脚本增强（可观测性）：
  - [scripts/start-weave-graph-all.ps1](scripts/start-weave-graph-all.ps1)
  - 启动后自动打开后端日志窗口（tail .run.log），实时看到 `ingest accepted` / `publish` 事件。
  - 增加启动前预停止与残留进程清理（graph-web + graph-server）。
  - 日志文件清理改为安全模式（被占用时回退清空）。
- 停止脚本向后兼容：
  - [scripts/stop-weave-graph-all.ps1](scripts/stop-weave-graph-all.ps1)
  - 兼容旧 PID 文件不存在 `backendLogPid` 字段的情况。
- 协议与投影新增 DAG ID：
  - [apps/weave-graph-server/src/protocol/graph-events.ts](apps/weave-graph-server/src/protocol/graph-events.ts)
  - [apps/weave-graph-server/src/projection/graph-projector.ts](apps/weave-graph-server/src/projection/graph-projector.ts)
  - 规则：`dagId = sessionId:turn-{turnIndex}`，若缺失则回退 `runId`。
  - 所有 envelope 附带 `dagId`，`run.start.payload` 也附带 `dagId`。
- 前端类型与状态同步：
  - [apps/weave-graph-web/src/types/graph-events.ts](apps/weave-graph-web/src/types/graph-events.ts)
  - [apps/weave-graph-web/src/store/graph-store.ts](apps/weave-graph-web/src/store/graph-store.ts)
  - Store 新增 `dagId`，按 envelope 同步当前 DAG。
- 画布方向切换为左到右：
  - [apps/weave-graph-web/src/App.tsx](apps/weave-graph-web/src/App.tsx)
  - Dagre `TB` 改为 `LR`。

#### 影响文件
- scripts/start-weave-graph-all.ps1
- scripts/stop-weave-graph-all.ps1
- apps/weave-graph-server/src/protocol/graph-events.ts
- apps/weave-graph-server/src/projection/graph-projector.ts
- apps/weave-graph-web/src/types/graph-events.ts
- apps/weave-graph-web/src/store/graph-store.ts
- apps/weave-graph-web/src/App.tsx
- apps/weave-graph-web/src/types/dagre.d.ts

#### 验证
- 启动验证通过：`pnpm dev:graph:all` 成功，后端日志窗口自动打开。
- 协议验证通过：WS 消息出现 `dagId`，示例 `sess-1:turn-3`。
- 构建验证通过：
  - `apps/weave-graph-server: pnpm build`
  - `apps/weave-graph-web: pnpm build`

#### 待解决问题
- 当前前端仍是“单画布视图”，尚未实现左侧多轮会话时间轴与右侧 Inspector。

#### 下一步
- 进入三栏式 UI 改造：Timeline（按 dagId 列表）+ Canvas（当前 DAG）+ Inspector（节点详情抽屉）。

### 2026-03-17 - Entry 060 - 修复主 CLI 无交互问题（空终端）

#### 范围
修复 `dev:graph:all` 启动后“后端窗口空白、无法交互”的问题，明确区分后台服务与交互入口。

#### 改动
- 调整三服务窗口策略：
  - `scripts/start-weave-graph-all.ps1`
  - 图后端、图前端改为隐藏窗口后台运行（保留日志文件）。
  - 主 CLI 改为可见窗口启动，并使用 `-NoExit` 保持交互终端。
- 调整主 CLI 启动命令：
  - 取消输出重定向到日志文件，恢复实时交互输入输出。
  - 保留 `WEAVE_GRAPH_INGEST_URL` 与 `WEAVE_GRAPH_TOKEN` 环境变量注入。
  - 在 CLI 窗口启动时打印交互提示文案。
- 启动结果文案更新：
  - 增加 `main CLI interaction: opened in a new PowerShell window`，避免误解为空白后端窗口。

#### 影响文件
- scripts/start-weave-graph-all.ps1

#### 验证
- 执行 `pnpm dev:graph:all` 成功。
- 启动输出包含“主 CLI 在新窗口交互”提示。
- 三进程均存活：graph-backend / graph-frontend / main-cli。
- 图前端 URL 可访问（HTTP 200）。

#### 待解决问题
- 目前主 CLI 为独立窗口交互；若后续需要“当前终端内交互”模式，可再加一个 `dev:graph:attach` 方案。

#### 下一步
- 增加可选参数（interactive/background）以支持两种启动方式切换。

### 2026-03-17 - Entry 059 - 修复“前端在、后端不在”的假启动成功问题

#### 范围
修复 `dev:graph:all` 在存在历史残留进程时的误判问题：页面能打开但新启动链路不完整，表现为“前端看起来在，两个后端没起来”。

#### 改动
- 启动前残留进程清理：
  - `scripts/start-weave-graph-all.ps1`
  - 增加对 `apps/weave-graph-web + vite` 历史进程的识别和清理，避免 5173 被旧进程占用。
- 启动过程存活校验增强：
  - 图后端 token/port 解析等待期间，新增“后端进程仍存活”校验，异常立即失败。
  - 图前端就绪等待期间，新增“前端进程仍存活”校验，避免被旧 5173 响应误判为成功。
- 启动后稳定性校验：
  - 主 CLI 拉起后新增 2 秒健康检查，三进程任一提前退出即报错。

#### 影响文件
- scripts/start-weave-graph-all.ps1

#### 验证
- 启动日志显示清理残留成功：`[cleanup] stopped stale graph-web process`。
- 三进程存活验证通过：graph-backend / graph-frontend / main-cli 均 `RUNNING`。
- 页面与后端接口验证通过：
  - `graphWebUrl` 返回 `200`
  - `POST ingest` 返回 `202`
- WS 实时链路验证通过：
  - `WS_OPEN`
  - 收到 `weave.graph.v1 run.start` 广播消息

#### 待解决问题
- 当前清理策略聚焦 graph-web 残留；后续可补一版 `dev:graph:doctor` 输出更完整冲突诊断信息。

#### 下一步
- 增加 `dev:graph:status`/`dev:graph:doctor` 脚本，一键打印进程、端口、URL、WS 四维健康状态。

### 2026-03-17 - Entry 058 - 修复 dev:graph:all 启动后页面不可访问

#### 范围
修复 `pnpm dev:graph:all` 启动后浏览器访问 `127.0.0.1:5173` 失败的问题，并完成端到端复测。

#### 改动
- 修复启动脚本前端绑定地址：
  - `scripts/start-weave-graph-all.ps1`
  - 图前端启动命令改为：`pnpm dev -- --host 127.0.0.1 --port 5173 --strictPort`
  - 避免 Vite 仅监听 `localhost/::1` 导致 `127.0.0.1` 无法访问。
- 增加前端就绪探测：
  - 启动后轮询 `http://127.0.0.1:5173/`，就绪后再继续后续流程。
  - 超时直接报错，避免“启动成功但不可访问”的假阳性。
- 启动进程窗口处理：
  - 三个子进程统一 `-WindowStyle Hidden` 启动，避免出现空白终端窗口干扰。

#### 影响文件
- scripts/start-weave-graph-all.ps1

#### 验证
- `pnpm dev:graph:all` 执行成功，输出 graph URL/token。
- 页面可访问验证通过：
  - `Invoke-WebRequest <graphWebUrl>` 返回 `200`。
- 端口监听验证通过：
  - `127.0.0.1:5173`（图前端）
  - `127.0.0.1:<graph-port>`（图后端）
- WS 实时链路验证通过：
  - `WS_OPEN` 后收到 `weave.graph.v1 run.start` 广播消息。

#### 待解决问题
- 仍可能存在历史遗留 `vite` 进程占用 `::1:5173` 的情况，建议先执行一次 `pnpm dev:graph:stop` 再启动。

#### 下一步
- 增加 `dev:graph:status` 健康检查脚本，统一输出“进程/端口/URL/WS”四项状态。

### 2026-03-17 - Entry 057 - 图链路连通性验收（真实 CLI 事件）

#### 范围
对三服务一键启动链路做端到端验收，确认不只“手工注入可通”，还可接收真实主 CLI Runtime 事件。

#### 改动
- 联调与可观测性修复落地并复验：
  - `scripts/start-weave-graph-all.ps1`
  - `scripts/stop-weave-graph-all.ps1`
  - `apps/weave-graph-server/src/gateway/ws-gateway.ts`
- 验证路径补强：
  - 先验证三服务 PID 持活与 URL/token 产出；
  - 再做 `ingest -> ws` 直连验证；
  - 最后执行真实 `pnpm dev -- "ls -a"`，检查图后端与转发器日志中的事件落库与广播。

#### 影响文件
- scripts/start-weave-graph-all.ps1
- scripts/stop-weave-graph-all.ps1
- apps/weave-graph-server/src/gateway/ws-gateway.ts
- logs/runtime/graph-cli-forwarder.log
- apps/weave-graph-server/.run.log

#### 验证
- 三服务启动与持活验证通过：
  - `pnpm dev:graph:all` 后 PID 文件存在，三个进程均 `RUNNING`。
- ingest -> ws 广播验证通过：
  - WS 客户端收到 `weave.graph.v1` 的 `run.start` 消息。
- 真实 CLI 事件转发验证通过：
  - 执行 `pnpm dev -- "ls -a"` 后，图后端日志出现：
    - `ingest accepted type=run.start`
    - `ingest accepted type=tool.execution.start/end`
    - `ingest accepted type=llm.request/llm.delta/llm.completed`
    - `ingest accepted type=run.completed`

#### 待解决问题
- 目前已证明链路可通，但“前端图层可视化细节（端口卡片/布局节流）”仍待继续增强。

#### 下一步
- 增加自动 smoke 脚本：一键启动后自动发起一次真实 CLI turn，并断言 WS 收到关键事件集合。

### 2026-03-16 - Entry 056 - 启动流程验证与三服务一键启停脚本

#### 范围
验证图前端启动失败原因并修复；新增三服务（主CLI/图后端/图前端）一键启停脚本。

#### 改动
- 启动问题修复：
  - `apps/weave-graph-web/package.json`
  - 修正不可用依赖版本：`@types/react-dom` -> `^19.2.3`
- 新增一键启动脚本：
  - `scripts/start-weave-graph-all.ps1`
  - 自动启动图后端并解析 `ingestUrl/token`
  - 自动启动图前端
  - 自动启动主 CLI，并注入：
    - `WEAVE_GRAPH_INGEST_URL`
    - `WEAVE_GRAPH_TOKEN`
  - 写入 PID 文件：`scripts/.weave-graph-dev-pids.json`
- 新增一键停止脚本：
  - `scripts/stop-weave-graph-all.ps1`
  - 读取 PID 文件并停止三服务进程
- 根脚本入口：
  - `package.json`
  - `dev:graph:all` / `dev:graph:stop`
- 文档补充：
  - `docs/project/weave-2d-graph-blueprint.md`
  - 增加一键脚本用法与三服务解耦关系说明

#### 影响文件
- apps/weave-graph-web/package.json
- scripts/start-weave-graph-all.ps1
- scripts/stop-weave-graph-all.ps1
- package.json
- docs/project/weave-2d-graph-blueprint.md

#### 验证
- 图后端启动日志验证通过：可输出 `ws url + ingest url + token`。
- ingest 接口验证通过：`POST /ingest/runtime-event` 返回 `ok=true`。
- 图前端启动验证通过：Vite 可正常启动。
- 主项目构建通过：`corepack pnpm build`。

#### 待解决问题
- 当前脚本默认使用 PowerShell 打开新窗口，后续可补跨平台脚本（bash/Node orchestrator）。

#### 下一步
- 增加“状态检查脚本”（health check）与端到端 smoke 命令，自动验证三服务链路健康度。

### 2026-03-16 - Entry 055 - 二维图链路打通（CLI 事件转发 -> Graph Projection -> WS -> 前端）

#### 范围
打通首条端到端链路：现有 CLI Runtime 事件实时转发到图服务，前端可接收并展示“终端输入命令”节点。

#### 改动
- CLI 运行时事件转发：
  - `src/index.ts`
  - 新增 `setupGraphEventForwarder`，订阅 `agent.on("event")` 并 POST 到图服务 ingest 接口
  - 支持环境变量：
    - `WEAVE_GRAPH_INGEST_URL`
    - `WEAVE_GRAPH_TOKEN`
- 图投影增强：
  - `apps/weave-graph-server/src/projection/graph-projector.ts`
  - `run.start` 事件自动投影为输入节点：
    - `node.upsert`（title=`终端输入命令` 或 `终端输入`）
    - `node.status=success`
    - `node.io`（stdin/input.text）
- 图网关增强：
  - `apps/weave-graph-server/src/gateway/ws-gateway.ts`
  - 新增 `POST /ingest/runtime-event`（token 鉴权）
  - 网关启动时输出 `ingestUrl + token`
- 前端节点可见性增强：
  - `apps/weave-graph-web/src/store/graph-store.ts`
  - `apps/weave-graph-web/src/types/graph-events.ts`
  - 默认节点补充 `label`，状态变化时更新标签，确保 React Flow 默认节点可见

#### 影响文件
- src/index.ts
- apps/weave-graph-server/src/gateway/ws-gateway.ts
- apps/weave-graph-server/src/index.ts
- apps/weave-graph-server/src/projection/graph-projector.ts
- apps/weave-graph-web/src/store/graph-store.ts
- apps/weave-graph-web/src/types/graph-events.ts

#### 验证
- 主项目构建通过：`corepack pnpm build`。

#### 待解决问题
- 当前前端布局仍为全量 Dagre 重算，尚未启用 80~120ms 批处理与拖拽锁定回写。

#### 下一步
- 接入布局批处理节流与锁定节点策略；补充 node.io 多端口渲染卡片。

### 2026-03-16 - Entry 054 - 二维图工程蓝图落地（Server/Web 骨架 + 协议 + 布局管线）

#### 范围
按工业级最小方案落地二维图可开工骨架：后端 Graph Projection + WS 推送，前端 React Flow + Zustand + Dagre。

#### 改动
- 新增后端子工程骨架（独立于主 CLI 构建链路）：
  - `apps/weave-graph-server/package.json`
  - `apps/weave-graph-server/tsconfig.json`
  - `apps/weave-graph-server/src/protocol/graph-events.ts`
  - `apps/weave-graph-server/src/projection/graph-projector.ts`
  - `apps/weave-graph-server/src/gateway/ws-gateway.ts`
  - `apps/weave-graph-server/src/index.ts`
- 新增前端子工程骨架：
  - `apps/weave-graph-web/package.json`
  - `apps/weave-graph-web/tsconfig.json`
  - `apps/weave-graph-web/vite.config.ts`
  - `apps/weave-graph-web/index.html`
  - `apps/weave-graph-web/src/types/graph-events.ts`
  - `apps/weave-graph-web/src/store/graph-store.ts`
  - `apps/weave-graph-web/src/layout/dagre-layout.ts`
  - `apps/weave-graph-web/src/workers/layout.worker.ts`
  - `apps/weave-graph-web/src/App.tsx`
  - `apps/weave-graph-web/src/main.tsx`
- 新增蓝图文档：
  - `docs/project/weave-2d-graph-blueprint.md`
  - 包含目录结构、协议最小集合、联调步骤与下一阶段建议

#### 影响文件
- apps/weave-graph-server/**
- apps/weave-graph-web/**
- docs/project/weave-2d-graph-blueprint.md

#### 验证
- 主项目构建通过：`corepack pnpm build`（确认新增骨架未影响现有 CLI 构建）。

#### 待解决问题
- 当前仅为可开工骨架，尚未把主 Runtime 真实事件流接入 `GraphProjector` 生产链路。

#### 下一步
- 将 `src/agent/run-agent.ts` 的 `event` 订阅接入 `GraphProjector`，打通端到端实时二维图。

### 2026-03-16 - Entry 053 - 局部修复节点语义升级（LLM输出 + 修复后参数）

#### 范围
优化“局部修复参数”节点可读性：不再重复展示上一次错误原因，改为明确展示 LLM 修复输出与修复后参数。

#### 改动
- 修复结果结构化：
  - `src/agent/run-agent.ts`
  - `repairToolArgsByIntent` 返回结构升级为 `{ repairedArgs, llmOutput }`
  - DAG 与 legacy 两条重试路径统一消费新结构
- 修复节点展示语义调整：
  - `src/agent/run-agent.ts`
  - 修复节点标题改为 `LLM局部修复参数 #n`
  - 修复节点 detail 输出：
    - `llm_output=...`
    - `repaired_args=...`
  - 移除修复节点中的 `last_error=...` 噪声
- UI 节点类型展示优化：
  - `src/tui/App.tsx`
  - 对 `LLM局部修复参数` 节点按“决策”类型渲染，语义上与工具执行节点区分

#### 影响文件
- src/agent/run-agent.ts
- src/tui/App.tsx

#### 验证
- 构建通过：`corepack pnpm build`。
- 全量回归通过：`corepack pnpm verify:p0`。

#### 待解决问题
- `llm_output` 当前仍以摘要形式展示；若需要审计级别追踪，可增加“展开查看完整原文”开关。

#### 下一步
- 可选增强：输出参数差异（diff）而不只完整 `repaired_args`，进一步提升排障效率。

### 2026-03-16 - Entry 052 - 重试链路可读性优化（主节点汇总 + 子节点细节）

#### 范围
优化重试可视化输出噪声，提升 DAG 阅读效率：主节点保留汇总，细节下沉到尝试/修复子节点。

#### 改动
- 主节点重试汇总口径统一：
  - `src/agent/run-agent.ts`
  - 将 `retry=x/y` 统一为 `retries=x/y`
  - 主节点仅保留简要原因摘要与 `args=updated|unchanged`
- 子节点细节长度收敛：
  - `src/agent/run-agent.ts`
  - `attempt` 与 `repair` 节点 detail 文本按 160 字符截断，减少刷屏噪声
- 主工具节点去重：
  - `src/weave/weave-plugin.ts`
  - `afterToolExecution` 在主节点仅输出 `ok|fail` 状态摘要，不再重复长结果
  - `summarizeText` 新增统一截断能力（默认 180）

#### 影响文件
- src/agent/run-agent.ts
- src/weave/weave-plugin.ts

#### 验证
- 构建通过：`corepack pnpm build`。
- 全量回归通过：`corepack pnpm verify:p0`。

#### 待解决问题
- 乱码文本源于命令执行 stderr 原文（终端编码差异），当前仅做截断不做转码归一。

#### 下一步
- 可选增强：对子节点 detail 增加“摘要/原文切换”开关，默认摘要，展开时查看完整原文。

### 2026-03-16 - Entry 051 - 重试全透明化：尝试节点/修复节点/重试生命周期事件

#### 范围
按“无黑盒”目标实现工具重试过程全透明：每次失败、局部修复、自动重试都以 DAG 子节点形式输出。

#### 改动
- 执行层暴露重试生命周期事件：
  - `src/agent/run-agent.ts`
  - 新增运行事件类型：`tool.retry.start`、`tool.retry.end`
  - 事件携带 `retryAttempt/retryMax/retryReason/retryPrepared` 等字段
- Weave DAG 子节点渲染数据源落地：
  - `src/agent/run-agent.ts`
  - 在工具节点下新增“尝试子节点”与“修复子节点”输出：
    - 尝试节点：`${toolNode}.1 / .3 / .5 ...`（running -> success/fail）
    - 修复节点：`${toolNode}.2 / .4 / .6 ...`（局部修复参数）
  - 每次尝试输出耗时与结果摘要；失败后输出失败原因；修复节点输出 `args=updated|unchanged`
  - 保留主工具节点最终态（`✔/✖`）不变，同时通过子节点完整展示重试链路
- Weave 事件发射能力增强：
  - `src/agent/run-agent.ts`
  - 新增直接发射 `weave.dag.node` / `weave.dag.detail` 的内部 helper，避免仅依赖协议层 detail 文本

#### 影响文件
- src/agent/run-agent.ts

#### 验证
- 构建通过：`corepack pnpm build`。
- 全量回归通过：`corepack pnpm verify:p0`。
- 预期可视化：工具失败后，主节点下可见失败尝试节点、修复节点与后续重试节点，不再是黑盒重试。

#### 待解决问题
- 目前重试子节点 ID 采用顺序编号策略，后续可升级为显式类型后缀（attempt/repair）并在 UI 侧提供更强语义渲染。

#### 下一步
- 可选增强：将 attempt/repair 子节点抽象为统一 "execution phase" 协议，复用到超时降级、fallback 工具链与人工接管节点。

### 2026-03-16 - Entry 050 - 重试标识未显示修复（DAG 事件节点 ID 对齐）

#### 范围
修复 `/weave auto` 下工具失败后未显示 `↻(x/y)` 的问题。

#### 改动
- 根因定位：
  - `run-agent.ts` 的重试 detail 事件使用 DAG 内部节点 ID（如 `tool-1-1`）。
  - TUI 渲染节点使用 Weave 语义节点 ID（如 `1.1`）。
  - 两者不一致导致 `weave:dag-detail` 无法命中对应节点，重试状态被丢弃。
- 修复方案：
  - `src/agent/run-agent.ts`
  - 工具节点 payload 新增 `displayNodeId`（格式 `step.index`，如 `1.1`）。
  - `intent/goal/retry` 的 detail 事件统一改为发往 `displayNodeId`。
  - 保持 DAG 内部节点 ID 与调度逻辑不变，仅修正展示事件 ID。

#### 影响文件
- src/agent/run-agent.ts

#### 验证
- 构建通过：`corepack pnpm build`。
- 全量回归通过：`corepack pnpm verify:p0`。
- 预期行为：工具失败且触发自动重试时，可在工具节点看到 `↻(x/y)`，最终再回落到 `✔/✖`。

#### 待解决问题
- legacy 路径仍未发出专用重试 detail（当前 weave 走 DAG，不影响主路径）。

#### 下一步
- 可选增强：为 legacy 路径补齐同结构重试事件，确保双路径展示一致。

### 2026-03-16 - Entry 049 - 工具节点重试状态可视化（retrying + 计数图标）

#### 范围
为工具节点自动重试增加独立可视状态：重试触发时显示 `↻(x/y)`，最终成功/失败分别回落为 `✔/✖`。

#### 改动
- 重试明细增强：
  - `src/agent/run-agent.ts`
  - 重试 detail 从 `retry=x` 调整为 `retry=x/y`，便于 UI 直接解析重试进度。
- TUI 状态树新增 retrying：
  - `src/tui/use-agent-state.ts`
  - `WeaveDagNodeItem.status` 扩展为 `running|waiting|retrying|success|fail`
  - 新增 `retryCurrent/retryMax` 字段
  - 监听 `weave.dag.detail` 时，识别 `retry=x/y` 并将节点切换为 `retrying`
  - 节点进入 `success/fail` 时自动清理重试计数
- DAG 渲染图标与配色增强：
  - `src/tui/App.tsx`
  - 新增 `retrying` 显示态与颜色
  - 图标函数支持 `↻(x/y)` 计数输出
  - 当前活动节点识别纳入 `retrying`，确保重试中节点持续高亮

#### 影响文件
- src/agent/run-agent.ts
- src/tui/use-agent-state.ts
- src/tui/App.tsx

#### 验证
- 构建通过：`corepack pnpm build`。
- 全量回归通过：`corepack pnpm verify:p0`。

#### 待解决问题
- 当前重试状态来自 detail 文本解析（`retry=x/y`），后续可升级为显式结构化事件字段，降低文本协议耦合。

#### 下一步
- 可选增强：将重试次数、重试原因和参数修复结果升级为单独的 `weave.dag.retry` 协议事件。

### 2026-03-16 - Entry 048 - Weave 模式扩展：observe/auto 接线与重试策略分层

#### 范围
继续后续阶段实现：将 `/weave on` 语义升级为 `/weave observe`（兼容别名），新增 `/weave auto` 并打通到执行层重试开关。

#### 改动
- 模式解析与语义扩展：
  - `src/tui/weave-mode.ts`
  - `WeaveMode` 扩展为 `off|observe|step|auto`
  - 支持 `/weave observe`、`/weave auto`，并将 `/weave on` 映射为 `observe`
  - 新增 `autoMode` 标记，供执行层透传
- 入口与交互链路透传：
  - `src/agent/message-dispatcher.ts`
  - `src/tui/App.tsx`
  - `src/index.ts`
  - 问答分发结构与 `runOnceStream` 选项新增 `autoMode`
  - TUI 系统提示文案区分 `STEP/AUTO/OBSERVE`
- 执行策略分层：
  - `src/runtime/runner-types.ts`
  - `src/agent/run-agent.ts`
  - `RunOnceStreamOptions` 新增 `autoMode?: boolean`
  - 将工具失败自动重试从“默认开启”调整为“仅 auto 模式开启”
  - `observe` 仅观察执行，不做自动参数修复重试
- 回归脚本对齐新语义：
  - `scripts/verify-dag-matrix.mjs`
  - 重试路径用例显式传入 `autoMode: true`

#### 影响文件
- src/tui/weave-mode.ts
- src/agent/message-dispatcher.ts
- src/runtime/runner-types.ts
- src/tui/App.tsx
- src/index.ts
- src/agent/run-agent.ts
- scripts/verify-dag-matrix.mjs

#### 验证
- 构建通过：`corepack pnpm build`。
- 全量回归通过：`corepack pnpm verify:p0`。

#### 待解决问题
- 当前 auto/observe 的差异主要体现在“失败自动修复重试”开关，后续可进一步补充更细粒度策略（例如不同工具的独立重试预算）。

#### 下一步
- 可选增强：为 `/weave status` 增加当前模式与关键策略（审批、重试）的汇总展示。

### 2026-03-16 - Entry 047 - 意图驱动工具调用与轻量重试链路落地

#### 范围
按阶段实现 LLM 单次调用复用、工具调用意图输出、工具失败轻量重试（最小上下文）与 TUI 节点意图展示。

#### 改动
- 抽取可复用 LLM 调用逻辑（执行层复用）：
  - `src/agent/run-agent.ts`
  - 新增统一方法：`invokeLlmWithTools`、`invokeLlmText`
  - DAG 主链路与 legacy 主链路统一改为调用该复用层
- 增加工具意图契约（节点级任务语义）：
  - `src/agent/run-agent.ts`
  - 在 LLM 生成 tool_call 后派生 `intentSummary/toolGoal`
  - 通过运行时元字段注入工具参数（仅展示与重试使用，执行前剥离）
- 增加工具失败轻量重试（最小上下文）：
  - `src/agent/run-agent.ts`
  - 重试上下文仅包含：`intent + previousArgs + lastResult`
  - 多次重试仅保留最近一次失败结果，避免 token 线性膨胀
  - 新增参数修复链路：`repairToolArgsByIntent`
- Weave 工具节点展示意图：
  - `src/weave/weave-plugin.ts`
  - 工具节点 detail 增加 `intent=` 与 `goal=` 行
- 验证脚本兼容更新：
  - `scripts/verify-step-gate.mjs`
  - `scripts/verify-dag-matrix.mjs`
  - mock 增加 `chat` 方法，兼容新复用调用层

#### 影响文件
- src/agent/run-agent.ts
- src/weave/weave-plugin.ts
- scripts/verify-step-gate.mjs
- scripts/verify-dag-matrix.mjs

#### 验证
- 构建通过：`corepack pnpm build`。
- 全量回归通过：`corepack pnpm verify:p0`。

#### 待解决问题
- 当前意图派生优先基于 assistant 文本与参数摘要，尚未引入独立强约束 schema 的意图输出。

#### 下一步
- 可选增强：为 tool intent 增加 JSON schema 校验与缺省意图重建策略。

### 2026-03-16 - Entry 046 - 执行节点显示收敛：当前节点强制可见并展开

#### 范围
按 WEAVE 节点渲染规则优化：每次执行选中当前节点并展示描述；当前节点完成后折叠并切换下一个；最后节点完成后保持展开。

#### 改动
- `src/tui/App.tsx`
  - 为 DAG 构建函数增加 `forceVisibleNodeIds` 参数。
  - 活动执行节点（running/waiting）加入强制可见集合，避免被低信号扁平化规则隐藏。
  - 执行期展开策略继续保持单节点展开，并与“强制可见”协同，确保当前执行节点可见且可展开。

#### 影响文件
- src/tui/App.tsx

#### 验证
- 构建通过：`corepack pnpm build`。
- 全量回归通过：`corepack pnpm verify:p0`。

#### 待解决问题
- 当前强制可见仅针对活动节点；如需审阅历史决策节点可考虑增加“临时展开历史节点”交互模式。

#### 下一步
- 如有需要，可增加“锁定当前节点展开”快捷键模式，避免手动展开与自动策略冲突。

### 2026-03-16 - Entry 045 - Weave 节点展开策略优化（执行期单节点展开）

#### 范围
优化 WEAVE DAG 节点显示逻辑：执行期间只展开当前节点，当前节点完成后立即折叠，最终仅展开并选中最后节点。

#### 改动
- `src/tui/App.tsx`
  - 移除可见节点变更时对展开集合的“保留式扩展”逻辑，避免历史节点持续展开。
  - 活动节点存在时，展开集合强制为 `{activeDagNodeId}`（单节点展开）。
  - 运行中但暂无活动节点时，临时折叠全部节点，防止旧节点残留展开。
  - 执行结束后，自动选中并仅展开最后一个节点。

#### 影响文件
- src/tui/App.tsx

#### 验证
- 构建通过：`corepack pnpm build`。
- 全量回归通过：`corepack pnpm verify:p0`。

#### 待解决问题
- 当前为自动折叠优先策略，若后续需要“手动锁定展开”需增加显式交互模式。

#### 下一步
- 如有需要，可新增开关：自动折叠模式 / 手动展开模式。

### 2026-03-16 - Entry 044 - 输入边界抖动深度修复（单行窗口 + 安全列余量）

#### 范围
针对“输入到终端边界且未完整显示时，新增字符导致输入框上下位移”的抖动问题做深度修复；保持现有布局样式与业务逻辑不变。

#### 改动
- `src/tui/App.tsx`
  - 新增输入显示复用函数：
    - `stringDisplayWidth`（统一显示列宽计算）
    - `buildInputDisplayText`（统一输入/占位渲染策略）
  - 输入区最大宽度计算增加 `inputSafeMargin=1` 安全余量，避免边界列触发终端换行抖动。
  - 输入渲染逻辑收敛到单入口，降低分支重复与维护复杂度。
  - 增加代码块注释，明确输入渲染策略与边界处理目的。

#### 影响文件
- src/tui/App.tsx

#### 验证
- 构建通过：`corepack pnpm build`。
- 全量回归通过：`corepack pnpm verify:p0`。

#### 待解决问题
- 个别终端在非常规字体渲染下仍可能存在极端 1 列偏差。

#### 下一步
- 若仍偶发抖动，可将安全余量做成可配置项（默认 1 列）。

### 2026-03-16 - Entry 043 - 输入溢出场景抖动修复（光标窗口按显示列裁剪）

#### 范围
修复“输入到终端末尾且输入内容已超出可见宽度时”的持续抖动问题，保持现有 TUI 布局与交互逻辑不变。

#### 改动
- `src/tui/App.tsx`
  - 将输入渲染裁剪从“按字符长度”改为“按终端显示列宽”裁剪。
  - 新增统一字符显示宽度函数，处理 CJK 宽字符与控制字符。
  - `renderInputWithCursor` 改为“始终保证光标可见”的显示窗口算法，避免边界处换行抖动。
  - `fitInputPreview` 同步改为显示列宽裁剪，避免 placeholder 在边界抖动。

#### 影响文件
- src/tui/App.tsx

#### 验证
- 构建通过：`corepack pnpm build`。
- 全量回归通过：`corepack pnpm verify:p0`。

#### 待解决问题
- 个别终端在特殊字体下对少数字符宽度定义可能与 East Asian Width 规则存在偏差。

#### 下一步
- 如仍存在极端边界抖动，可增加 1 列安全余量开关（默认关闭）。

### 2026-03-16 - Entry 042 - Weave 输出质量修复：乱码治理 + 节点折叠策略统一

#### 范围
修复工具输出乱码与节点详情截断问题，并将 WEAVE 模式节点执行过程的展开/折叠行为统一为通用规则。

#### 改动
- 命令输出乱码治理：
  - `src/tools/builtins/command-exec-tool.ts`
  - Windows 下输出解码从单一 `gbk` 兜底改为 `gb18030 -> gbk` 逐级尝试，降低 mojibake 概率。
- 节点详情截断修复：
  - `src/weave/weave-plugin.ts`
  - 取消 `summarizeText` 的 120 字符截断，保留完整节点描述输出。
- WEAVE 节点交互策略统一：
  - `src/tui/App.tsx`
  - 执行中：自动选中并展开当前运行/等待节点。
  - 节点切换：自动折叠前一个活动节点。
  - 执行完成：自动选中最后一个节点并仅展开该节点（通常为最终结果节点）。

#### 影响文件
- src/tools/builtins/command-exec-tool.ts
- src/weave/weave-plugin.ts
- src/tui/App.tsx

#### 验证
- 构建通过：`corepack pnpm build`。
- 全量回归通过：`corepack pnpm verify:p0`。

#### 待解决问题
- 某些终端环境若底层编码配置异常，仍可能出现个别命令输出编码不一致问题。

#### 下一步
- 如需更强稳定性，可增加“命令执行壳层环境探测 + 编码健康检查”预检。

### 2026-03-16 - Entry 041 - 输入行尾抖动修复（显示列宽对齐）

#### 范围
修复“仅在输入到终端行尾后继续输入时发生抖动”的问题，保持 TUI 布局样式不变。

#### 改动
- `src/tui/App.tsx`
  - 新增显示列宽估算函数 `estimateDisplayWidth`，用于按终端列宽计算文本占位。
  - 输入区最大可显示长度改为基于“输入框实际内宽 - 前缀显示宽度”动态计算。
  - 统一复用 `inputPrefix`，避免前缀宽度与内容宽度估算不一致。
- 保留之前去抖改动：
  - `src/tui/use-agent-state.ts` 节点与 detail 重复事件去重，降低高频重渲染。

#### 影响文件
- src/tui/App.tsx
- src/tui/use-agent-state.ts
- docs/project/development-progress.md

#### 验证
- 构建通过：`corepack pnpm build`。
- 全量回归通过：`corepack pnpm verify:p0`。

#### 待解决问题
- 若终端字体对某些符号宽度计算与标准 East Asian Width 不一致，极端情况下仍可能出现 1 列级别偏差。

#### 下一步
- 如有需要，可进一步将输入渲染切换为“显式截断模式（truncate-end）+ 固定列容器”做兜底。

### 2026-03-16 - Entry 040 - TUI 去抖优化（不改布局样式）

#### 范围
在保持现有 TUI 布局与视觉样式不变的前提下，仅消除导致画面抖动/跳动的冗余状态更新。

#### 改动
- 去重 DAG 节点重复更新：
  - `src/tui/use-agent-state.ts`
  - 当 `nodeId` 对应的 `parentId/label/status` 未变化时，不再重复写入 `updatedAtMs` 与状态对象。
- 去重 DAG 明细重复更新：
  - `src/tui/use-agent-state.ts`
  - 当连续 detail 文本相同，不再追加，避免无意义重渲染。
- 去除运行期自动焦点追逐导致的视图跳动：
  - `src/tui/App.tsx`
  - DAG 节点选中与展开状态不再在 runActive 期间强制跳到最新节点，改为“仅在当前选中失效时回落到最新”。
  - 移除重复排序调用，保持可见节点顺序稳定来源单一。

#### 影响文件
- src/tui/use-agent-state.ts
- src/tui/App.tsx

#### 验证
- 构建通过：`corepack pnpm build`。
- 全量回归通过：`corepack pnpm verify:p0`。

#### 待解决问题
- 当前尚未引入专门的帧级节流策略（如 16~33ms 批量合并更新），极高事件密度下仍可能出现轻微刷新感。

#### 下一步
- 如需进一步平滑，可增加“事件批处理 + 帧节流”开关，但默认保持当前轻量实现。

### 2026-03-16 - Entry 039 - 新增内置文件写入工具 write_file

#### 范围
新增符合 Agent 工具接入规范的文件写入工具，并接入默认内置工具注册。

#### 改动
- 新增工具实现：
  - `src/tools/builtins/write-file-tool.ts`
  - 工具名：`write_file`
  - 支持参数：`filePath`、`content`、`mode(overwrite|append)`、`createDirs`
  - 安全约束：限制写入目标必须位于工作区目录内
  - 可用性：目录不存在时支持自动创建（默认开启）
- 工具注册接入：
  - `src/tools/builtins/index.ts` 增加 `writeFileTool`
- 架构文档同步：
  - `docs/project/architecture-and-files.md` 增加 write_file 说明

#### 影响文件
- src/tools/builtins/write-file-tool.ts
- src/tools/builtins/index.ts
- docs/project/architecture-and-files.md

#### 验证
- 构建通过：`corepack pnpm build`。
- P0 回归通过：`corepack pnpm verify:p0`。

#### 待解决问题
- 目前写入工具为文本写入能力，尚未支持结构化 patch 写入与并发冲突检测。

#### 下一步
- 增加写入前摘要与差异预览能力，降低误写风险。

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

### 2026-03-22 - Entry 033 - Web 输入到网关 start.run 第一阶段打通

#### 范围
实现“前端输入框 -> WS RPC(start.run) -> 网关响应 runId”的最小闭环，作为后续接入 Orchestrator/WorkerPool 的第一步。

#### 改动
- 协议层：
  - `apps/shared/graph-protocol.ts` 新增 `StartRunPayload`、`StartRunResponsePayload`。
  - `ClientMessageEnvelope.type` 扩展支持 `start.run` / `run.abort` / `run.subscribe`（先定义协议，后续逐步落实现）。
- 前端层：
  - `Incarnation.tsx` 升级为异步提交，提交失败时恢复过渡态并显示错误信息。
  - `App.tsx` 在 Summon 时发送 `start.run`，收到成功响应后再进入 DAG 画布。
  - 新增本地 `sessionId` 复用策略（localStorage），并附带 `clientRequestId`。
- 网关层：
  - `ws-gateway.ts` 新增 `start.run` RPC 处理，返回 `runId/sessionId/acceptedAt`。
  - 第一阶段占位广播 `run.start` 事件，便于前端链路联调和可观测。

#### 影响文件
- apps/shared/graph-protocol.ts
- apps/weave-graph-web/src/types/graph-events.ts
- apps/weave-graph-web/src/components/Incarnation.tsx
- apps/weave-graph-web/src/App.tsx
- apps/weave-graph-server/src/protocol/graph-events.ts
- apps/weave-graph-server/src/gateway/ws-gateway.ts

#### 验证
- 计划执行：
  - `pnpm --filter weave-graph-web build`
  - `pnpm --filter weave-graph-server build`
  - `pnpm build`
  - `pnpm verify:step-gate`
  - `pnpm verify:dag-matrix`

#### 待解决问题
- 当前 `start.run` 仍是网关占位处理，尚未进入真实 `AgentRuntime` 执行链路。
- 事件游标（`lastEventId`）与增量回放尚未落地，本轮仅完成提交入口。

#### 下一步
实现网关命令路由与 RuntimeBridge：将 `start.run` 接到 Orchestrator/Worker，并引入 `eventId + seqId` 游标体系。

### 2026-03-22 - Entry 034 - 网关游标回放与会话互斥（第二阶段）

#### 范围
在不改动 Runtime 内核的前提下，完成网关级“事件游标回放 + 同 Session Fast-Fail + run.abort 释放占用”的关键能力。

#### 改动
- 协议层：
  - `GraphEnvelope` 增加 `eventId` 字段，作为前端去重与断线重放游标。
  - 新增 `run.subscribe` / `run.abort` 的请求与响应负载类型。
  - 新增标准 RPC 错误码：`AGENT_BUSY`、`RUN_NOT_FOUND`、`ABORT_NOT_ALLOWED`、`RESYNC_REQUIRED`、`INVALID_ARGUMENT`。
- 网关层：
  - 新增 `eventsByRunId` 回放缓存（Ring Buffer 思路）与 `runMetaByRunId` 状态表。
  - `start.run` 增加同 session 快速失败：若已有运行中任务直接返回 `AGENT_BUSY`。
  - 新增 `run.subscribe(runId, lastEventId)` 增量补发逻辑。
  - 新增 `run.abort(runId)` 终止逻辑：广播 `run.end` 并释放 session 占用。
  - `publish` 统一标准化 `eventId`，并在 `run.end` 时回收会话占用。
- 前端层：
  - `graph-store` 增加 `eventId` 去重与 `lastEventId` 记录，避免回放重复渲染。
  - `resolveRpc` 透传错误码，支持前端识别 `AGENT_BUSY`。
  - `App.tsx` 在 `start.run` 成功后立即执行 `run.subscribe`，并对 `AGENT_BUSY` 输出友好提示。

#### 影响文件
- apps/shared/graph-protocol.ts
- apps/weave-graph-server/src/protocol/graph-events.ts
- apps/weave-graph-server/src/projection/graph-projector.ts
- apps/weave-graph-server/src/gateway/ws-gateway.ts
- apps/weave-graph-web/src/types/graph-events.ts
- apps/weave-graph-web/src/store/graph-store.ts
- apps/weave-graph-web/src/App.tsx

#### 验证
- 计划执行：
  - `pnpm --filter weave-graph-web build`
  - `pnpm --filter weave-graph-server build`
  - 网关 WS 脚本验证：`start.run` / `run.subscribe` / `run.abort` 三命令链路
- 实际结果：
  - `pnpm --filter weave-graph-web build` 通过。
  - `pnpm --filter weave-graph-server build` 通过。
  - `pnpm --filter weave-graph-server verify:gateway-rpc` 通过，输出 `Gateway RPC verification passed.`。
  - 验证脚本已补强游标语义断言：`replayedCountBeforeAbort=0`、`replayedCountAfterAbort=1`，确认 `lastEventId` 后的增量回放生效。

#### 待解决问题
- `run.abort` 当前为网关层状态中断，尚未接入 Runtime 的 AbortController 深透传。
- `run.subscribe` 当前回放来源为内存缓冲，WAL 回放降级尚未落地。

#### 下一步
引入 RuntimeBridge 与 RunRegistry，将 `run.abort` 绑定到真实 worker 信号中断，并补上 WAL 回放降级路径。

### 2026-03-22 - Entry 2026-03-22-A - RuntimeBridge 与 RunRegistry 装配落地（第三阶段）

#### 范围
在 graph-server 内完成“网关命令层 -> 运行时桥接层”的可替换装配，消除网关与执行逻辑的强耦合，为后续接入真实 AgentRuntime 打基础。

#### 改动
- 网关层解耦：
  - `ws-gateway.ts` 引入 `RunRegistry`，统一管理 session 占用与 run 状态迁移。
  - 新增 `registerRunCommandHandlers`，支持注入 `startRun/abortRun` 处理器。
  - 保留无处理器回退路径（兼容现有验证脚本与联调方式）。
- 运行时桥接层：
  - 新增 `src/runtime/runtime-bridge.ts`，定义 `RuntimeBridge` 接口与 `LocalRuntimeBridge` 本地实现。
  - `LocalRuntimeBridge` 当前以定时器模拟运行完成与中止事件，事件统一回调到 `GraphProjector`。
- 服务装配层：
  - `index.ts` 装配 `LocalRuntimeBridge`，将 `start.run/run.abort` 从网关逻辑下沉到桥接处理器。
  - 移除入口 demo 事件注入，改为由运行命令驱动真实事件流。

#### 影响文件
- apps/weave-graph-server/src/runtime/run-registry.ts
- apps/weave-graph-server/src/runtime/runtime-bridge.ts
- apps/weave-graph-server/src/gateway/ws-gateway.ts
- apps/weave-graph-server/src/index.ts

#### 验证
- `pnpm --filter weave-graph-server build` 通过。
- `pnpm --filter weave-graph-server verify:gateway-rpc` 通过。
  - 输出：`replayedCountBeforeAbort=0`、`replayedCountAfterAbort=1`。
- `pnpm --filter weave-graph-web build` 通过。

#### 待解决问题
- 当前 `LocalRuntimeBridge` 仍是占位执行器，尚未接入真实 `AgentRuntime.runOnceStream`。
- `run.abort` 尚未贯穿到真实 LLM/tool 执行取消链路（AbortController 深透传）。

#### 下一步
以 `RuntimeBridge` 接口为边界接入真实 AgentRuntime 实现，落地 `RunRegistry + AbortController` 的物理级中断，并补齐 WAL 回放降级路径。

### 2026-03-22 - Entry 2026-03-22-B - 真实 AgentRuntime 桥接与中断透传（第四阶段）

#### 范围
将 graph-server 的桥接层从“仅本地占位执行器”升级为“优先接入真实 AgentRuntime，失败自动回退本地桥接”，并补齐 run 级 AbortSignal 透传链路。

#### 改动
- Runtime 桥接：
  - `apps/weave-graph-server/src/runtime/runtime-bridge.ts` 新增自动桥接工厂 `createRuntimeBridge`。
  - 优先动态加载主工程 `AgentRuntime + loadLlmConfig + ToolRegistry + builtinTools`，创建 `AgentRuntimeBridge`。
  - 若动态加载失败，自动回退到 `LocalRuntimeBridge`（不中断开发联调）。
- 中断透传：
  - `src/engine/runner-types.ts` 的 `RunOnceStreamOptions` 新增 `abortSignal`。
  - `src/agent/run-agent.ts` 在 DAG 执行层监听外部 `abortSignal`，桥接到内部 `AbortController`。
  - `src/session/run-context.ts` 补充 `bus` 字段类型，修复 StepGate 拦截器对 `ctx.bus` 的静态类型依赖。
- 回归修复：
  - `src/engine/engine-types.ts` 恢复 `snapshotStore?: SnapshotStore`，修复根工程构建错误。
  - `src/nodes/tool-node.ts` 恢复 `tool.execution.start/end` 事件发射，修复 StepGate 与 DAG 矩阵脚本断言。

#### 影响文件
- apps/weave-graph-server/src/runtime/runtime-bridge.ts
- apps/weave-graph-server/src/index.ts
- src/engine/runner-types.ts
- src/agent/run-agent.ts
- src/session/run-context.ts
- src/engine/engine-types.ts
- src/nodes/tool-node.ts

#### 验证
- 网关与前端：
  - `pnpm --filter weave-graph-server verify:gateway-rpc` 通过。
  - 输出：`replayedCountBeforeAbort=0`、`replayedCountAfterAbort=1`。
  - `pnpm --filter weave-graph-web build` 通过。
- 根工程回归：
  - `pnpm build` 通过。
  - `pnpm verify:step-gate` 通过。
  - `pnpm verify:dag-matrix` 通过。

#### 待解决问题
- 真实 LLM 请求层尚未将 `AbortSignal` 透传到 OpenAI SDK 调用参数，当前为引擎层中断优先。
- `run.subscribe` 仍以内存回放为主，WAL 回放降级待补齐。

#### 下一步
将 `AbortSignal` 继续下探到 QwenClient/OpenAI create 调用，并补齐 WAL 回放降级路径与 `RESYNC_REQUIRED` 语义。

### 2026-03-22 - Entry 2026-03-22-C - WAL 回放降级与游标失效兜底（第五阶段）

#### 范围
在网关订阅链路落地“内存 RingBuffer -> WAL 重建回放 -> `RESYNC_REQUIRED`”三级策略，消除仅靠内存缓存的回放脆弱性。

#### 改动
- 网关订阅策略升级：
  - `apps/weave-graph-server/src/gateway/ws-gateway.ts`
  - `run.subscribe` 改为优先命中内存缓存；若缓存缺失或游标不在缓存中，则调用回放处理器进行 WAL 降级重建。
  - 若提供 `lastEventId` 且在内存与 WAL 回放结果中均不存在，则返回 `RESYNC_REQUIRED`，要求客户端做全量重订阅。
- 运行桥接扩展：
  - `apps/weave-graph-server/src/runtime/runtime-bridge.ts`
  - `RuntimeBridge` 新增可选能力 `loadRunEvents(runId)`，用于从 WAL 加载 run 级原始事件。
  - `AgentRuntimeBridge` 动态装配 `WeaveDb + WalDao`，实现 `getExecutionWalEvents` 读取。
  - 动态加载策略升级为 `dist/*.js` 优先、`src/*.ts` 回退，提升在 `node dist` 与 `tsx src` 两种启动模式下命中真实桥接的稳定性。
  - `LocalRuntimeBridge` 返回 `null`（无 WAL 能力），保持本地占位行为兼容。
- 服务端装配：
  - `apps/weave-graph-server/src/index.ts`
  - 新增 `replayRunEvents` 处理器：调用 `runtimeBridge.loadRunEvents` 取原始事件，再用独立 `GraphProjector` 重建图事件序列。
- 自动化验证增强：
  - `apps/weave-graph-server/scripts/verify-gateway-rpc.mjs`
  - 增加“无效游标必须返回 `RESYNC_REQUIRED`”断言。

#### 影响文件
- apps/weave-graph-server/src/gateway/ws-gateway.ts
- apps/weave-graph-server/src/runtime/runtime-bridge.ts
- apps/weave-graph-server/src/index.ts
- apps/weave-graph-server/scripts/verify-gateway-rpc.mjs

#### 验证
- `pnpm --filter weave-graph-server build` 通过。
- `pnpm --filter weave-graph-server verify:gateway-rpc` 通过。
  - 关键输出：`invalidCursorCode: 'RESYNC_REQUIRED'`。
- `pnpm --filter weave-graph-web build` 通过。
- `pnpm verify:step-gate` 通过。
- `pnpm verify:dag-matrix` 通过。

#### 待解决问题
- WAL 事件 `payload` 目前按 `JSON.parse` 解析；复杂循环引用对象在极端场景下仍建议切换到与写入端一致的反序列化策略。
- 客户端尚未实现收到 `RESYNC_REQUIRED` 后自动清空本地游标并重订阅的恢复流程。

#### 下一步
实现前端 `RESYNC_REQUIRED` 自动恢复：清理本地 `lastEventId/seenEventIds` 后发起无游标 `run.subscribe`，并补充断线重连集成用例。

### 2026-03-22 - Entry 2026-03-22-D - 前端 RESYNC_REQUIRED 自动恢复（第六阶段）

#### 范围
在 Web 客户端落地 `RESYNC_REQUIRED` 自动恢复逻辑，确保游标失效后无需手工刷新即可恢复订阅。

#### 改动
- 状态层自动恢复：
  - `apps/weave-graph-web/src/store/graph-store.ts`
  - 扩展 pending RPC 记录，保存 `type/payload` 元信息用于恢复判断。
  - 在 `resolveRpc` 中识别 `run.subscribe + RESYNC_REQUIRED`：
    - 调用 `resetRunForResync(runId)` 清理本地游标与该 run 图状态；
    - 自动重发无 `lastEventId` 的 `run.subscribe`；
    - 将原 Promise 的 `resolve/reject` 透传给重试请求，保持调用方无感。
- 新增状态恢复动作：
  - `resetRunForResync(runId)` 重置 `lastEventId/seenEventIds/latestSeq`，并清空该 run 的节点与边，避免全量重放时产生增量重复。

#### 影响文件
- apps/weave-graph-web/src/store/graph-store.ts

#### 验证
- `pnpm --filter weave-graph-web build` 通过。
- `pnpm --filter weave-graph-server verify:gateway-rpc` 通过（含 `invalidCursorCode: 'RESYNC_REQUIRED'`）。

#### 待解决问题
- 当前自动恢复覆盖 `run.subscribe` 的游标失效场景；断网重连后的自动重订阅调度（按活跃 run 批量恢复）仍需补完。
- 尚缺浏览器侧集成测试脚本验证“服务端重启 + 客户端自动恢复”完整路径。

#### 下一步
补充断网/服务重启场景的自动重订阅管理器，并增加端到端恢复用例（至少覆盖 active run 与 completed run 两类）。

### 2026-03-22 - Entry 2026-03-22-E - WebSocket 自动重连与已知 Run 重订阅（第七阶段）

#### 范围
补齐浏览器侧断线恢复主链路：WS 自动重连 + 已知 run 批量重订阅，提升服务重启与短时断网后的恢复能力。

#### 改动
- WebSocket 生命周期升级：
  - `apps/weave-graph-web/src/App.tsx`
  - 将单次连接改为可重连模型，支持指数退避（上限 5s）。
  - `onopen` 后自动触发 run 重订阅流程。
- 批量重订阅：
  - 基于 store 中现有 `dags` 计算每个 `runId` 的最新游标，逐个发送 `run.subscribe(runId,lastEventId)`。
  - 若单 run 重订阅失败，按警告处理，不阻断其他 run 的恢复。
- 与 `RESYNC_REQUIRED` 自动恢复联动：
  - 重订阅若命中游标失效，将由 `graph-store.ts` 中的自动恢复机制继续执行“清理本地状态 + 无游标重订阅”。

#### 影响文件
- apps/weave-graph-web/src/App.tsx

#### 验证
- `pnpm --filter weave-graph-web build` 通过。
- `pnpm --filter weave-graph-server verify:gateway-rpc` 通过。

#### 待解决问题
- 尚缺浏览器端自动化场景测试（例如 Playwright）来验证“网关重启后自动恢复”的真实交互路径。
- 当前重订阅是串行执行；当 run 数量较多时可优化为受控并发。

#### 下一步
补充 Web 端恢复场景自动化测试，并将批量重订阅优化为受控并发（例如并发度 3~5）。

### 2026-03-22 - Entry 2026-03-22-F - 恢复链路性能优化（第八阶段）

#### 范围
优化断线恢复时的请求可靠性与恢复吞吐：补齐 WS 断线期间 RPC 缓存发送能力，并将重订阅改为受控并发。

#### 改动
- 出站 RPC 队列：
  - `apps/weave-graph-web/src/App.tsx`
  - 新增 `outboundQueueRef`，当 WS 非 `OPEN` 状态时暂存 RPC 信封。
  - 连接恢复后 `flushOutboundQueue()` 自动发送积压请求，避免请求因瞬断直接丢失。
  - 队列设置上限 300，防止异常网络下无限增长。
- 重订阅并发优化：
  - 将重连后的 `run.subscribe` 从串行改为受控并发（并发度 4）。
  - 单 run 失败仅告警，不中断其他 run 的恢复流程。

#### 影响文件
- apps/weave-graph-web/src/App.tsx

#### 验证
- `pnpm --filter weave-graph-web build` 通过。
- `pnpm --filter weave-graph-server verify:gateway-rpc` 通过。

#### 待解决问题
- RPC 队列目前仅内存态，浏览器刷新后不会保留（属于可接受的短瞬断优化，不是离线持久队列）。
- 尚缺针对“队列积压后重连自动 flush”与“并发重订阅成功率”的自动化场景测试。

#### 下一步
补充 Web 端恢复链路自动化测试（含队列 flush 与并发重订阅场景），并评估是否需要持久化队列策略。

### 2026-03-22 - Entry 2026-03-22-G - 离线队列可靠性修复（第九阶段）

#### 范围
修复离线排队下 RPC 计时过早导致的误超时问题，并补齐队列淘汰/销毁场景的显式失败回传。

#### 改动
- RPC 超时策略修复：
  - `apps/weave-graph-web/src/store/graph-store.ts`
  - 新增 `markRpcDispatched(reqId)`：仅在请求真正写入 WS 后启动超时计时。
  - `sendRpc` 不再创建“排队即开始”的超时，避免重连前误判超时。
- 主动取消能力：
  - 新增 `cancelRpcRequest(reqId, reason)`，用于队列溢出或页面销毁时显式 reject 对应 Promise。
- App 发送链路对齐：
  - `apps/weave-graph-web/src/App.tsx`
  - 立即发送与队列 flush 后均调用 `markRpcDispatched`。
  - 队列超限丢弃时逐条 `cancelRpcRequest("RPC queue overflow")`。
  - 组件销毁时取消尚未发送的队列请求，避免 Promise 悬挂。

#### 影响文件
- apps/weave-graph-web/src/store/graph-store.ts
- apps/weave-graph-web/src/App.tsx

#### 验证
- `pnpm --filter weave-graph-web build` 通过。
- `get_errors` 检查 `App.tsx` 与 `graph-store.ts` 均无错误。

#### 待解决问题
- 仍缺“离线排队 -> 重连 flush -> 超时行为”自动化测试覆盖。
- 仍缺“队列溢出触发 cancel”自动化断言。

#### 下一步
新增 Web 恢复链路自动化测试，优先覆盖：排队后重连成功、排队后溢出取消、未发送请求不应提前超时。

### 2026-03-22 - Entry 2026-03-22-H - 恢复链路自动化验证脚本（第十阶段）

#### 范围
将恢复主链路关键逻辑抽离为纯函数并接入自动化验证脚本，降低后续重构引入回归的风险。

#### 改动
- 抽离可测试恢复工具：
  - `apps/weave-graph-web/src/lib/recovery-utils.ts`
  - 提供 `buildRunSubscribePlan`、`enqueueWithLimit`、`flushQueue`、`runWithConcurrency`。
- 前端主流程接入：
  - `apps/weave-graph-web/src/App.tsx`
  - 重连重订阅、离线队列入队、队列刷空逻辑改为复用 `recovery-utils`。
- 新增验证脚本：
  - `scripts/verify-graph-recovery.ts`
  - 覆盖 run 去重游标选择、队列上限淘汰、FIFO flush、并发上限不超限。
- 命令接入：
  - `package.json` 新增 `verify:graph-recovery`。

#### 影响文件
- apps/weave-graph-web/src/lib/recovery-utils.ts
- apps/weave-graph-web/src/App.tsx
- scripts/verify-graph-recovery.ts
- package.json

#### 验证
- `pnpm verify:graph-recovery` 通过。
- `pnpm --filter weave-graph-web build` 通过。
- `get_errors` 对新增/修改文件检查均无错误。

#### 待解决问题
- 当前验证聚焦纯函数与集成构建；尚缺“真实 WS 断连-重连”浏览器级端到端场景自动化。

#### 下一步
补充浏览器端恢复 E2E 用例（模拟网关重启与断网抖动），将恢复链路验证从逻辑级提升到交互级。
