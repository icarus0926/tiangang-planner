# Tiangang Agent Memory Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为天罡项目创建一套以当前代码为准、适合后续 Agent 渐进读取和维护的版本化 Memory 文档。

**Architecture:** 根目录 `AGENTS.md` 是自动发现入口，`docs/agent/` 按架构、领域/API、前端、工作流与当前记忆拆分。稳定契约与易变化的项目快照分开，README 只同步已确认的用户级文档漂移。

**Tech Stack:** Markdown、Node.js 22.5+、Express 4、`node:sqlite`、原生 HTML/CSS/JavaScript、PowerShell。

## Global Constraints

- 不提交 `.env`、`data/`、`backups/`、`migrate/snapshot.json` 或任何真实口令/token。
- 不改变产品业务逻辑；除统一既有 8790 启动约定外，本计划只新增或同步文档。
- 代码与测试优先于旧 README；所有契约描述必须可定位到当前文件/函数/路由。
- Windows 主运行端口当前为 8790；将 `server.js`、`.env.example` 与启动器统一到该端口。
- 最终运行 `npm test`、文档链接检查、关键覆盖检查和 `git diff --check`。

---

### Task 1: 建立 Agent 文档入口与路由

**Files:**
- Create: `AGENTS.md`
- Create: `docs/agent/README.md`

**Interfaces:**
- Consumes: 当前仓库结构与安全约束。
- Produces: 新 Agent 的必读入口、任务类型到文档的路由表。

- [x] **Step 1:** 在 `AGENTS.md` 写入项目摘要、不可破坏语义、安全边界、验证门和阅读顺序。
- [x] **Step 2:** 在 `docs/agent/README.md` 写入文档索引、按任务读取建议、事实优先级和更新责任。
- [x] **Step 3:** 检查两份入口中引用的所有相对路径存在。

### Task 2: 记录架构、领域模型与 API

**Files:**
- Create: `docs/agent/ARCHITECTURE.md`
- Create: `docs/agent/DOMAIN_MODEL.md`
- Create: `docs/agent/API_REFERENCE.md`

**Interfaces:**
- Consumes: `db.js` 的 `SCHEMA/open/tx/backup`，`server.js` 的助手与 15 个路由。
- Produces: 文件责任图、五表模型、任务状态机、时间语义、请求与副作用契约。

- [x] **Step 1:** 记录进程、存储、静态前端、迁移工具和启动/写入/刷新数据流。
- [x] **Step 2:** 记录 `goals/tasks/executions/audit/meta` 字段及 `goal/pool/planned/done/archived` 状态语义。
- [x] **Step 3:** 逐路由记录鉴权、输入、输出、校验、事务、审计与级联副作用。
- [x] **Step 4:** 用 `rg "app\\.(get|post|patch|delete)" server.js` 对照路由数量和名称。

### Task 3: 记录前端交互与开发工作流

**Files:**
- Create: `docs/agent/FRONTEND_GUIDE.md`
- Create: `docs/agent/DEVELOPMENT_WORKFLOW.md`

**Interfaces:**
- Consumes: `public/index.html` 的状态、渲染函数、Gantt、force graph 和 boot 事件；`test.mjs`、`start.bat`、迁移脚本。
- Produces: 页面/函数映射、交互不变量、变更矩阵、测试与浏览器 QA 流程。

- [x] **Step 1:** 记录全局状态、索引、五页渲染、共享树组件和弹层。
- [x] **Step 2:** 记录甘特真实日期差量、父条带子树、信封/幽灵条、同层排序和完成沉底。
- [x] **Step 3:** 记录全景图的建图、力学、聚焦/返回/跳页和时间筛选语义。
- [x] **Step 4:** 记录安装、启动、端口、集成测试、浏览器探针、备份、迁移、安全和发布检查表。

### Task 4: 形成当前项目记忆与修正文档漂移

**Files:**
- Create: `docs/agent/PROJECT_MEMORY.md`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `server.js`

**Interfaces:**
- Consumes: 当前 `main` 基线、最近提交、运行库只读统计与代码审查结果。
- Produces: 决策记录、已知风险、当前验证基线和准确的用户级说明。

- [x] **Step 1:** 记录已确认的架构决策、最新交互语义和当前风险，不记录个人任务内容。
- [x] **Step 2:** 修正 README 中父任务完成、动态标签池、goal 状态、测试数量、表数量和 API 列表。
- [x] **Step 3:** 将 `server.js`、`.env.example` 的默认端口与 Windows 启动器统一为 8790。

### Task 5: 验证并提交

**Files:**
- Verify: all files above

**Interfaces:**
- Consumes: 完成后的文档集。
- Produces: 可复核的测试与一致性证据。

- [x] **Step 1:** 运行 `npm test`，期望 `41 通过, 0 失败`（含日期型部分完成任务簇顺延回归测试）。
- [x] **Step 2:** 运行 Markdown 相对链接存在性检查，期望 0 个缺失目标。
- [x] **Step 3:** 对照 `server.js` 路由和 `db.js` 状态/表名做关键覆盖检查。
- [x] **Step 4:** 运行 `git diff --check` 和敏感信息扫描。
- [ ] **Step 5:** 检查 `git diff --stat` 与文档内容，提交并推送 `main`。
