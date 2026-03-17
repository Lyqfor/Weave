/**
 * 文件作用：集中管理全局业务常量，支持环境变量覆盖。
 * 各模块从此处导入常量，避免硬编码分散在代码各处。
 */

// ─── Agent 运行时 ───

/** 每轮最大执行步数（LLM→工具循环），防止无限循环 */
export const MAX_AGENT_STEPS = 6;

/** auto 模式下工具失败自动重试次数 */
export const DEFAULT_TOOL_RETRIES = Number(process.env.WEAVE_DAG_TOOL_RETRIES ?? "1");

/** 工具执行超时（毫秒） */
export const DEFAULT_TOOL_TIMEOUT_MS = Number(process.env.WEAVE_DAG_TOOL_TIMEOUT_MS ?? "15000");

/**
 * 运行时读取工具自动重试次数。
 * 说明：脚本和测试可能在进程运行过程中更新环境变量，需按调用时取值。
 */
export function getDefaultToolRetries(): number {
  return Number(process.env.WEAVE_DAG_TOOL_RETRIES ?? "1");
}

/**
 * 运行时读取工具超时配置（毫秒）。
 * 说明：避免模块加载时固化值，保证验证脚本中的动态配置可生效。
 */
export function getDefaultToolTimeoutMs(): number {
  return Number(process.env.WEAVE_DAG_TOOL_TIMEOUT_MS ?? "15000");
}

// ─── TUI 显示 ───

/** 聊天日志最大保留条数 */
export const MAX_LOG_ITEMS = 40;

/** DAG 节点详情最大保留条数 */
export const MAX_NODE_DETAILS = 8;

/** 输入框安全余量列数，避免终端边界换行抖动 */
export const INPUT_SAFE_MARGIN = 1;

/** TUI 主题色板 */
export const THEME = {
  primary: "#F08A24",
  primaryStrong: "#FFB15D",
  border: "#8A5A2B",
  muted: "#C9A27A",
  text: "#FFF2E6",
  panelTitle: "#FFD7A8",
  user: "#FFD9B8",
  assistant: "#FFE7CE",
  success: "#8FD3A6",
  danger: "#F3A2A2",
  waiting: "#F2C94C",
  running: "#58C4DD",
  retrying: "#E7B86D",
  detailBorder: "#A8743F",
  detailText: "#F0CFAD"
} as const;
