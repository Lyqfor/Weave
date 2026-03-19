# Dagent 开发日志

本文件记录每次任务完成后的变更摘要，目标是：阅读本日志即可了解**做了什么、为什么这样做**。

---

## 2026-03-19 · Entry 008 · 三层解耦 v2 — IEngineEventBus + DagGraph 广播站

### 变更范围
- `src/runtime/engine-event-bus.ts`（新建 — Layer 1 接口）
- `src/runtime/dag-graph.ts`（注入广播站 + 4 处 AOP 拦截）
- `src/runtime/nodes/base-node.ts`（消除 agent/ 层级违规 import）
- `src/runtime/dag-executor.ts`（消除 agent/ import，内联调度器事件）
- `src/runtime/nodes/llm-node.ts`（去 import，frozenPayload 传参）
- `src/runtime/nodes/tool-node.ts`（frozenPayload 传参）
- `src/agent/run-agent.ts`（IEngineEventBus 适配器 + InputNode 接入）
- `src/event/event-types.ts`（新增 engine.* 事件类型）
- `apps/weave-graph-server/src/projection/graph-projector.ts`（处理 engine.* 事件）
- 删除 `src/agent/weave-emitter.ts`、`src/weave/weave-plugin.ts`
- 清理 `src/index.ts`、`src/tui/App.tsx`（移除 WeavePlugin 引用）

### 做了什么
- **新建 `IEngineEventBus` 接口**（Layer 1 纯接口，零外部依赖）：`onNodeCreated/onEdgeCreated/onDataEdgeCreated/onNodeTransition/onSchedulerIssue`
- **DagGraph 成为广播站**：`addNode/addEdge/addDataEdge/transitionStatus` 四处自动调用 engineEventBus，业务节点零感知
- **消除层级违规**：`base-node.ts` 删除 `import weave-emitter`，`dag-executor.ts` 删除 `import weave-emitter`，runtime/ 目录实现对 agent/ 的零依赖
- **frozenPayload 随节点创建广播**：`addNode(node, snapshot)` 同时传入初始快照，状态流转时携带最新快照（Inspector 面板实时更新）
- **InputNode 进入 DAG**：run-agent.ts 在 llm-1 前添加 input 终态节点，input → llm-1 依赖边由 DAG 自动广播
- **Layer 3 适配器**：run-agent.ts 内联创建 `IEngineEventBus` 实现，桥接到 WeaveEventBus 的 engine.* 事件
- **graph-projector 支持 engine.* 事件**：新增 5 个 case 处理 engine 直发事件，生成 node.upsert/node.status/node.io/edge.upsert 图协议事件
- **删除 585 行冗余代码**：weave-emitter.ts 和 weave-plugin.ts 全部删除

### 为什么这样做
三处根本问题：（1）base-node.ts 反向 import agent/（Layer 1→Layer 3 污染）；（2）WeavePlugin 维护平行影子节点树（状态撕裂）；（3）可视化事件控制权散落各处（漏发幽灵节点）。正确架构是 DagGraph 作为广播站，AOP 拦截 addNode/transitionStatus 自动发射引擎事件。

### 关键决策
- **IEngineEventBus 而非 dispatchPluginOutput**：引擎不应知道"插件"概念，`onNodeCreated` 语义纯净；Layer 3 通过依赖反转注入实现
- **`engine.*` 前缀**：与旧 `weave.*` 前缀区分，语义准确（这是引擎层事件，不是 Weave 插件观察结果）
- **终态节点 addNode 不影响调度**：`getReadyNodeIds()` 只关注 pending/ready 状态，InputNode(success) 自然不被调度，但 llm-1 依赖它满足后立即就绪

---

## 2026-03-19 · Entry 007 · Weave 框架三层解耦架构 — Template Method + IoC + Event Sourcing

### 变更范围
- `src/runtime/nodes/base-node.ts`（核心重构）
- `src/runtime/nodes/tool-node.ts`（大幅简化）
- `src/runtime/nodes/llm-node.ts`（适配 doExecute + try/finally）
- `src/runtime/nodes/final-node.ts`（适配 doExecute）
- `src/runtime/dag-executor.ts`（Promise.all 熔断 + AbortController）
- `src/runtime/dag-graph.ts`（状态机扩展 ready→blocked/fail）
- `src/runtime/snapshot-store.ts`（新建）
- `src/session/run-context.ts`（扩展 AbortController/Interceptor/SnapshotStore）
- `src/agent/run-agent.ts`（RunContext 注入新字段）
- `src/event/event-types.ts`（新增 node.validation_error 事件）
- `src/weave/interceptor.ts`（新建 INodeInterceptor 接口）
- `src/weave/pending-promise-registry.ts`（新建挂起字典）
- `src/weave/step-gate-interceptor.ts`（新建 Step Gate 拦截器）

### 做了什么
- **Phase 1 — 模板状态机**：BaseNode.execute() 重构为 Template Method，统一控制流（ready → interceptor → running → doExecute → success/fail）。子类 ToolNode/LlmNode/FinalNode 改为实现 doExecute()，只能 return 或 throw
- **Phase 2 — AbortController 全局熔断**：RunContext 注入 AbortController + AbortSignal，dag-executor 改用 Promise.all 毫秒级熔断 + 悬空 Promise .catch 防御
- **Phase 3 — 拦截器基础设施**：INodeInterceptor 接口（双轨制：Plugin=观察者，Interceptor=控制者）+ PendingPromiseRegistry（超时保护 + rejectAll）+ StepGateInterceptor（从 ToolNode 抽出）
- **Phase 4 — 快照存储层**：SnapshotStore（同步冻结 + 异步装配 + 内存水位线 + JSONL 落盘），BaseNode 新增 freezeSnapshot/hydrateSnapshot/emitSnapshot
- **七大铁律落地**：while 循环替代递归、switch 穷举 + default 拦截、try/finally Plugin 闭合、节点失败不 re-throw（DAG 继续）、AbortError 才触发全局熔断
- **DAG 状态机扩展**：ready → blocked（拦截器拦截）和 ready → fail（拦截异常）新增为合法转换

### 为什么这样做
ToolNode.execute() 原有 ~350 行承担过多职责（Step Gate 审批 + 状态流转 + 重试链 + Plugin 钩子 + 业务执行），为后续拦截执行、节点回溯、分叉重跑等高级功能铺路，需要通过三层解耦降低复杂度

### 关键决策
- **业务失败不 re-throw**：doExecute throw 后 BaseNode 标记 fail 但不传播错误，DAG 继续执行下游节点（否则工具超时会杀死整个 DAG）
- **StepGateInterceptor 双模式**：有 approveToolCall 回调时走 TUI 直调，无回调时走 PendingPromiseRegistry 挂起（保持测试和 TUI 向后兼容）
- **ready → blocked 状态转换**：拦截器在执行前拦截节点的语义需要从 ready 直达 blocked，而非先 running 再 blocked

---

## 2026-03-18 · Entry 006 · weave-graph-web UI 精修 Round 2 — 曜石黑主题五大致命元凶消除

### 变更范围
- `apps/weave-graph-web/src/nodes/semantic-node.tsx`
- `apps/weave-graph-web/src/app.css`
- `apps/weave-graph-web/src/App.tsx`
- `apps/weave-graph-web/src/edges/FlowEdge.tsx`

### 做了什么
- **全局色彩系统重置**：背景从蓝紫色温（`#0a0d14`）切换至曜石黑（`#09090b` Zinc-950），边框/文字全部去蓝调，对标 Radix UI / shadcn / Vercel 新版深色主题
- **删除节点卡片顶部实心色条**（topBarStyle），左侧竖线按状态分级 opacity（success 0.7 / fail 0.75 / skipped 0.35）
- **卡片玻璃感增强**：背景透明度 0.96→0.65，模糊量 14px→12px
- **Inspector 端口徽章幽灵化**：彩色徽章改为统一灰色幽灵标签，复制按钮默认 `opacity:0 + pointer-events:none`，hover 才浮现
- **success 连线降调**：60%→22% 绿色，running strokeWidth 2→1.7
- **success/fail 节点卡片微弱光晕**（12% 强度），边框保持暗色不变
- **status-badge 改为完全圆角胶囊**（border-radius: 20px）
- **Canvas 空状态品牌化**：WEAVE 大字 + 副标题 + 正弦波呼吸光标（丢弃 step-end DOS 风格）
- **环境氛围光**：钛灰高光（左上）+ 微琥珀暖光（右下），零蓝紫污染
- **节点 hover 光学浮起**：禁止 transform（防 SVG Edge Jitter），纯阴影深化制造悬浮感
- **选中节点 Vercel 级镂空双环**：outline + outline-offset: 3px，黑边间隙高级感
- **hover 节点 z-index: 1000** 置顶，32px 阴影不被相邻节点遮挡
- **FlowEdge curvature 0.25→0.35**，连线更流体
- **Fitts 定律热区扩大**：幽灵按钮 padding:6px + margin:-6px，点击不再"点空"

### 为什么这样做
Entry 005 完成了整体框架，但五大问题（顶部色条塑料感、徽章颜色噪音、success 线过亮、成功徽章粗糙、画布缺乏品牌感）持续影响观感。用户风格方向也从蓝紫色温明确转向曜石黑中性风，本次精修以此为主线全面补完。

### 关键决策
- 卡片绝不用 `translateY` hover（否则 React Flow SVG 连线锚点偏移产生 1px 撕裂 jitter），改用阴影深化纯光学方案
- 幽灵按钮必须 `pointer-events: none`（`opacity:0` 仍占 DOM 空间会拦截框选交互）
- 曜石黑环境光只用钛灰+琥珀（中性+微暖），严禁蓝紫以免破坏设计纲领

---

## 2026-03-18 · Entry 005 · weave-graph-web 前端 UI 全面重构 — 高级暗色工作室主题

### 变更范围
- `apps/weave-graph-web/index.html`（添加 Inter + JetBrains Mono 字体）
- `apps/weave-graph-web/src/app.css`（完整重写）
- `apps/weave-graph-web/src/nodes/semantic-node.tsx`（节点卡片全面升级）
- `apps/weave-graph-web/src/App.tsx`（Header、Canvas 空状态、Inspector 全面升级）
- `apps/weave-graph-web/src/components/ChatPanel.tsx`（Emoji 状态图标、渐变气泡、🌱 空状态）
- `apps/weave-graph-web/src/components/ApprovalPanel.tsx`（🛡️/🔐 头部、Emoji 按钮、工具名称卡片）
- `apps/weave-graph-web/src/components/InspectorTextBlock.tsx`（复制绿光闪烁、按内容类型选字体）
- `apps/weave-graph-web/src/edges/FlowEdge.tsx`（彗星双层流光动画、3锚点渐变、geometricPrecision）
- `apps/weave-graph-web/src/icons/*.tsx`（10个图标文件全部替换为 Emoji span）

### 做了什么
- 全局设计语言从"深空控制台"升级为"高级暗色工作室"，底色调整为蓝紫色温 `#0a0d14`
- 所有 SVG 节点图标替换为 Emoji（🧠 🛠️ 🔄 🚨 🔀 🛡️ 🩹 ✅ ⚙️ 💬），新增 AttemptIcon/EscalationIcon 以区分语义
- `app.css` 引入玻璃态变量、弹性动画时序、双字体系统、P3 广色域支持、Ghost 滚动条、`::selection` 品牌色
- 节点卡片：宽 248px、圆角 16px、真实 1px 玻璃边框 + `background-clip`、`filter: drop-shadow` 外阴影（防脏渗透）、`::after` 伪元素承载运行态光晕（GPU 合成零重绘）、Safari WebKit 毛玻璃圆角修复
- 连线改为彗星双层渲染：底层静态轨道（带 filter 发光）+ 顶层纯净彗星动线（不加 filter，GPU 友好），3锚点紫→蓝→天蓝渐变消除 RGB 泥潭色
- ChatPanel：SVG → Emoji 状态图标（🤔 ✅ ⚠️ ⏳），渐变用户气泡，渐变活跃指示线，🌱 空状态
- ApprovalPanel：🛡️/🔐 头部 + 副标题，工具名称橙金卡片，Emoji 操作按钮（✅ ✏️ ⏭ 🛑）
- InspectorTextBlock：复制成功绿光闪烁 150ms，JSON/代码 → `--font-mono`，自然语言 → `--font-ui`
- 画布空状态：🌌 巨型水印 + `AWAITING_INITIAL_PROMPT_` 终端光标闪烁

### 为什么这样做
用户反馈原有深空主题视觉体验僵硬、缺乏灵动感，SVG 图标不好看，参考 molty.me、openclaw.ai 等现代 AI 产品风格进行全面视觉重构，同时保证所有后端逻辑、Zustand store、WebSocket、Dagre 布局均不修改。

### 关键决策
- attempt/escalation 语义截然不同（正常重试 vs 熔断升级），不合并为同一图标
- 彗星动线不加 filter 是 GPU 性能关键：15 条同时动画若每条加 filter，帧率会从 60fps 暴跌
- 外阴影改用 `filter: drop-shadow` 而非 `box-shadow`，防止阴影透过玻璃半透明背景向内渗透变脏

## 2026-03-18 · Entry 004 · 核心运行时大重构：事件总线、RunContext、DAG 执行器与节点 execute()

### 变更范围
- `src/event/event-types.ts`（新建）
- `src/event/event-bus.ts`（新建）
- `src/session/run-context.ts`（新建）
- `src/runtime/dag-executor.ts`（新建）
- `src/runtime/dag-graph.ts`（扩展 DagNodeType）
- `src/runtime/dag-event-contract.ts`（放宽 nodeType 类型约束）
- `src/runtime/state-store.ts`（新增 getFinalText()）
- `src/runtime/nodes/base-node.ts`（新增 markSkipped/markAborted/execute/transitionInDag）
- `src/runtime/nodes/llm-node.ts`（全量重写，execute() 驱动 LLM 调用与 DAG 动态扩展）
- `src/runtime/nodes/tool-node.ts`（全量重写，execute() 内嵌完整重试链）
- `src/runtime/nodes/final-node.ts`（全量重写，execute() 驱动流式输出）
- `src/agent/tool-executor.ts`（精简，移除 deriveToolIntent/attachIntentToToolArgs/stripRuntimeToolMeta）
- `src/agent/run-agent.ts`（大幅精简，统一走 DAG 路径，移除 legacy runner）
- `src/weave/weave-plugin.ts`（调整 ToolNode 构造参数适配新接口）

### 做了什么
- 新建 `event/` 模块：`AgentRunEvent` 纯类型定义与 `WeaveEventBus` 统一事件总线（自动注入 runId/sessionId/turnIndex）
- 新建 `session/run-context.ts`：`RunContext` 接口集中注入所有 DAG 节点执行所需依赖
- 新建 `runtime/dag-executor.ts`：`executeDag()` 并行调度所有 ready 节点，内含死锁检测
- `BaseNode` 增加 `execute(ctx)` 默认空实现与 `transitionInDag()` 状态流转辅助方法
- `LlmNode.execute()` 驱动真实 LLM 调用，动态向 DAG 添加 ToolNode 或 FinalNode
- `ToolNode.execute()` 内嵌完整重试链（StepGate 审批、工具执行、RepairNode 可视化、EscalationNode 兜底）
- `FinalNode.execute()` 从 stateStore 读取最终文本并流式输出
- `run-agent.ts` 移除 legacy runner 分支，统一通过 `executeDag` 调度
- 扩展 `DagNodeType` 支持 `"repair"` 与 `"escalation"` 类型

### 为什么这样做
原有 `run-agent.ts` 包含 legacy 和 DAG 两条并行路径，代码超过 1300 行，节点逻辑零散分布在 run-agent.ts 的各函数中。本次重构将执行逻辑内聚到节点自身的 `execute()` 方法，调度器只负责调度 ready 节点，彻底消除 legacy 路径，实现了单一执行路径、可观测性完整、易于扩展的架构目标。

### 关键决策
- `RunContext` 作为依赖容器注入节点，避免节点直接引用 AgentRuntime 造成循环依赖
- `WeaveEventBus` 封装事件发射，使节点代码不依赖 EventEmitter 具体实现
- `executeDag` 中 JS 单线程保证并行 await 之间无 DAG 状态竞争

---

## 2026-03-18 · Entry 003 · weave-graph-web 全面 UI 重构（深空控制台主题）

### 变更范围
- `apps/weave-graph-web/src/app.css`（全量重写）
- `apps/weave-graph-web/src/nodes/semantic-node.tsx`（全量重写）
- `apps/weave-graph-web/src/edges/FlowEdge.tsx`（全量重写）
- `apps/weave-graph-web/src/App.tsx`（大改：Header 三区、Inspector 重构、边颜色）
- `apps/weave-graph-web/src/components/ChatPanel.tsx`（全量重写）
- `apps/weave-graph-web/src/components/ApprovalPanel.tsx`（全量重写）
- `apps/weave-graph-web/src/layout/dagre-layout.ts`（微改：NODE_WIDTH/HEIGHT）
- `apps/weave-graph-web/src/workers/layout.worker.ts`（微改：NODE_WIDTH/HEIGHT）
- `apps/weave-graph-web/src/icons/`（新建目录 + 8 个 SVG 图标文件）

### 做了什么
- 建立「深空控制台」设计主题，重写 CSS Token 系统（`--bg-base/surface/raised/overlay`，冷黑色调分层）
- 新增 8 个纯 SVG 图标组件（LlmIcon/ToolIcon/GateIcon/FinalIcon/InputIcon/SystemIcon/RepairIcon/ConditionIcon），替换节点 Emoji
- 节点卡片完全重设计：顶部 2px 状态颜色条、左侧竖线（状态驱动 + glow 动画）、类型副标题行、StatusBadge 圆角标签、宽度从 260→240px
- FlowEdge 增强：per-edge id 方向箭头 marker（避免颜色污染）、running 状态蓝→琥珀渐变描边、双粒子流动（偏移 0.7s）、edgeKind 标签支持
- Header 改为 48px 三区布局：左（品牌+轮次徽章）、中（runId 摘要+进度统计）、右（FitView 按钮+WS 状态）
- Inspector 重构：节点头部卡片（SVG图标+类型色+StatusBadge）、指标 stat-card（monospace 大数字）、端口区折叠（PortSection 组件）、端口 TYPE-BADGE
- ApprovalPanel 重构：顶部 3px 渐变警示条、主/危险按钮分组（2+2 网格）、JSON 编辑器加大（rows=10）
- ChatPanel 重构：纯 SVG 图标替换 lucide、节点计数徽章（success/total）、活跃 DAG 蓝色高亮

### 为什么这样做
视觉层面存在明显不足：Emoji 在深色背景下质感差、节点状态信息密度低、深色主题过于朴素、边无方向感。
本次重构以「深空控制台」为主题，提升 DAG 状态流转的视觉叙事能力，使运行中的节点/边能清晰传达执行方向。

### 关键决策
- CSS Token 双名兼容：旧变量名（`--bg-app`/`--text-main`）作为新 Token 别名，避免修改 App.tsx 所有 inline style
- 箭头 marker 用 per-edge id（`arrow-${edgeId}`），规避 ReactFlow SVG 多 edge 共享 marker 颜色污染问题
- 不引入新 npm 依赖：全基于 Tailwind v4 + 内联 SVG + CSS 自定义属性实现

---

## 2026-03-17 · Entry 002 · BaseNode 统一节点协议重构

### 变更范围
- `apps/shared/graph-protocol.ts`（重写）
- `src/runtime/nodes/`（新建目录 + 8 个文件）
- `src/runtime/blob-store.ts`（新建）
- `src/weave/weave-plugin.ts`（重写）
- `apps/weave-graph-server/src/projection/graph-projector.ts`（重写）
- `apps/weave-graph-server/src/gateway/ws-gateway.ts`（新增 `/api/blob/:id` 路由）
- `apps/weave-graph-server/src/protocol/graph-events.ts`（更新导出）
- `apps/weave-graph-web/src/types/graph-events.ts`（更新导出）
- `apps/weave-graph-web/src/store/graph-store.ts`（重写）
- `apps/weave-graph-web/src/App.tsx`（Inspector 升级）
- `apps/weave-graph-web/src/nodes/semantic-node.tsx`（读 metrics）

### 做了什么
- 新增 `NodeKind`（10 种）、`NodeStatus`（10 种）统一枚举，替代散落各处的 4 套互不兼容状态值
- 新增 `NodeMetrics`、`NodeError`、`BaseNodePayload`、子类型 Payload 等类型（`apps/shared/graph-protocol.ts`）
- 更新 `GraphPort`：`summary: string` → `content: unknown`，支持原生 Object/Array 传输（零双重序列化）
- 建立 `src/runtime/nodes/` 节点类体系：`BaseNode` 抽象类 + `LlmNode / ToolNode / AttemptNode / RepairNode / FinalNode / InputNode / EscalationNode`
- 新建 `safe-serialize.ts`：`safeClone()` 三合一（深拷贝 + 循环引用防爆 + 不可序列化类型过滤），替代原生 structuredClone
- 新建 `blob-store.ts`：50KB 阈值大内容写临时文件 + blobRef 引用，全异步接口
- 重写 `WeavePlugin`：用节点类替代 `TurnDAGBuilder`，通过 `toFullPayload()` 发射 `weave.dag.base_node` 事件（包含完整 I/O 端口）
- 重写 `GraphProjector`：优先处理 `weave.dag.base_node`（直接解构 `BaseNodePayload`），保留旧事件向后兼容
- 新增 `/api/blob/:id` HTTP 端点（`ws-gateway.ts`），支持前端 Inspector 大内容懒加载
- 升级前端 Inspector：错误区（红色高亮）、Metrics 区（耗时/Token）、端口区（原生 JSON/text 渲染、blobRef 懒加载按钮）

### 为什么这样做
原有节点定义碎片化：5 个层级中 `id` vs `nodeId`、`type` vs `kind`、4 套互不兼容状态枚举、端口只有截断文本摘要，无法支持白盒调试。本次重构建立统一 DTO 层，使 Inspector 能展示 LLM 的完整 messages 数组、工具调用的完整 JSON 参数、错误 stack trace 等完整信息。

### 关键决策
- `src/` tsconfig rootDir 限制了直接导入 `apps/shared/`，故在 `src/runtime/nodes/node-types.ts` 中定义结构对齐的本地类型（TypeScript 结构化类型系统保证运行时兼容）
- `toFullPayload()` 为 async 以支持 BlobStore 大内容处理，雪崩传播到 WeavePlugin 各钩子（AgentLoopPlugin 接口已支持 Promise 返回）
- 旧版 `weave.dag.node` / `weave.dag.detail` 事件路径在 GraphProjector 中保留向后兼容，新版 `weave.dag.base_node` 为主路径

---

## 2026-03-17 · Entry 001 · 汉化 CLAUDE.md 并建立工作流规范

### 变更范围
`CLAUDE.md`

### 做了什么
将项目指导文件 `CLAUDE.md` 从英文全文翻译为中文，并新增两项工作流规范章节。

**具体改动：**
- 全文翻译为中文（保留代码块、命令、技术术语原文）
- 新增「任务完成后提交规范」章节：
  - 明确提交流程：暂存 → 中文消息 → 本地提交
  - 提供提交类型对照表（feat/fix/refactor/docs/style/test/chore）
  - 提供完整提交消息示例（含 `Co-Authored-By` 尾注）
- 新增「开发日志规范」章节（本条目即为首次执行）：
  - 每次任务完成后，将变更摘要追加到 `docs/project/dev-log.md`
  - 记录格式：做了什么 + 为什么 + 关键决策

### 为什么这样做
- 项目语言规范要求所有文档使用中文，CLAUDE.md 作为核心指导文件应保持一致
- 缺乏统一提交规范导致历史记录混乱（参见 commit `0d47cf6 使用claude重构并修复`），引入 Conventional Commits 格式提升可追溯性
- 过去无开发日志积累，难以快速回顾「为什么做某个决定」，本规范解决此问题

### 关键决策
- 开发日志独立于 `development-progress.md`（后者侧重架构级进度），`dev-log.md` 侧重每次任务的变更原因
- 不强制要求 `git push`，仅要求本地提交，降低协作风险

---

<!-- 新条目追加在此处上方，保持时间倒序 -->
