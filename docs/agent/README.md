# Agent Memory 导航

这组文档给后续开发 Agent 提供渐进式上下文。不要每次全量读取：先读根目录 `AGENTS.md`，再按任务选择下表中的文档。

| 修改范围 | 必读文档 | 常见源码 |
| --- | --- | --- |
| SQLite、备份、进程、认证 | `ARCHITECTURE.md`、`DEVELOPMENT_WORKFLOW.md` | `db.js`、`server.js`、`.env.example`、`start.bat` |
| 任务状态、完成、归档、顺延 | `DOMAIN_MODEL.md`、`API_REFERENCE.md` | `server.js`、`test.mjs` |
| REST 接口或前后端字段 | `API_REFERENCE.md`、`DOMAIN_MODEL.md` | `server.js`、`public/index.html` |
| 月/周/日页面、甘特、大纲 | `FRONTEND_GUIDE.md`、`DOMAIN_MODEL.md` | `public/index.html` |
| 全景任务图 | `FRONTEND_GUIDE.md`、`PROJECT_MEMORY.md` | `public/index.html` 中 `graph*` 函数 |
| 安装、迁移、测试、发布 | `DEVELOPMENT_WORKFLOW.md`、`PROJECT_MEMORY.md` | `migrate/`、`test.mjs`、`README.md` |
| 评估技术债或开始新迭代 | `PROJECT_MEMORY.md`，再读相关专题 | 全仓库 |

## 文档职责

- [`ARCHITECTURE.md`](ARCHITECTURE.md)：组件边界、数据流、持久化和一致性边界。
- [`DOMAIN_MODEL.md`](DOMAIN_MODEL.md)：业务对象、状态机和不变量，是行为改动的首要依据。
- [`API_REFERENCE.md`](API_REFERENCE.md)：当前服务端路由、字段和错误约定。
- [`FRONTEND_GUIDE.md`](FRONTEND_GUIDE.md)：单文件前端的内部地图及复杂交互规则。
- [`DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md)：安全启动、测试、迁移、备份和发布清单。
- [`PROJECT_MEMORY.md`](PROJECT_MEMORY.md)：当前版本、重要决策、技术债和下一步建议。

## 事实优先级

1. 当前源码、SQLite schema 和可复现测试结果。
2. `docs/agent/` 中的稳定契约。
3. 根 `README.md` 的用户级说明。
4. `PROJECT_MEMORY.md` 的日期化快照与历史说明。

若发现漂移，先以代码和测试确认真实行为，再同时修复实现或文档。不要仅为了让文档“看起来一致”而掩盖代码缺陷。
