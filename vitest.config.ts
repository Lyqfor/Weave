import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Vite 5 会剥离 "node:" 前缀导致 node:sqlite 解析失败，用 CJS shim 绕过
      "node:sqlite": resolve(__dirname, "scripts/sqlite-shim.cjs"),
    },
  },
  test: {
    // 测试文件匹配模式
    include: ["src/**/*.spec.ts", "src/**/*.test.ts"],
    exclude: ["node_modules", "dist", "apps"],

    // 环境
    environment: "node",


    // 覆盖率配置
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.spec.ts",
        "src/**/*.test.ts",
        "src/**/__tests__/**",
        "src/contracts/**", // 契约层只有接口，不计入覆盖率
        "src/presentation/**", // TUI 层难以单元测试
        "dist/**",
      ],
      thresholds: {
        // 整体覆盖率要求
        global: {
          lines: 80,
          functions: 80,
          branches: 75,
          statements: 80,
        },
      },
    },

    // 超时设置
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
