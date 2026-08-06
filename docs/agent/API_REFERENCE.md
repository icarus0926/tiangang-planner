# REST API 参考

## 通用约定

- 基址：`http://localhost:8790`。
- JSON 请求需 `Content-Type: application/json`。
- 若配置了 `DASH_PASSWORD`，所有 `/api/*` 请求需头 `x-dash-key: <password>`。
- 成功写操作返回 `{ "ok": true, ... }`；失败通常返回 `{ "error": "..." }`。
- 当前没有统一 schema 校验层；调用方必须发送本文所列类型和 ISO 日期格式。

## 数据快照

### `GET /api/data`

查询参数：`archived=1` 时包含已归档任务，默认排除。

返回：

```json
{
  "goals": [],
  "tasks": [{ "id": 1, "leaves": 3, "done_leaves": 1 }],
  "executions": [],
  "tags": ["学习", "工作"],
  "snapshot": "2026-08-03T00:00:00.000Z"
}
```

`executions` 只返回数据库当前日期往前 45 天以来的数据；关联任务时附 `task_name` 和 `task_parent`。`tags` 在尚未保存配置时可能是 `null`。

## 年度目标

### `POST /api/goal`

请求：`{ name, domain?, criteria? }`。`name` 必填。返回新建 `goal`。

### `PATCH /api/goal/:id`

允许字段：`name`、`domain`、`criteria`、`progress`、`status`、`sort`。至少一个字段。

### `DELETE /api/goal/:id`

删除目标。任务保留，其 `goal_id` 由外键置空。

## 任务

### `POST /api/task`

请求字段：

```json
{
  "name": "任务名",
  "parent_id": null,
  "goal_id": null,
  "kind": "学习",
  "priority": "P1",
  "month": "2026-08",
  "start": "2026-08-03",
  "end": "2026-08-05",
  "status": "pool"
}
```

只有 `name` 必填。创建接口的日期字段名是 `start`、`end`，返回与 PATCH 使用 `start_date`、`end_date`。初始状态由领域规则推导；显式 `status` 目前只识别 `pool` 覆盖。

### `PATCH /api/task/:id`

允许字段：`name`、`parent_id`、`goal_id`、`kind`、`priority`、`status`、`month`、`start_date`、`end_date`、`sort`、`note`。

- 用 `parent_id:null` 独立成根节点。
- 非空父 ID 必须存在，且不能是自身或自身后代。
- 不允许直接写 `status:'done'`；完成必须走 toggle 接口。

### `POST /api/task/:id/toggle-done`

无需请求体。未完成节点会连同整棵子树完成；已完成节点会连同整棵子树重开，之后重算祖先。

### `DELETE /api/task/:id`

默认软归档整棵子树。`?hard=1` 物理删除，但根节点必须已经是 `archived`。

### `POST /api/task/:id/restore`

恢复 `done` 或 `archived` 节点及其整棵子树，按各节点字段重新推导状态。

## 顺延

### `POST /api/rollover`

月顺延：

```json
{ "scope": "month", "from": "2026-08", "to": "2026-09" }
```

日顺延：

```json
{ "scope": "day", "from": "2026-08-03", "to": "2026-08-04" }
```

返回 `{ ok, count }`，其中月顺延的 `count` 是实际顺延的最高未完成任务簇数量。日期落在来源月但 `month` 为空的部分完成任务簇也会进入下月；已完成节点、`done_at` 和原甘特日期保持不变。`scope` 仅接受 `month` 或 `day`。

### `POST /api/rollover/past`

将目标周期之前的全部未完成事项事务顺延到目标周期。三个 scope 的请求格式为：

```json
{ "scope": "day", "to": "2026-08-06" }
```

```json
{ "scope": "week", "to": "2026-08-03" }
```

```json
{ "scope": "month", "to": "2026-08" }
```

`day` 的 `to` 必须是有效 `YYYY-MM-DD`；`week` 同样使用有效 ISO 日期但必须是周一；`month` 必须是有效 `YYYY-MM`。成功响应为 `{ "ok": true, "count": 0, "roots": [], "merged": 0 }`。`count` 为实际处理的 execution 或任务节点数；`roots` 为周/月被处理任务簇的根 ID（daily 固定为 `[]`）；`merged` 为 daily 因目标日同任务未完成 execution 而合并、删除旧记录的次数（week/month 为 `0`）。无效目标返回 400。

- `day`：移动 `date < to` 的未完成 execution。首次移动时将旧日期写入 `rollover_origin_date`，后续不覆盖。关联任务在目标日已有未完成 execution 时，保留目标记录、将其来源更新为两条记录中最早来源，并删除旧记录。
- `week`：选择目标周一之前的过往未完成任务簇，所有实际排期统一平移完整周数；来源周写入 `rollover_origin_week`，格式为首次排期所在周的周一 `YYYY-MM-DD`。周是纯日期窗口，不新增或持久化 `week` 字段。
- `month`：选择目标月之前的过往未完成任务簇，来源月写入 `rollover_origin_month`，格式为 `YYYY-MM`。有日期的簇以最早排期锚定目标月同日；例如 1 月 31 日到非闰年 2 月会 clamp 到 2 月 28 日。该簇所有实际移动节点使用同一个 `deltaDays`，因此保持时长和树内相对位置。

周/月只移动实际过期的未完成节点；部分完成簇的已完成后代、`done_at` 和完成历史不移动。无日期普通任务池节点，以及与目标窗口相交或已在当前/未来周期的节点不移动。请求都在单一事务中写批次审计；周/月另对实际移动节点写逐项审计，daily 发生同任务合并时写含 `removed_id/kept_id` 的合并审计。周/月批次审计含 `to/count/roots/origins`；任何节点失败会回滚数据、来源字段和审计。旧的 `POST /api/rollover` 及其“未完成顺延明天/下月”前端入口不受影响。

## 每日执行

### `POST /api/execution`

二选一：

```json
{ "task_id": 12, "date": "2026-08-03" }
```

```json
{ "text": "临时待办", "date": "2026-08-03" }
```

缺少日期或任务/文本时返回 400；关联任务不存在返回 400；同一任务同一天重复返回 409，并附已有执行 ID。

### `PATCH /api/execution/:id`

请求 `{ "done": true }` 或 `{ "done": false }`。关联叶子任务会联动任务状态并冒泡；关联非叶子只修改 execution。

### `POST /api/execution/:id/promote`

把自由文本 execution 升格为新的 `pool` 根任务，并把 execution 改为关联该任务。已经有关联任务时返回 400。

### `DELETE /api/execution/:id`

物理删除单条执行记录，不删除关联任务。

## 标签

### `POST /api/tags`

请求：`{ "tags": ["学习", "工作"] }`。服务端清理空值、重复、过长值和保留项 `其他`，最多保存 30 个。调用方重命名或删除标签时，还需同步 PATCH 相关任务的 `kind`；该接口本身只保存标签列表。

## 重要错误语义

| 状态码 | 典型原因 |
| --- | --- |
| 400 | 缺字段、无可更新字段、非法父节点、成环、直接写 done、非法恢复/硬删 |
| 401 | `x-dash-key` 缺失或不匹配 |
| 404 | 目标、任务或 execution 不存在 |
| 409 | 同一任务同一天已有 execution |
| 500 | SQLite、类型、约束或未捕获业务错误 |
