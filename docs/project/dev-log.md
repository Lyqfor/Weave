# Dagent 开发日志

本文件记录每次任务完成后的变更摘要，目标是：阅读本日志即可了解**做了什么、为什么这样做**。

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
