# Dagent 优化方案 V2（基于 problem.md 验证）

## 问题验证结果

| 问题 | 出处 | 状态 | 对应优化任务 |
|------|------|------|------------|
| App.tsx 7 种职责混杂 | 1.1 | **仍存在**（1180 行） | OPT-08/09/10 |
| 事件协议双轨并存 | 1.2 | **仍存在** | OPT-19（新增） |
| DagRunner/WeavePlugin 节点 ID 不一致 | 1.3 | **部分修复** | OPT-20（新增） |
| 文本协议解析（retry=x/y 等） | 2.1 | **仍存在** | OPT-21（新增） |
| 错误处理系统性缺失 | 2.2 | **仍存在** | OPT-12 |
| 内存泄漏风险（chatLogs/监听器） | 2.4 | **已大幅改善** | — |
| TUI 抖动缺少帧节流 | 3.1 | **仍存在** | OPT-22（新增） |
| DAG 展开策略与用户操作冲突 | 3.2 | **仍存在** | OPT-09 |
| run-agent.ts 职责爆炸（1618 行） | 4.1 | **仍存在** | OPT-05/06/07 |
| agent-ui-events.ts if-else 膨胀 | 4.2 | **当前可控**（8 分支） | — |
| WeavePlugin 与执行层深度耦合 | 4.3 | **仍存在** | OPT-16 |
| 图服务类型重复 | 4.4 | **仍存在** | OPT-03 |
| 双执行路径冗余 | 5.1 | **仍存在** | OPT-23（新增） |
| summarizeText 截断散落 | 5.2 | **已修复** ✓ | OPT-01 已完成 |
| 节点 ID 双格式 | 5.3 | **仍存在** | OPT-20 |
| 测试覆盖盲区 | 6.2 | **仍存在** | OPT-24（新增） |
| 工具注册缺少元数据 | 7.1 | **仍存在** | OPT-16 |
| 图服务协议版本演进无保障 | 7.2 | **仍存在** | OPT-03 |

---

## 已完成优化

- [x] **OPT-01**: 提取通用工具函数库 `src/utils/`（text-utils, display-width, id-gen）
- [x] **OPT-02**: 集中管理硬编码常量 `src/config/defaults.ts`
- [x] **OPT-04**: 提取插件钩子执行器 `src/agent/plugin-executor.ts`（已修复 this 绑定回归）

---

## 2026-03-17 链路复盘（/weave on 无节点）

- 根因 1（主因）: `plugin-executor.ts` 在调用插件钩子时丢失 `this` 上下文，`WeavePlugin.onRunStart` 访问 `runStates` 抛异常，导致 DAG 节点事件无法稳定产出。
- 根因 2（次因）: `defaults.ts` 中重试/超时配置为模块加载时静态读取，验证脚本运行期修改环境变量不生效，导致 DAG 矩阵 timeout 场景断言失败。
- 影响面: `/weave on`、`/weave step` 的 DAG 可观测性；自动化验证中的 timeout 语义。
- 修复结果: 构建、Step Gate、DAG Matrix 三项回归全部通过。

---

## 待执行优化（按优先级排序）

### P0：核心架构（阻塞可维护性）

#### OPT-05: 提取工具执行器 `src/agent/tool-executor.ts`
- [x] 完成
- **问题**: run-agent.ts 中工具执行逻辑（审批→执行→重试）在 Legacy/DAG 两条路径中各 150+ 行重复
- **方案**: 提取 `executeToolWithApproval()` 和 `repairAndRetryTool()` 为独立模块，两条路径共享

#### OPT-06: 提取 LLM 编排器 `src/agent/llm-orchestrator.ts`
- [x] 完成（repairToolArgsByIntent 移入 tool-executor.ts，invokeLlmWithTools/invokeLlmText 保留为薄代理）
- **问题**: invokeLlmWithTools/invokeLlmText/流式调用逻辑在 AgentRuntime 内部
- **方案**: 提取为独立 LlmOrchestrator 类

#### OPT-07: 提取 Weave 事件发射器 `src/agent/weave-emitter.ts`
- [x] 完成
- **问题**: run-agent.ts 中 30+ 处直接构造并发射 weave.dag.node/detail 事件
- **方案**: 提取为语义方法（emitToolAttemptNode/emitRepairNode 等）

#### OPT-23: 提取双路径公共逻辑（新增）
- [x] 完成（通过 runOnceStreamCommon 模板方法消除 Legacy/DAG 重复框架代码）
- **问题**: Legacy/DAG 两条路径的公共逻辑（工具调用处理、结果格式化、历史写入）重复
- **方案**: 提取公共执行逻辑，两条路径调用同一实现

### P1：协议与类型安全

#### OPT-19: 统一事件协议规范（新增）
- [ ] 完成
- **问题**: TUI 消费 weave.dag.node/detail，图服务消费 run.start/tool.execution，两套协议描述同一件事
- **方案**: 定义统一的 AgentEvent 规范层，所有消费者从同一层读取

#### OPT-20: 统一节点 ID 格式（新增）
- [ ] 完成
- **问题**: DagRunner 内部用 tool-1-1，WeavePlugin 用 1.1，displayNodeId 做桥接但未彻底
- **方案**: 所有层统一使用 `{step}.{index}` 格式，删除 displayNodeId 桥接

#### OPT-21: 结构化事件替代文本协议（新增）
- [ ] 完成
- **问题**: retry=x/y、intent=、goal= 等通过文本前缀传递结构化数据，解析脆弱
- **方案**: 定义 RetryEvent/IntentEvent 等结构化接口，替代文本协议

#### OPT-03: 统一前后端协议类型定义
- [x] 完成（创建 apps/shared/graph-protocol.ts 为唯一权威源）
- **问题**: 前后端各维护一份 graph-events.ts
- **方案**: 提取共享类型包

### P2：TUI 重构

#### OPT-08: 提取输入框组件
- [x] 完成（纯函数提取到 tui-helpers.ts）

#### OPT-09: 提取 DAG 树组件 + 独立 DagViewState
- [x] 完成（DAG 树逻辑提取到 dag-tree.ts）
- **附加**: 将展开/折叠策略提取为独立状态管理，解决自动策略与用户手动操作冲突

#### OPT-10: 拆分状态管理 Hook
- [x] 完成（DAG 节点状态提取到 use-weave-dag-state.ts）

#### OPT-22: TUI 帧节流 RenderScheduler（新增）
- [ ] 完成
- **问题**: 每个 llm.delta 事件触发全量重渲染，导致终端闪烁
- **方案**: 实现 16ms 帧节流 + 批量更新

### P3：可靠性与安全

#### OPT-11: 添加运行时类型验证
- [x] 完成（ToolRegistry.execute 添加参数类型检查和 required 字段验证）

#### OPT-12: 统一错误处理模式
- [x] 完成（创建 agent-errors.ts 错误类型 + extractErrorMessage 统一错误提取）

#### OPT-13: 修复图服务内存泄漏
- [x] 完成（GraphProjector 运行结束时清理 seqByRun/dagIdByRun 映射）

#### OPT-17: 命令执行工具安全加固
- [x] 完成（添加 checkCommandSafety 拦截破坏性命令和超长命令）

### P4：前端与可视化

#### OPT-14: 前端状态管理重构
- [x] 完成（graph-store 已使用 zustand，结构合理；TUI 侧通过 OPT-10 完成拆分）

#### OPT-15: 前端组件拆分与性能优化
- [x] 完成（web 端 320 行已合理；TUI 侧通过 OPT-08/09 完成拆分，App.tsx 从 1180→689 行）

### P5：工具与日志

#### OPT-16: Weave 插件工具语义化解耦
- [x] 完成（提取 tool-formatters.ts 注册器模式，新工具无需修改 WeavePlugin）

#### OPT-18: 日志系统升级
- [x] 完成（添加 DEBUG/WARN 级别 + 日志级别过滤 + minLevel 构造参数）

#### OPT-24: 补充核心模块单元测试（新增）
- [ ] 完成
- **问题**: WeavePlugin、useAgentState、AgentUiEventGateway、文本解析逻辑无测试
- **方案**: 添加 vitest 配置，为核心模块编写单元测试

#### OPT-25: 修复插件钩子绑定与动态配置读取（新增）
- [x] 完成
- **问题**:
	- 插件钩子抽取后，执行器通过函数引用调用导致 `this` 丢失。
	- 重试/超时配置在模块加载时读取，运行时环境变量更新无效。
	- `run.completed` 先于插件收尾事件发布，导致图投影层将同一轮拆成两个 DAG（`session:turn-x` 与 `run_xxx`）。
- **方案**:
	- `executePluginHook` 改为 `hook.call(plugin, context)` 保持实例上下文。
	- 增加 `getDefaultToolRetries/getDefaultToolTimeoutMs`，在运行路径实时读取环境变量。
	- `run-agent` 中插件收尾输出提前到 `run.completed` 之前发布。
	- `GraphProjector` 对已结束 run 增加短暂上下文保留窗口，吸收晚到 `plugin.output`。
- **涉及文件**: `src/agent/plugin-executor.ts`, `src/config/defaults.ts`, `src/agent/run-agent.ts`, `apps/weave-graph-server/src/projection/graph-projector.ts`

---

## 验证方案

每个优化完成后执行：
1. `pnpm build` — 编译检查
2. `node scripts/verify-step-gate.mjs` — Step Gate 回归
3. `node scripts/verify-dag-matrix.mjs` — DAG 语义回归
