/*
 * 文件作用：在后台线程运行 Dagre 布局计算，避免大型 DAG 阻塞主线程渲染。
 */

import dagre from "dagre";

const NODE_WIDTH = 240;
const NODE_HEIGHT = 72;

interface NodeLike {
  id: string;
  position?: { x: number; y: number };
  data?: unknown;
  [key: string]: unknown;
}

interface EdgeLike {
  id: string;
  source: string;
  target: string;
  [key: string]: unknown;
}

interface WorkerInput {
  nodes: NodeLike[];
  edges: EdgeLike[];
  direction: "TB" | "LR";
  lockedNodeIds: string[];
}

self.onmessage = (event: MessageEvent<WorkerInput>) => {
  const { nodes, edges, direction, lockedNodeIds } = event.data;
  const locked = new Set(lockedNodeIds);

  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: direction, ranksep: 80, nodesep: 40 });

  for (const node of nodes) {
    graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  for (const edge of edges) {
    if (edge.source && edge.target) {
      graph.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(graph);

  const result = nodes.map((node) => {
    if (locked.has(node.id)) {
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

  self.postMessage(result);
};
