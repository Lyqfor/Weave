# Weave Graph Protocol 接口文档

本文档描述 `weave-graph-server` 与 Web 前端之间的 WebSocket 通信协议，
以及运行时事件到图协议事件的完整转换矩阵。

---

## 一、认证与鉴权

| 通道 | 传递方式 | 示例 |
|------|----------|------|
| HTTP 注入端点 | `X-Graph-Token` 请求头 | `X-Graph-Token: <token>` |
| WebSocket 升级 | URL query 参数 `token` | `ws://localhost:3700/ws?token=<token>` |

- Token 值由环境变量 `WEAVE_GRAPH_TOKEN` 配置；未配置时跳过鉴权（仅限本地开发）。
- 连接建立后服务端每 30 秒发送 `{"type":"ping"}` 心跳，客户端无需回应。

---

## 二、下行事件流（Server → Client）

所有消息均为 JSON，遵循 `GraphEnvelope<T>` 信封格式：

```typescript
interface GraphEnvelope<T> {
  schemaVersion: string;   // "weave.graph.v1"
  seq: number;             // 单次 run 内单调递增序列号
  runId: string;           // 本次 Agent 运行唯一 ID
  dagId: string;           // DAG 唯一 ID（sessionId:turn-N 或 runId）
  eventType: string;       // 见下表
  timestamp: string;       // ISO-8601
  payload: T;
}
```

### 2.1 事件类型一览

| `eventType` | 触发时机 | Payload 结构 |
|-------------|----------|--------------|
| `run.start` | Agent 开始新一轮对话 | `{ dagId, sessionId?, turnIndex?, userInputSummary }` |
| `run.end` | Agent 完成/出错 | `{ ok: boolean, finalSummary? }` |
| `node.upsert` | 节点首次创建（或补充元数据） | `{ nodeId, kind, title, parentId?, tags?, dependencies? }` |
| `node.status` | 节点状态流转 | `{ nodeId, status }` |
| `node.io` | 节点输入/输出端口数据就绪 | `{ nodeId, inputPorts?, outputPorts?, error?, metrics? }` |
| `edge.upsert` | 边创建（依赖/数据/父子） | `{ edgeId, source, target, edgeKind?, fromPort?, toPort?, label? }` |
| `node.pending_approval` | Step Gate 等待人工审批 | `{ nodeId, toolName, toolParams }` |
| `node.approval.resolved` | Step Gate 审批完成 | `{ nodeId, action }` |

### 2.2 `node.io` 合并策略（Partial Update）

> **重要：`node.io` 事件只做 Partial Update，绝不覆盖 `status`、`title` 等字段。**

前端收到 `node.io` 时，应执行深合并：

```typescript
// 正确做法：只更新端口相关字段
store.nodes[nodeId] = {
  ...store.nodes[nodeId],
  inputPorts:  payload.inputPorts  ?? store.nodes[nodeId].inputPorts,
  outputPorts: payload.outputPorts ?? store.nodes[nodeId].outputPorts,
  error:       payload.error       ?? store.nodes[nodeId].error,
  metrics:     payload.metrics     ?? store.nodes[nodeId].metrics,
};

// ❌ 错误做法：整体替换会丢失 status/title 等字段
store.nodes[nodeId] = payload;
```

### 2.3 `GraphPort` 结构

```typescript
interface GraphPort {
  name: string;
  type: "text" | "json" | "messages" | "number";
  /** 原始内容（非 JSON 字符串）；超过 50KB 时为 null，由 blobRef 替代 */
  content: unknown;
  blobRef?: string;
}
```

### 2.4 `NodeStatus` 枚举

| 值 | 含义 | 前端颜色（建议） |
|----|------|----------------|
| `pending` | 等待调度 | 灰色 |
| `ready` | 依赖已满足，待执行 | 浅蓝 |
| `blocked` | 拦截器挂起，等待人工审批 | 黄色 |
| `running` | 执行中 | 蓝色（脉冲动画） |
| `waiting` | 等待外部响应 | 蓝紫 |
| `retrying` | 重试中 | 橙色 |
| `success` | 执行成功 | 绿色 |
| `fail` | 执行失败 | 红色 |
| `skipped` | 被跳过 | 浅灰 |
| `aborted` | 被中止 | 深红 |

---

## 三、上行指令流与 RPC 响应（Client ↔ Server）

为了支持复杂的前端操作（如带二次校验的参数编辑、快照回溯等），Web 前端与后端网关采用具有生命周期的 RPC (请求-响应) 模式进行通信。

### 3.1 统一的上行 RPC 请求信封 (Client → Server)

客户端发送控制指令时，必须使用 `ClientMessageEnvelope` 封装：

```typescript
interface ClientMessageEnvelope<T = unknown> {
  type: "gate.action" | "node.update_params" | "command.fork" | "snapshot.query";
  reqId?: string;        // 客户端请求ID（UUID），用于关联后端的 Response
  payload: T;
}
```

### 3.2 统一的下行响应信封 (Server → Client)

后端处理带有 `reqId` 的请求后，返回对应的响应信封（注意：这不是图状态事件，而是纯粹的控制流响应）：

```typescript
interface ServerResponseMessageEnvelope<T = unknown> {
  schemaVersion: "weave.graph.v1";
  eventType: "server.response";
  reqId: string;         // 原样返回客户端请求时的 reqId
  ok: boolean;           // 成功标识
  error?: string;        // 错误详情（如校验失败原因）
  payload?: T;           // 成功时的返回数据
}
```

### 3.3 核心指令 Payload 定义

#### 3.3.1 审批操作 (gate.action)

兼容旧版的工具审批操作，目前已作为 RPC 消息的一部分进行处理。

```typescript
// 触发 type: "gate.action"
interface GateActionPayload {
  gateId: string;            // 对应 node.pending_approval 中的 toolCallId
  action: "approve" | "edit" | "skip" | "abort";
  params?: string;           // action="edit" 时携带修改后的参数 JSON 字符串
}
```

**交互示例 (二次校验)：**
1. 客户端发送：
   ```json
   {
     "type": "gate.action",
     "reqId": "uuid-1234",
     "payload": {
       "gateId": "call_abc123",
       "action": "edit",
       "params": "{\"invalid\": true}"
     }
   }
   ```
2. 服务端进行参数二次校验。若失败，返回：
   ```json
   {
     "schemaVersion": "weave.graph.v1",
     "eventType": "server.response",
     "reqId": "uuid-1234",
     "ok": false,
     "error": "Schema validation failed..."
   }
   ```
   前端收到后拦截 Promise，在 UI 渲染错误，等待用户重新提交。

#### 3.3.2 预留扩展点

```typescript
// 未来：分叉重跑某个节点
interface CommandForkPayload {
  nodeId: string;
  snapshotId: string;  // 快照 ID，用于回溯重跑
}
```

---

## 四、运行时事件 → 图协议事件转换矩阵

| 运行时事件 (`AgentRunEventType`) | 图协议事件 (`eventType`) | 说明 |
|----------------------------------|--------------------------|------|
| `run.start` | `run.start` | 1:1 |
| `run.completed` | `run.end` (`ok=true`) | |
| `run.error` | `run.end` (`ok=false`) | |
| `engine.node.created` | `node.upsert` + `node.status` | 同步快照（无端口） |
| `engine.node.transition` | `node.status` | 状态流转 |
| `engine.node.io` | `node.io` | 异步端口补充（Partial Update） |
| `engine.edge.created` | `edge.upsert` | 依赖/父子边 |
| `engine.data.edge.created` | `edge.upsert` (data) | 数据流边 |
| `engine.scheduler.issue` | `node.upsert` + `node.status` (fail) | 调度异常展示为系统节点 |
| `plugin.output` (weave.dag.base_node) | `node.upsert` + `node.status` + `node.io?` + `edge.upsert?` | WeavePlugin 全量快照 |
| `plugin.output` (weave.dag.edge) | `edge.upsert` | 边快捷方式 |
| `tool.gate.pending` | `node.upsert` + `node.status` + `node.pending_approval` | Step Gate 创建 |
| `tool.gate.resolved` | `node.status` + `node.approval.resolved` | Step Gate 解决 |

### 端口数据时序说明

`engine.node.created` / `engine.node.transition` 均为**同步**事件，快照中不含端口数据。
端口数据通过独立的 `engine.node.io` 事件在状态流转后**异步**发送，前端必须支持乱序合并。

```
Timeline:
  t=0ms  engine.node.transition (status=running, 无端口)
  t=5ms  engine.node.io         (inputPorts=[args], 无 status)  ← Partial Update
  t=200ms engine.node.transition (status=success, 无端口)
  t=210ms engine.node.io        (outputPorts=[result])          ← Partial Update
```
