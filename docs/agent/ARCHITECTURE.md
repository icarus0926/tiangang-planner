# 架构与运行模型

## 系统边界

天罡是单用户、本地优先的 Web 应用：一个 Node.js 进程同时提供 Express JSON API 和静态前端，一个 SQLite 文件保存全部业务数据。浏览器不直接持久化业务对象，只在 `localStorage` 保存访问口令。

```text
浏览器 public/index.html
        │  fetch /api/* + x-dash-key
        ▼
Express server.js
        │  同步 node:sqlite 查询 / 事务 / 审计
        ▼
data/tiangang.db  ── WAL checkpoint + copy ──> backups/*.db
```

项目没有前端构建步骤、服务端 ORM、WebSocket 或后台队列。一次前端写操作成功后会重新请求 `/api/data` 并重绘各页面。

## 模块职责

### `db.js`

- 用 Node 内置 `node:sqlite` 的 `DatabaseSync` 打开数据库。
- 启用 `journal_mode=WAL` 和 `foreign_keys=ON`。
- 幂等创建 `goals`、`tasks`、`executions`、`audit`、`meta` 五张表及索引。
- `tx(db, fn)` 提供同步事务；异常时回滚并继续抛出。
- `backup()` 先执行 WAL checkpoint，再复制主库，按文件名排序滚动保留 30 份。
- `DB_PATH` 可由环境变量覆盖，测试必须使用临时路径。

### `server.js`

- 读取项目根 `.env`，创建数据库并在启动时备份；之后每 24 小时备份一次。
- 对 `/api/*` 执行可选的 `x-dash-key` 认证。
- 集中实现任务树遍历、完成冒泡、成环检查、顺延与审计。
- 托管 `public/`；根页面和 HTML 禁止浏览器缓存。
- 仅直接执行文件时监听端口；被 `test.mjs` 导入时只导出 `{ app, db }`。

### `public/index.html`

- 单文件 HTML/CSS/原生 JavaScript，无打包器和第三方可视化库。
- 全量数据缓存为 `DATA`，任务索引为 `MAP`，父子索引为 `KIDS`。
- 五个导航页共享任务树、展开状态和通用 mutation 包装。
- 甘特图使用 DOM，任务全景图使用 Canvas 自绘力导向布局。

### `migrate/`

- `1-notion-snapshot.mjs` 从旧 Notion 工作区制作一次性 JSON 快照。
- `2-import.mjs` 将快照转换为当前 SQLite 结构。
- 迁移不是应用运行依赖，也不是增量同步机制。

## 数据关系

```text
goals 1 ───── 0..n tasks.goal_id
tasks 1 ───── 0..n tasks.parent_id       递归树，删除父节点时数据库级联
tasks 1 ───── 0..n executions.task_id    删除任务后执行记录保留，task_id 置空
audit                                      非外键业务日志
meta                                       当前保存 tags JSON
```

任务的展示层级由字段组合决定，不由独立的年月周日实体决定。具体规则见 `DOMAIN_MODEL.md`。

## 启动与配置

- 规范端口：`8790`。
- `DASH_PASSWORD` 非空时，所有 API 请求必须带同值的 `x-dash-key`；为空时 API 不设口令门。
- `start.bat` 会探测 `http://localhost:8790`，已有服务时只打开浏览器。
- 首次启动会自动创建 `data/tiangang.db` 和备份目录。

当前口令门适合本机访问，不是互联网级身份系统：没有用户、会话、TLS、限流或权限分级。若要暴露到公网，必须在外层增加 HTTPS 和可靠认证。

## 一致性边界

- 级联完成/重开、整树归档/恢复、re-parent 关键更新和顺延使用服务端事务。
- 审计目标是追踪写操作，但并非每条审计都与业务写处于同一个事务；不要把它当作强一致事件源。
- 前端某些批量交互会顺序调用多个 PATCH。服务端保证每个请求原子，不保证整组浏览器请求原子。
- `/api/data` 计算的 `leaves`、`done_leaves` 是派生值，不存数据库。

## 性能模型

这是本地、小规模任务数据模型：同步 SQLite 简化了一致性，`/api/data` 全量读取非归档任务并在内存后序计算进度。若数据规模显著增长，应先测量接口、重绘和图布局，再决定分页、增量同步或 worker 化；不要预先引入复杂基础设施。
