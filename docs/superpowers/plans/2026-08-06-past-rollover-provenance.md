# Past Rollover Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为日、周、月页面增加“全部过往未完成 → 当前周期”的事务顺延，并持久显示首次来源日期、来源周或来源月。

**Architecture:** 在旧 SQLite 库上幂等补充三个首次来源列；新增无状态日期/树选择模块 `rollover.js`，由 Express 的新事务接口 `POST /api/rollover/past` 调用。前端继续使用单文件页面，在现有日/周/月渲染函数中加入按钮和来源徽章；原 `/api/rollover` 与向明天/下月按钮保持不变。

**Tech Stack:** Node.js 22.5+、内置 `node:sqlite`、Express 4、原生 HTML/CSS/JavaScript、Playwright CLI + 本机 Chrome。

## Global Constraints

- 一次处理当前周期之前的**全部**未完成事项，不限上一周期。
- 首次来源不可覆盖：多次顺延始终保留最初日期、最初周一或最初月份。
- 顺延同步平移实际排期；周保持星期/时长，月保持时长和树内相对位置。
- 已完成节点、`done_at`、完成历史、年度目标和无日期普通任务池任务不移动。
- 周继续是纯 7 天窗口，不新增业务 `week` 字段。
- 原 `POST /api/rollover`、`未完成顺延明天` 和 `未完成顺延到下月` 保持兼容。
- 不新增第三方运行依赖或前端构建步骤。
- 当前主目录已有未提交的 `package-lock.json` 引擎同步差异；不得暂存、修改、覆盖或提交该文件。
- 仓库公开；不得提交 `.env`、数据库、备份、个人任务快照、Notion token 或真实访问口令。
- 提交作者固定为 `icarus0926 <kemuli0926@gmail.com>`，不得添加 Agent/Claude co-author trailer。

---

### Task 1: 旧库幂等补列与 API 数据暴露

**Files:**
- Modify: `db.js:15-63`
- Modify: `test.mjs:1-30`

**Interfaces:**
- Consumes: `open(dbPath)` 与现有 `SCHEMA`。
- Produces: `ensureColumn(db, table, column, type)`；`tasks.rollover_origin_week`、`tasks.rollover_origin_month`、`executions.rollover_origin_date`。

- [x] **Step 1: 写旧数据库迁移失败测试**

在 `test.mjs` 导入 `DatabaseSync`，创建一个只含旧字段的独立临时库，再调用 `open()`：

```js
import { DatabaseSync } from 'node:sqlite';

const legacyPath = path.join(HERE, 'data', `legacy-${Date.now()}.db`);
const legacy = new DatabaseSync(legacyPath);
legacy.exec(`
  CREATE TABLE goals(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
  CREATE TABLE tasks(
    id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES tasks(id),goal_id INTEGER REFERENCES goals(id),
    name TEXT NOT NULL,kind TEXT,priority TEXT,status TEXT,month TEXT,start_date TEXT,end_date TEXT,
    sort REAL,note TEXT,created_at TEXT,done_at TEXT,notion_id TEXT
  );
  CREATE TABLE executions(
    id INTEGER PRIMARY KEY,task_id INTEGER REFERENCES tasks(id),text TEXT,date TEXT NOT NULL,
    done INTEGER DEFAULT 0,notion_id TEXT,UNIQUE(task_id,date)
  );
`);
legacy.close();
const { open: openDb } = require('./db.js');
const migrated = openDb(legacyPath);
const taskCols = migrated.prepare('PRAGMA table_info(tasks)').all().map(x => x.name);
const execCols = migrated.prepare('PRAGMA table_info(executions)').all().map(x => x.name);
ok(taskCols.includes('rollover_origin_week') && taskCols.includes('rollover_origin_month'), '旧库自动补任务来源列');
ok(execCols.includes('rollover_origin_date'), '旧库自动补每日来源列');
migrated.close();
for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(legacyPath + suf); } catch {} }
```

- [x] **Step 2: 运行测试确认 RED**

Run: `npm test`

Expected: 新增两条“旧库自动补来源列”失败；原 44 条继续通过。

- [x] **Step 3: 实现幂等列迁移**

在 `db.js` 增加：

```js
function ensureColumn(db, table, column, type = 'TEXT') {
  const names = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name));
  if (!names.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
```

在 `open()` 的 `db.exec(SCHEMA)` 后执行：

```js
ensureColumn(db, 'tasks', 'rollover_origin_week');
ensureColumn(db, 'tasks', 'rollover_origin_month');
ensureColumn(db, 'executions', 'rollover_origin_date');
```

同时把三列写进新建库的 `SCHEMA`。`GET /api/data` 当前使用任务/执行记录全字段查询，无需新增映射代码；测试必须确认返回对象含这些键。

- [x] **Step 4: 运行测试确认 GREEN**

Run: `npm test`

Expected: `46 通过, 0 失败`；连续调用两次 `open(legacyPath)` 不报 duplicate column。

- [x] **Step 5: 提交迁移**

```powershell
git add db.js test.mjs
git commit -m "支持顺延来源字段兼容迁移"
```

---

### Task 2: 可测试的日期平移与过往任务簇选择

**Files:**
- Create: `rollover.js`
- Modify: `test.mjs:15-45`

**Interfaces:**
- Consumes: task-like objects `{ id,parent_id,status,month,start_date,end_date }`。
- Produces:
  - `validateTarget(scope, to): boolean`
  - `mondayOfIso(date): string`
  - `addDaysIso(date, delta): string`
  - `dayDiffIso(from, to): number`
  - `monthAnchorDelta(anchorDate, targetMonth): number`
  - `selectPastRoots(tasks, scope, to): Array<{ root, nodes, origin, deltaDays }>`

- [x] **Step 1: 写纯函数失败测试**

在 `test.mjs` 加载尚不存在的模块并断言：

```js
let rollHelp = {};
try { rollHelp = require('./rollover.js'); } catch (_) {}
const sample = [
  {id:1,parent_id:null,status:'planned',month:null,start_date:null,end_date:null},
  {id:2,parent_id:1,status:'planned',month:null,start_date:'2026-07-22',end_date:'2026-07-24'},
  {id:3,parent_id:1,status:'done',month:null,start_date:'2026-07-20',end_date:'2026-07-21'},
  {id:4,parent_id:null,status:'planned',month:'2026-08',start_date:'2026-08-04',end_date:'2026-08-08'}
];
ok(rollHelp.validateTarget?.('week','2026-08-03') && !rollHelp.validateTarget?.('week','2026-08-04'), '周目标必须是周一');
ok(rollHelp.monthAnchorDelta?.('2026-01-31','2026-02') === 28, '月末锚点夹到目标月末');
const picked = rollHelp.selectPastRoots?.(sample,'week','2026-08-03') || [];
ok(picked.length === 1 && picked[0].root.id === 1 && picked[0].nodes.map(x=>x.id).join(',') === '2', '无日期父簇提升且完成子节点不移动');
ok(picked[0]?.origin === '2026-07-20' && picked[0]?.deltaDays === 14, '来源周与整周平移差正确');
```

来源周字段保存周一，因此样例中 7 月 22 日所在周来源为 `2026-07-20`。

- [x] **Step 2: 运行测试确认 RED**

Run: `npm test`

Expected: 四条纯函数断言失败，原因是 `rollover.js` 不存在。

- [x] **Step 3: 写最小日期助手**

`rollover.js` 使用 UTC 中午无关的纯 ISO 计算，避免夏令时偏差：

```js
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE=/^\d{4}-\d{2}$/;
const asDate=s=>new Date(s+'T00:00:00Z');
const iso=d=>d.toISOString().slice(0,10);
function addDaysIso(s,n){const d=asDate(s);d.setUTCDate(d.getUTCDate()+n);return iso(d);}
function dayDiffIso(a,b){return Math.round((asDate(b)-asDate(a))/864e5);}
function mondayOfIso(s){const d=asDate(s),off=(d.getUTCDay()+6)%7;return addDaysIso(s,-off);}
function validateTarget(scope,to){
  if(scope==='month'){
    if(!MONTH_RE.test(to))return false;
    const month=+to.slice(5,7);return month>=1&&month<=12;
  }
  if(!DATE_RE.test(to)||Number.isNaN(asDate(to).getTime())||iso(asDate(to))!==to)return false;
  return scope==='day'||(scope==='week'&&mondayOfIso(to)===to);
}
function monthAnchorDelta(anchor,targetMonth){
  const day=+anchor.slice(8,10),[y,m]=targetMonth.split('-').map(Number);
  const max=new Date(Date.UTC(y,m,0)).getUTCDate();
  return dayDiffIso(anchor,`${targetMonth}-${String(Math.min(day,max)).padStart(2,'0')}`);
}
```

- [x] **Step 4: 实现任务簇选择**

`selectPastRoots()` 必须：

1. 忽略 `done/archived` 节点。
2. week 只认有效结束日期 `< to`；month 认 `month < to` 或有效结束日期 `< to-01`。
3. 允许无日期、无月份父节点把全部过期分支聚成一个簇；若父自身已有当前/未来月份或与当前窗口相交，则停止提升，选择实际过期子分支。
4. `nodes` 只包含本次实际移动的未完成过期节点；完成子节点不返回。
5. week 的 `origin` 是最早移动日期所在周一，`deltaDays=dayDiffIso(origin,to)`；month 的 `origin` 是最早旧月份，日期簇用最早开始日计算 `monthAnchorDelta()`。
6. 用 ID 去重根和节点，并按原 `sort/id` 稳定排序。

模块最后导出：

```js
module.exports={validateTarget,mondayOfIso,addDaysIso,dayDiffIso,monthAnchorDelta,selectPastRoots};
```

- [x] **Step 5: 运行测试并提交**

Run: `npm test`

Expected: 所有测试通过，纯函数不打开数据库、不读取系统今天。

```powershell
git add rollover.js test.mjs
git commit -m "增加过往任务簇日期平移算法"
```

---

### Task 3: 全量过往每日待办事务顺延

**Files:**
- Modify: `server.js:235-278`
- Modify: `test.mjs`（在现有标签测试之后、审计测试之前追加新 API 测试，避免改变旧测试前置数据）

**Interfaces:**
- Consumes: `validateTarget('day', to)`、SQLite `executions`、现有 `tx()`/`audit()`。
- Produces: `POST /api/rollover/past` 的 `scope:'day'` 分支，返回 `{ok,count,roots:[],merged}`。

- [x] **Step 1: 写每日 API 失败测试**

创建跨多天记录、已完成记录和同任务今天已有记录：

```js
const dayTask=(await api('POST','/api/task',{name:'每日关联任务'})).body.task;
const oldFree=(await api('POST','/api/execution',{text:'旧自由待办',date:'2026-01-01'})).body.execution;
const oldLinked=(await api('POST','/api/execution',{task_id:dayTask.id,date:'2026-01-02'})).body.execution;
const todayLinked=(await api('POST','/api/execution',{task_id:dayTask.id,date:'2026-01-10'})).body.execution;
const completedOld=(await api('POST','/api/execution',{text:'旧已完成',date:'2026-01-03'})).body.execution;
await api('PATCH',`/api/execution/${completedOld.id}`,{done:true});
const pastDay=await api('POST','/api/rollover/past',{scope:'day',to:'2026-01-10'});
ok(pastDay.status===200&&pastDay.body.count===2&&pastDay.body.merged===1,'全部过往每日待办拉到今天并合并冲突');
data=(await api('GET','/api/data')).body;
const movedFree=data.executions.find(x=>x.id===oldFree.id);
const keptToday=data.executions.find(x=>x.id===todayLinked.id);
ok(movedFree.date==='2026-01-10'&&movedFree.rollover_origin_date==='2026-01-01','自由待办保留首次来源日');
ok(keptToday.rollover_origin_date==='2026-01-02'&&!data.executions.some(x=>x.id===oldLinked.id),'关联待办冲突合并到今天记录');
ok(data.executions.find(x=>x.id===completedOld.id).date==='2026-01-03','已完成历史不顺延');
```

再调用一次接口，断言 `count===0`；创建已带 `rollover_origin_date='2026-07-20'` 的旧记录后顺延，断言来源不覆盖。

- [x] **Step 2: 运行测试确认 RED**

Run: `npm test`

Expected: `/api/rollover/past` 返回 404。

- [x] **Step 3: 实现每日事务分支**

在旧 `/api/rollover` 后新增新路由。day 分支流程：

```js
const rows=db.prepare(`SELECT * FROM executions WHERE date<? AND done=0 ORDER BY date,id`).all(to);
const targetByTask=new Map(db.prepare(`SELECT * FROM executions WHERE date=? AND done=0 AND task_id IS NOT NULL`).all(to).map(x=>[x.task_id,x]));
```

- 自由文本：`UPDATE executions SET date=?, rollover_origin_date=COALESCE(rollover_origin_date,date) WHERE id=?`。
- 关联任务无目标冲突：同样更新，并加入 `targetByTask`。
- 关联任务已有目标记录：把保留记录来源更新为所有来源/旧日期的最小值，删除旧记录，`merged++`，审计 `{removed_id,kept_id}`。
- `count` 统计被处理的旧记录数，不把已在今天的记录计入。
- 整批包在一次 `tx(db,...)` 中；接口外层校验日期。

- [x] **Step 4: 运行测试并提交**

Run: `npm test`

Expected: 每日新增断言通过；旧“指定日期→下一日”断言继续通过。

```powershell
git add server.js test.mjs
git commit -m "支持全部过往待办顺延到今天"
```

---

### Task 4: 全量过往周任务簇事务顺延

**Files:**
- Modify: `server.js:235-330`
- Modify: `test.mjs`（每日新测试之后）

**Interfaces:**
- Consumes: `selectPastRoots(tasks,'week',to)` 与 `addDaysIso()`。
- Produces: `/api/rollover/past` 的 `scope:'week'` 分支；task 来源周/来源月与日期平移。

- [x] **Step 1: 写周顺延失败测试**

构造无日期父任务、未完成日期子任务、已完成日期子任务和本周相交任务：

```js
const wRoot=(await api('POST','/api/task',{name:'过往周簇'})).body.task;
const wOpen=(await api('POST','/api/task',{name:'周未完成',parent_id:wRoot.id,start:'2026-07-22',end:'2026-07-24'})).body.task;
const wDone=(await api('POST','/api/task',{name:'周已完成',parent_id:wRoot.id,start:'2026-07-20',end:'2026-07-21'})).body.task;
await api('POST',`/api/task/${wDone.id}/toggle-done`);
const wCurrent=(await api('POST','/api/task',{name:'已在本周',start:'2026-08-05',end:'2026-08-08'})).body.task;
const pastWeek=await api('POST','/api/rollover/past',{scope:'week',to:'2026-08-03'});
data=(await api('GET','/api/data')).body;
ok(pastWeek.status===200&&pastWeek.body.roots.includes(wRoot.id),'过往周簇按最高无日期父节点处理');
ok(find(wOpen.id).start_date==='2026-08-05'&&find(wOpen.id).end_date==='2026-08-07','周排期保留星期和三天时长');
ok(find(wRoot.id).rollover_origin_week==='2026-07-20'&&find(wOpen.id).rollover_origin_week==='2026-07-20','簇根和移动节点记录首次来源周');
ok(find(wDone.id).start_date==='2026-07-20'&&find(wDone.id).done_at,'已完成周子任务保持历史');
ok(find(wCurrent.id).start_date==='2026-08-05','已与本周相交任务不重复移动');
```

补充断言：目标不是周一返回 400；第二次调用 `count===0`；旧来源周不被覆盖；跨月移动时 `month` 改为目标周一月份且 `rollover_origin_month` 记录旧月。

- [x] **Step 2: 运行测试确认 RED**

Run: `npm test`

Expected: week 分支返回 500/400 或不移动数据，新增周断言失败。

- [x] **Step 3: 实现周事务分支**

```js
const rows=db.prepare(`SELECT * FROM tasks WHERE status!='archived'`).all();
const groups=selectPastRoots(rows,'week',to);
for(const g of groups){
  // 根即使无日期也写首次来源；实际节点只更新未完成项
  db.prepare(`UPDATE tasks SET rollover_origin_week=COALESCE(rollover_origin_week,?) WHERE id=?`).run(g.origin,g.root.id);
  for(const t of g.nodes){
    const ns=addDaysIso(t.start_date,g.deltaDays),ne=addDaysIso(t.end_date,g.deltaDays);
    db.prepare(`UPDATE tasks SET start_date=?,end_date=?,month=?,rollover_origin_week=COALESCE(rollover_origin_week,?),rollover_origin_month=CASE WHEN month IS NOT NULL AND month<? THEN COALESCE(rollover_origin_month,month) ELSE rollover_origin_month END WHERE id=?`)
      .run(ns,ne,to.slice(0,7),g.origin,to.slice(0,7),t.id);
  }
}
```

真实实现应使用预编译 statement，并在 audit 中记录 `{to,count,roots,origins}`。`count` 统计移动的未完成日期节点数，`roots` 返回簇根 ID。

- [x] **Step 4: 运行测试并提交**

Run: `npm test`

Expected: 周断言、每日断言和原全部测试通过。

```powershell
git add rollover.js server.js test.mjs
git commit -m "支持全部过往任务簇顺延到本周"
```

---

### Task 5: 全量过往月任务簇事务顺延

**Files:**
- Modify: `server.js:235-350`
- Modify: `test.mjs`（周新测试之后）

**Interfaces:**
- Consumes: `selectPastRoots(tasks,'month',to)`、`addDaysIso()`。
- Produces: `/api/rollover/past` 的 `scope:'month'` 分支；首次来源月、月份归属和日期簇平移。

- [x] **Step 1: 写月顺延失败测试**

```js
const mRoot=(await api('POST','/api/task',{name:'过往月簇',month:'2026-01',start:'2026-01-31',end:'2026-02-02'})).body.task;
const mOpen=(await api('POST','/api/task',{name:'月未完成',parent_id:mRoot.id,start:'2026-02-01',end:'2026-02-03'})).body.task;
const mDone=(await api('POST','/api/task',{name:'月已完成',parent_id:mRoot.id,start:'2026-01-20',end:'2026-01-21'})).body.task;
await api('POST',`/api/task/${mDone.id}/toggle-done`);
const mBare=(await api('POST','/api/task',{name:'旧月无日期',month:'2026-06'})).body.task;
const pastMonth=await api('POST','/api/rollover/past',{scope:'month',to:'2026-02'});
data=(await api('GET','/api/data')).body;
ok(pastMonth.status===200&&pastMonth.body.roots.includes(mRoot.id),'过往月任务簇进入本月');
ok(find(mRoot.id).start_date==='2026-02-28'&&find(mRoot.id).end_date==='2026-03-02','月末锚点夹取且保持持续天数');
ok(find(mOpen.id).start_date==='2026-03-01'&&find(mOpen.id).end_date==='2026-03-03','子任务按相同天数差平移');
ok(find(mRoot.id).rollover_origin_month==='2026-01'&&find(mBare.id).rollover_origin_month==='2026-06','首次来源月写入日期簇和无日期任务');
ok(find(mDone.id).start_date==='2026-01-20'&&find(mDone.id).done_at,'已完成月子任务不移动');
```

为避免样例目标早于 `mBare`，无日期断言单独调用 `to:'2026-08'`。另测：无效月份 400；第二次调用空结果；已有 `rollover_origin_month` 不覆盖；当前月父节点下的旧子分支只移动旧子分支。

- [x] **Step 2: 运行测试确认 RED**

Run: `npm test`

Expected: month 新接口断言失败；旧 `/api/rollover` 月顺延测试仍通过。

- [x] **Step 3: 实现月事务分支**

对每个 `selectPastRoots(...,'month',to)` 结果：

- 无日期移动节点：`month=to`，`rollover_origin_month=COALESCE(rollover_origin_month, origin)`。
- 有日期簇：统一使用 `g.deltaDays` 平移 `start_date/end_date`，保持各节点时长与相对距离；月份设为 `to`。
- 簇根总是写首次来源；完成节点不在 `g.nodes` 中，不执行更新。
- 事务 audit 动作为 `rollover-past-month`，写 `{to,count,roots,origins}`。

路由末尾统一响应：

```js
res.json({ok:true,count,roots,merged});
```

- [x] **Step 4: 运行完整 API 测试并提交**

Run: `npm test`

Expected: 日/周/月全部新测试与原测试通过，审计条数断言仍通过。

```powershell
git add rollover.js server.js test.mjs
git commit -m "支持全部过往任务簇顺延到本月"
```

---

### Task 6: 三页面按钮与首次来源徽章

**Files:**
- Modify: `public/index.html:70-120`（来源徽章/按钮状态 CSS）
- Modify: `public/index.html:350-405`（三页面静态按钮）
- Modify: `public/index.html:415-530`（日期与来源助手）
- Modify: `public/index.html:679-970`（月度池/大纲/完成区）
- Modify: `public/index.html:1021-1140`（月/周甘特）
- Modify: `public/index.html:1224-1325`（周列表/每日待办）
- Modify: `public/index.html:1715-1760`（按钮绑定）

**Interfaces:**
- Consumes: task 字段 `rollover_origin_week/month`、execution 字段 `rollover_origin_date`、`POST /api/rollover/past`。
- Produces: `originOf(t,scope)`、`originBadge(item,scope)`、`runPastRollover(button,scope,to)` 与三个新按钮 ID。

- [x] **Step 1: 建立浏览器 RED 验收**

在隔离 worktree 用临时数据库和 `PORT=8898` 启动服务，种入一个旧月日期任务、一个旧周任务、一个旧日执行。用 Playwright CLI 打开页面并断言当前不存在：

```js
await page.locator('#rollPastMonth').count() === 0
await page.locator('#rollPastWeek').count() === 0
await page.locator('#rollPastDay').count() === 0
await page.locator('.originchip').count() === 0
```

Expected: 四项均为 0，浏览器验收 RED。

- [x] **Step 2: 添加按钮和视觉样式**

静态 HTML：

```html
<button class="rollbtn primary" id="rollPastMonth">过往未完成 → 本月</button>
<button class="rollbtn" id="rollMonth">未完成顺延到下月 ⤳</button>

<button class="rollbtn primary" id="rollPastWeek">过往未完成 → 本周</button>

<button class="rollbtn primary" id="rollPastDay">过往未完成 → 今天</button>
<button class="rollbtn" id="rollDay">未完成顺延明天 ⤳</button>
```

CSS：

```css
.originchip{font-size:10.5px;line-height:18px;padding:0 7px;border-radius:9px;background:#f0f1f3;color:#6b7280;white-space:nowrap;flex:none}
.rollbtn.primary{background:#eef6ff;border-color:#bfd7f3;color:#2f6da8;font-weight:650}
.rollbtn:disabled{opacity:.45;cursor:wait}
```

- [x] **Step 3: 增加来源读取和格式化助手**

```js
function inheritedOrigin(t,key){
  let c=t;
  while(c){if(c[key])return c[key];c=c.parent_id==null?null:MAP.get(c.parent_id);}
  return null;
}
function originBadge(item,scope){
  let raw=null,text='';
  if(scope==='day'){raw=item.rollover_origin_date;if(raw)text=`来自 ${+raw.slice(5,7)}月${+raw.slice(8,10)}日`;}
  if(scope==='week'){raw=inheritedOrigin(item,'rollover_origin_week');if(raw)text=`来自 ${weekLabel(raw)}`;}
  if(scope==='month'){raw=inheritedOrigin(item,'rollover_origin_month');if(raw)text=`来自 ${+raw.slice(5,7)}月`;}
  return raw?`<span class="originchip" title="首次顺延来源：${esc(raw)}">${text}</span>`:'';
}
```

插入点必须包括：

- `renderPlanPool()`、`renderDoneCards()`、`renderOutline()`：`originBadge(t,'month')`。
- `renderGantt()`：按 `mode` 使用 month/week 来源，放在左侧固定标签区，长名称仍截断。
- `renderWeek()` 的未完成和完成行：`originBadge(t,'week')`。
- `renderDay()` 的未完成/完成 execution 行：`originBadge(e,'day')`。

任务池和年度目标不显示来源。

- [x] **Step 4: 绑定三类批量操作**

```js
async function runPastRollover(btn,scope,to,onTarget){
  const names={day:'今天',week:'本周',month:'本月'};
  if(!confirm(`把全部过往未完成项顺延到${names[scope]}？\n已完成历史不会移动。`))return;
  btn.disabled=true;
  try{
    const r=await api('POST','/api/rollover/past',{scope,to});
    onTarget();await reload();
    toast(r.count?`已顺延 ${r.count} 项到${names[scope]} ✓`:'没有需要顺延的过往任务');
  }catch(e){toast('顺延失败:'+e.message);await reload().catch(()=>{});}
  finally{btn.disabled=false;}
}
```

绑定：

```js
$('rollPastDay').addEventListener('click',()=>runPastRollover($('rollPastDay'),'day',today(),()=>{viewDay=today();}));
$('rollPastWeek').addEventListener('click',()=>{const mon=fmtDate(mondayOf(new Date()));return runPastRollover($('rollPastWeek'),'week',mon,()=>{viewWeekMon=mon;});});
$('rollPastMonth').addEventListener('click',()=>{const ym=ymOf(today());return runPastRollover($('rollPastMonth'),'month',ym,()=>{viewMonth=ym;});});
```

- [x] **Step 5: 浏览器 GREEN 验收**

Playwright CLI 依次验证：

1. 三个新按钮存在，两个旧顺延按钮仍存在。
2. 点击每日按钮后旧执行进入今天并显示 `来自 M月D日`；完成项未移动。
3. 点击周按钮后日期整段进入本周，任务列表和周甘特均显示来源周。
4. 点击月按钮后任务进入本月，规划池、甘特、大纲和完成区按数据状态显示来源月。
5. 刷新后来源与日期保持。
6. 连点时按钮禁用；第二次请求返回空结果，不产生重复执行记录。
7. 1280×720 和窄视口下长任务名不遮住来源徽章、完成框或 ×。
8. 控制台除 `/favicon.ico` 404 外无新异常。

- [x] **Step 6: 提交前端**

```powershell
git add public/index.html
git commit -m "增加过往任务顺延按钮与来源标记"
```

---

### Task 7: 文档、正式部署与公开仓库同步

**Files:**
- Modify: `README.md`
- Modify: `docs/agent/FRONTEND_GUIDE.md`
- Modify: `docs/agent/API_REFERENCE.md`
- Modify: `docs/agent/PROJECT_MEMORY.md`
- Modify: `docs/superpowers/plans/2026-08-06-past-rollover-provenance.md`（勾选完成项）

**Interfaces:**
- Consumes: 已通过 API 与浏览器验收的日/周/月顺延行为。
- Produces: Agent 可维护契约、用户说明、8790 新进程和 GitHub `main`。

- [x] **Step 1: 同步文档**

README 和 Agent 文档必须明确：

- 新 `/api/rollover/past` 请求/响应与三个 scope 的目标格式。
- 首次来源字段和父链继承显示语义。
- 周无持久化 week 字段，日期按整周天数平移。
- 月锚点夹月末后整簇同天数差平移。
- 部分完成只移动未完成节点；旧按钮保持。
- 每日关联执行冲突会合并并审计。

- [x] **Step 2: 完整验证**

Run:

```powershell
npm test
node --check server.js
node --check rollover.js
git diff --check
$passwordKey='DASH_'+'PASSWORD'
$pattern='ntn_[A-Za-z0-9]{10,}|'+$passwordKey+'=[^[:space:]]+'
$raw=@(git grep -n -E $pattern HEAD 2>$null)
$grepExit=$LASTEXITCODE
if($grepExit -ne 0 -and $grepExit -ne 1){throw '敏感信息扫描执行失败'}
$placeholderLine='HEAD:.env.example:2:'+($passwordKey+'=change-me')
$placeholderRe='^HEAD:\.env\.example:2:'+[regex]::Escape($passwordKey+'=change-me')+'$'
function Get-TrueHits([string[]]$rows){
  @($rows | Where-Object { $_ -notmatch $placeholderRe })
}
$hits=@(Get-TrueHits -rows $raw)
if($hits.Count){
  $files=@($hits | ForEach-Object { if($_ -match '^HEAD:([^:]+):'){ $Matches[1] } } | Sort-Object -Unique)
  throw "敏感信息命中: $($files -join ', ')"
}
$probe='HEAD:docs/review-probe.txt:9:'+($passwordKey+'=synthetic-review-value')
$probeHits=@(Get-TrueHits -rows @($placeholderLine,$probe))
if($probeHits.Count -ne 1 -or $probeHits[0] -ne $probe){throw '敏感信息过滤变异验证失败'}
```

Expected: 全部测试 0 失败；三个语法/差异检查退出 0；敏感信息扫描仅用带路径、行号、完整内容和行尾锚定的正则过滤 `.env.example` `change-me` 占位行，原始命中仅为该占位行、过滤后为 0 真命中；合成的其他路径匹配行必须保留。检查 `git status --short` 时只允许看到主目录原有的 `package-lock.json` 差异，不得出现测试数据库、快照或 `.env`。

- [ ] **Step 3: 合并并重启正式 8790**

执行时使用 `superpowers:finishing-a-development-branch`。用户已要求功能进入现有 8790，但仍需按该技能确认本地合并选择。合并后在主目录再运行 `npm test`。

只停止经以下只读检查确认的正式进程：

```powershell
$listener=Get-NetTCPConnection -LocalPort 8790 -State Listen | Select-Object -First 1
$serverPid=$listener.OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid"
```

确认命令行为 `node server.js` 后停止精确 PID，再从 `D:\1AI\人生规划\tiangang` 使用隐藏窗口启动：

```powershell
Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'server.js' -WorkingDirectory 'D:\1AI\人生规划\tiangang' -WindowStyle Hidden -PassThru
```

验证：

- `GET http://127.0.0.1:8790/` 返回 200。
- 带本地口令的 `GET /api/data` 返回新来源字段。
- 在正式页面三页看到新按钮；不在真实数据上执行批量顺延，除非用户另行明确授权。
- 自动备份目录产生启动备份，真实 `data/tiangang.db` 未被测试脚本替换。

- [ ] **Step 4: 提交计划状态并推送 GitHub**

```powershell
git add README.md docs/agent docs/superpowers/plans/2026-08-06-past-rollover-provenance.md
git commit -m "记录过往任务顺延功能与部署"
git push origin main
```

Expected: `git rev-parse HEAD` 与 `git rev-parse origin/main` 相同；公开仓库仍为 `https://github.com/icarus0926/tiangang-planner`；提交历史无 Agent/Claude co-author trailer。
