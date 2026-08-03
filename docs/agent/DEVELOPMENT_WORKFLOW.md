# 开发、验证与运维工作流

## 环境要求

- Node.js `>=22.5.0`，因为项目使用内置 `node:sqlite`。
- npm 依赖只有 `express` 和 `dotenv`，不需要 Python、编译器或原生 SQLite 包。
- 规范本地地址为 `http://localhost:8790`。

```powershell
cd D:\1AI\人生规划\tiangang
npm install
Copy-Item .env.example .env
npm start
```

不要提交 `.env`。Windows 可双击 `start.bat`；它会复用已经监听 8790 的服务。

## 修改前

1. 运行 `git status --short`，区分用户已有改动和本次改动。
2. 阅读 `AGENTS.md` 和相关专题文档。
3. 搜索现有函数和测试，确认实际行为，不从 README 猜实现。
4. 涉及真实数据库时先确认自动备份成功；诊断优先只读查询。

## 测试策略

主测试是 `test.mjs` 的真实 HTTP + 临时 SQLite 集成测试：

```powershell
npm test
```

测试通过 `DB_PATH` 指向临时目录并使用独立端口，覆盖建树、完成级联与冒泡、re-parent 成环防护、归档恢复、顺延、execution 联动/升格、目标和标签等关键行为。

新增后端行为时先增加最小失败用例，再修改实现。不要让测试连接 `data/tiangang.db`。如果固定测试端口被占用，先确认占用进程，不要杀掉用户正在使用的 8790 服务。

文档或代码提交前至少执行：

```powershell
npm test
git diff --check
git status --short
```

前端变更还需真实 Chrome 手工或自动化验证。测试数据应使用临时数据库；截图可使用演示数据，避免把个人数据库内容提交到公开仓库。

## 数据库与备份

- 默认库：`data/tiangang.db`。
- SQLite 使用 WAL；复制数据库前必须先 checkpoint，应用的 `backup()` 已处理。
- 自动备份：进程启动时一次，之后每 24 小时一次，保留 30 个 `.db`。
- 恢复时先停止服务、保存现库副本，再把选定备份复制为主库；启动后检查 `/api/data`。
- schema 当前没有版本迁移框架。新增列优先采用幂等迁移，并补老库升级测试，不能只修改 `CREATE TABLE IF NOT EXISTS` 后假设旧库会自动加列。

## Notion 一次性迁移

仅旧用户需要：

1. `node migrate/1-notion-snapshot.mjs` 读取旧 `sync-server/.env` 中的 Notion 配置并生成 `migrate/snapshot.json`。
2. `node migrate/2-import.mjs` 把快照导入空的 SQLite 库。
3. 数据库已存在时脚本拒绝执行；`--force` 会删除现有 DB/WAL/SHM 后重建，属于破坏性操作，必须先备份并明确目标路径。

迁移把旧任务池与月度项合并、待办块转为子任务、每日项转为 execution。它不是同步器，也不保证增量幂等。`snapshot.json` 含个人信息且已被 gitignore。

## 提交与发布清单

1. 测试和浏览器闭环通过。
2. 领域、API、交互或运维变化已同步到 `docs/agent/` 和必要的 README。
3. `git diff --check` 无空白错误。
4. 检查暂存文件不含 `.env`、数据库、备份、迁移快照、token、口令或私人任务数据。
5. 提交作者使用用户身份，不添加 Claude 或其他 Agent 的 Co-Authored-By。
6. 推送后核对公开仓库默认分支和 README 渲染。

## 常用诊断

```powershell
# 端口
Get-NetTCPConnection -LocalPort 8790 -State Listen

# 无口令或已准备口令头时检查数据接口
Invoke-RestMethod http://127.0.0.1:8790/api/data

# 仅读取 Git 状态
git status --short
git log -5 --oneline
```

启用口令后，用临时变量构造请求头，避免在命令历史和输出中打印真实口令。
