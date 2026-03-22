import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";
import type { LlmConfig } from "../../core/types/config.js";
import { AppLogger } from "../logging/app-logger.js";

/**
 * 文件作用：负责读取并校验 LLM 配置文件，解析 API Key，并输出运行时可用的标准配置对象。
 */
loadDotEnv();
const logger = new AppLogger("config-loader");

const rawConfigSchema = z.object({
  provider: z.literal("qwen"),
  model: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  systemPrompt: z.string().optional()
});

export function loadLlmConfig(configPath = "config/llm.config.json"): LlmConfig {
  // 1) 读取配置文件并按 schema 做结构校验，避免运行时因字段缺失而崩溃。
  const absolutePath = resolve(process.cwd(), configPath);

  // 子目录进程（如 apps/weave-graph-server）也能按配置文件位置回溯到仓库根目录 .env。
  const envFromConfigRoot = join(dirname(absolutePath), "..", ".env");
  loadDotEnv({ path: envFromConfigRoot, override: false });

  logger.info("config.read.start", "开始读取大模型配置", { configPath: absolutePath });
  const fileText = readFileSync(absolutePath, "utf8");
  const parsed = rawConfigSchema.parse(JSON.parse(fileText));
  logger.info("config.read.success", "配置结构校验通过", {
    provider: parsed.provider,
    model: parsed.model,
    baseUrl: parsed.baseUrl
  });

  // 防呆：apiKeyEnv 必须是环境变量名，而不是以 sk- 开头的密钥值。
  if (parsed.apiKeyEnv?.startsWith("sk-")) {
    throw new Error(
      `Invalid apiKeyEnv in ${configPath}: expected env var name (e.g. QWEN_API_KEY), but got a key-like value.`
    );
  }

  // 2) API Key 支持两种来源：配置文件直写或环境变量注入，优先使用直写值。
  const apiKeyFromEnv = parsed.apiKeyEnv ? process.env[parsed.apiKeyEnv] : undefined;
  const apiKey = parsed.apiKey ?? apiKeyFromEnv;

  if (!apiKey) {
    logger.error("config.key.missing", "未找到可用的 API Key", {
      configPath: absolutePath,
      apiKeyEnv: parsed.apiKeyEnv
    });
    throw new Error(
      `Missing API key. Set apiKey in ${configPath} or provide ${parsed.apiKeyEnv ?? "a valid env var"}.`
    );
  }

  // 3) 返回运行时配置；其中 API Key 已完成归一化处理。
  logger.info("config.ready", "大模型配置加载完成", {
    provider: parsed.provider,
    model: parsed.model
  });
  return {
    ...parsed,
    apiKey
  };
}
