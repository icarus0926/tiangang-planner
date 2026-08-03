# 天罡项目 Agent 入口

本仓库是本地优先的递归任务树规划器。开始修改前，先把本文件和与任务相关的 `docs/agent/` 文档读完；源码是最终事实，文档与源码冲突时先核实源码，再在同一变更中修正文档。

## 按任务加载上下文

- 总入口与阅读顺序：[`docs/agent/README.md`](docs/agent/README.md)
- 后端、数据库、进程：[`docs/agent/ARCHITECTURE.md`](docs/agent/ARCHITECTURE.md)
- 状态、任务树、完成与时间语义：[`docs/agent/DOMAIN_MODEL.md`](docs/agent/DOMAIN_MODEL.md)
- 路由和请求字段：[`docs/agent/API_REFERENCE.md`](docs/agent/API_REFERENCE.md)
- 页面、甘特、任务图和前端状态：[`docs/agent/FRONTEND_GUIDE.md`](docs/agent/FRONTEND_GUIDE.md)
- 安装、测试、迁移、发布：[`docs/agent/DEVELOPMENT_WORKFLOW.md`](docs/agent/DEVELOPMENT_WORKFLOW.md)
- 当前决策、已知风险、近期快照：[`docs/agent/PROJECT_MEMORY.md`](docs/agent/PROJECT_MEMORY.md)

## 不可无意破坏的契约

1. `tasks.parent_id` 表达唯一的递归任务树；子任务是完整任务，不是附属步骤。
2. 年、月、周、日是同一任务的不同投影，不复制任务。周是 7 天日期窗口，没有周表或周字段。
3. 所有任务都可勾选。勾父任务会级联整棵子树；子节点变化会向祖先冒泡。完成历史看 `done_at`，不是 `month`。
4. 排序只改 `sort`，挂靠只改 `parent_id`。任何 re-parent 必须阻止把节点挂到自己或自己的后代。
5. 自由文本每日待办保留在 `executions`；只有显式“升格”才创建任务。
6. 删除任务默认归档整棵子树；硬删除只允许已归档节点。不得绕过外键、事务和审计约束。
7. 真实数据、备份、口令、Notion 凭证和迁移快照不得提交。禁止提交 `.env`、`data/`、`backups/`、`migrate/snapshot.json`。
8. 不引入前端框架、构建链或原生 SQLite 依赖，除非用户明确同意架构变更。

## 最小验证

代码变更至少执行：

```powershell
npm test
git diff --check
```

涉及前端交互时，还要在真实浏览器检查目标页面、控制台错误和一次完整写入闭环。涉及数据结构或完成逻辑时，先为行为补集成测试。不要用真实 `data/tiangang.db` 做破坏性测试。

## 文档维护

修改领域规则、API、页面交互、运行方式或已知风险时，同一提交更新对应 `docs/agent/*.md`。`PROJECT_MEMORY.md` 只记录仍影响后续开发的当前事实，不写流水账。
