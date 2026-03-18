/*
 * 文件作用：将节点与边交给 Dagre 计算布局坐标，供 React Flow 渲染。
 * 提供同步版本（用于简单场景）和 Worker 异步版本（用于大型 DAG 避免主线程卡顿）。
 */

import dagre from "dagre";
import type { Edge, Node } from "reactflow";

const NODE_WIDTH = 240;
const NODE_HEIGHT = 72;

export function applyDagreLayout(
  nodes: Node[],
  edges: Edge[],
  direction: "TB" | "LR" = "TB",
  lockedNodeIds: Set<string> = new Set<string>()
): Node[] {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: direction, ranksep: 80, nodesep: 40 });

  for (const node of nodes) {
    graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  for (const edge of edges) {
    graph.setEdge(edge.source, edge.target);
  }

  dagre.layout(graph);

  return nodes.map((node) => {
    if (lockedNodeIds.has(node.id)) {
      return node;
    }

    const positioned = graph.node(node.id);
    if (!positioned) {
      return node;
    }

    return {
      ...node,
      position: {
        x: positioned.x - NODE_WIDTH / 2,
        y: positioned.y - NODE_HEIGHT / 2
      }
    };
  });
}

/** Worker 实例缓存，避免每次布局都创建新 Worker */
let layoutWorker: Worker | null = null;
let workerAvailable = true;

function getLayoutWorker(): Worker | null {
  if (!workerAvailable) {
    return null;
  }

  if (!layoutWorker) {
    try {
      layoutWorker = new Worker(new URL("../workers/layout.worker.ts", import.meta.url), { type: "module" });
      layoutWorker.onerror = () => {
        // Worker 不可用时降级为同步计算
        workerAvailable = false;
        layoutWorker = null;
      };
    } catch {
      workerAvailable = false;
      return null;
    }
  }

  return layoutWorker;
}

/**
 * 异步 Dagre 布局：使用 Web Worker 在后台线程计算，节点数较多时不阻塞 UI。
 * 若 Worker 不可用则自动降级为同步计算。
 */
export function applyDagreLayoutAsync(
  nodes: Node[],
  edges: Edge[],
  direction: "TB" | "LR" = "TB",
  lockedNodeIds: Set<string> = new Set<string>()
): Promise<Node[]> {
  const worker = getLayoutWorker();

  if (!worker) {
    // 降级同步
    return Promise.resolve(applyDagreLayout(nodes, edges, direction, lockedNodeIds));
  }

  return new Promise<Node[]>((resolve) => {
    const onMessage = (e: MessageEvent<Node[]>) => {
      worker.removeEventListener("message", onMessage);
      resolve(e.data as Node[]);
    };

    worker.addEventListener("message", onMessage);
    worker.postMessage({
      nodes,
      edges,
      direction,
      lockedNodeIds: Array.from(lockedNodeIds)
    });
  });
}
