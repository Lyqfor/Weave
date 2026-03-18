# Dagent 开发日志

本文件记录每次任务完成后的变更摘要，目标是：阅读本日志即可了解**做了什么、为什么这样做**。

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
