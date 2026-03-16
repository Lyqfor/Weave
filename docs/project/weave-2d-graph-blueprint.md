# Weave 二维图可开工蓝图

## 目标
- 保持现有 Agent Runtime 不破坏。
- 增加 Graph Projection 与 WS 网关。
- 前端使用 React Flow + Zustand + Dagre 先跑通。
- 协议版本化，后续可平滑升级 ELK 与 Worker。

## 目录结构

```text
apps/
  weave-graph-server/
    package.json
    tsconfig.json
    src/
      index.ts
      gateway/ws-gateway.ts
      projection/graph-projector.ts
      protocol/graph-events.ts
  weave-graph-web/
    package.json
    tsconfig.json
    vite.config.ts
    index.html
    src/
      main.tsx
      App.tsx
      types/graph-events.ts
      store/graph-store.ts
      layout/dagre-layout.ts
      workers/layout.worker.ts
```

## 协议说明
- `schemaVersion=weave.graph.v1`
- 最小事件：
  - `run.start`
  - `node.upsert`
  - `edge.upsert`
  - `node.status`
  - `node.io`
  - `layout.hint`
  - `run.end`
- `node.io` 支持：
  - `inputPorts[]`: `{name,type,summary,blobRef?}`
  - `outputPorts[]`: `{name,type,summary,blobRef?}`

## 后端职责边界
- Runtime Event Layer：继续产出原始运行事件。
- Graph Projection Layer：事件归一化，不暴露内部实现细节。
- WS Gateway：
  - 仅监听 `127.0.0.1`
  - token 校验
  - Origin 白名单（本地）
  - 心跳 ping

## 前端职责边界
- Zustand：单一真相源 + `seq` 去重。
- React Flow：纯渲染。
- Dagre：布局计算（当前全量布局）。
- Worker：布局迁移预留位（未来 ELK）。

## 联调步骤
1. 在 `apps/weave-graph-server` 安装依赖并启动。
2. 在 `apps/weave-graph-web` 安装依赖并启动。
3. 将 server 打印的 `port/token` 注入 web URL 参数：
   - `http://127.0.0.1:5173/?port=<port>&token=<token>`
4. 在主 CLI 进程注入环境变量，开启 Runtime -> GraphServer 转发：
  - `WEAVE_GRAPH_INGEST_URL=http://127.0.0.1:<port>/ingest/runtime-event`
  - `WEAVE_GRAPH_TOKEN=<token>`
5. 启动主 CLI 后，`run.start` 会自动投影出“终端输入命令”节点，验证链路是否打通。

## 一键启动脚本
- 启动三服务：`pnpm dev:graph:all`
- 停止三服务：`pnpm dev:graph:stop`
- 脚本位置：
  - `scripts/start-weave-graph-all.ps1`
  - `scripts/stop-weave-graph-all.ps1`

## 解耦关系说明
1. 主 CLI（`src/index.ts`）可独立运行（不配置图转发环境变量时，不影响原有流程）。
2. 图后端（`apps/weave-graph-server`）独立运行，负责接收 Runtime 事件并投影为图协议。
3. 图前端（`apps/weave-graph-web`）独立运行，仅消费图后端 WS 消息并渲染。

## 下一阶段建议
- 增加 `blobRef` 详情拉取 API（避免大文本全量推送）。
- 增加 100ms 布局节流与拖拽锁定。
- 增加 run 事件回放与快照存档。
- 节点规模上百后切换 ELK 增量布局。
