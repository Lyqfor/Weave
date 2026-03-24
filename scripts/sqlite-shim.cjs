/**
 * node:sqlite shim — 让 Vite/Vitest 能解析 Node.js 24 内置 node:sqlite 模块。
 * Vite 5 会剥离 "node:" 前缀导致解析失败，此 shim 用 createRequire 在运行时加载真实模块。
 */
"use strict";

const { createRequire } = require("node:module");
const req = createRequire(__filename);
const sqlite = req("node:sqlite");

module.exports = sqlite;
