// @ts-check
"use strict";

/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended", "prettier"],
  rules: {
    // ─── 架构分层护栏（物理层隔离）────────────────────────────────────────
    // 注意：no-restricted-imports 的 patterns 对象格式在 ESLint 8 中有限制
    // 使用 paths 数组格式实现精确路径限制，glob 模式通过注释文档约定
    // 完整物理隔离在迁移到 ESLint 9 flat config 时启用
    "no-restricted-imports": [
      "warn",
      {
        patterns: ["**/presentation/index*"],
      },
    ],

    // ─── 类型安全（渐进式：先 off，逐步收紧到 warn → error）──────────────
    "@typescript-eslint/no-explicit-any": "warn", // P1-1: 已消除生产代码中的 as any，测试文件豁免
    "@typescript-eslint/no-unsafe-assignment": "off",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],

    // ─── 代码质量 ──────────────────────────────────────────────────────────
    "no-console": ["warn", { allow: ["warn", "error", "log"] }],
    "prefer-const": "error",
    "no-var": "error",
  },
  overrides: [
    // 测试文件放宽限制
    {
      files: ["**/*.spec.ts", "**/*.test.ts", "scripts/**/*.mjs"],
      rules: {
        "no-restricted-imports": "off",
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-unused-vars": "off",
        "no-console": "off",
      },
    },
    // contracts 层放宽（允许使用外部类型）
    {
      files: ["src/contracts/**/*.ts"],
      rules: {
        "no-restricted-imports": "off",
      },
    },
    // 日志基础设施（允许使用 console）
    {
      files: ["src/infrastructure/logging/**/*.ts"],
      rules: {
        "no-console": "off",
      },
    },
    // 配置文件
    {
      files: ["*.cjs", "*.mjs", "*.js"],
      env: {
        node: true,
      },
      rules: {
        "@typescript-eslint/no-var-requires": "off",
        "no-restricted-imports": "off",
      },
    },
  ],
  env: {
    es2022: true,
    node: true,
  },
  ignorePatterns: ["dist/", "node_modules/", "apps/*/dist/", "apps/*/node_modules/", "*.d.ts"],
};
