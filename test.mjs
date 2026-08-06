// 集成测试:临时库 + 真服务,全 API 覆盖。node test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const HERE = path.dirname(fileURLToPath(import.meta.url));

process.env.DB_PATH = path.join(HERE, 'data', `test-${Date.now()}.db`);
process.env.DASH_PASSWORD = 'testpw';
process.env.PORT = '8899';

const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
let reorderTags;
try { ({ reorderTags } = require('./public/tag-order.js')); } catch (_) { }
const { app } = require('./server.js');
const srv = app.listen(8899);

const H = { 'Content-Type': 'application/json', 'x-dash-key': 'testpw' };
const api = async (method, p, body) => {
  const r = await fetch('http://localhost:8899' + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

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
const legacyMigrationPassed = taskCols.includes('rollover_origin_week') &&
  taskCols.includes('rollover_origin_month') && execCols.includes('rollover_origin_date');
const migratedAgain = openDb(legacyPath);
migratedAgain.close();
migrated.close();
for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(legacyPath + suf); } catch {} }

let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗', m));

// ── 过往任务顺延：日期平移与任务簇选择纯函数
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
const futureChild = [
  {id:5,parent_id:null,status:'planned',month:'2026-07',start_date:null,end_date:null},
  {id:6,parent_id:5,status:'planned',month:'2026-09',start_date:'2026-09-01',end_date:'2026-09-02'}
];
const futurePicked = rollHelp.selectPastRoots?.(futureChild,'month','2026-08') || [];
ok(futurePicked[0]?.nodes.map(x=>x.id).join(',') === '5', '过期父节点不带动未来子节点');
const barePoolChild = [
  {id:7,parent_id:null,status:'planned',month:'2026-07',start_date:null,end_date:null},
  {id:8,parent_id:7,status:'pool',month:null,start_date:null,end_date:null}
];
const barePoolPicked = rollHelp.selectPastRoots?.(barePoolChild,'month','2026-08') || [];
ok(barePoolPicked[0]?.nodes.map(x=>x.id).join(',') === '7', '过期父节点不带动无日期普通池子节点');
const crossingParent = [
  {id:9,parent_id:null,status:'planned',month:'2026-07',start_date:'2026-07-31',end_date:'2026-08-02'},
  {id:10,parent_id:9,status:'planned',month:null,start_date:'2026-07-20',end_date:'2026-07-21'}
];
const crossingPicked = rollHelp.selectPastRoots?.(crossingParent,'month','2026-08') || [];
ok(crossingPicked.length === 1 && crossingPicked[0].root.id === 10 &&
  crossingPicked[0].nodes.map(x=>x.id).join(',') === '10', '跨入目标月的父节点不移动，过期子分支独立选择');

// ── 任务池分类整块排序(纯函数,浏览器与测试共用)
ok(legacyMigrationPassed, 'legacy db migration adds rollover provenance columns');
ok(typeof reorderTags === 'function' &&
  JSON.stringify(reorderTags(['工作', '学习', '投资', '副业', '其他'], '投资', '工作', true)) ===
  JSON.stringify(['投资', '工作', '学习', '副业', '其他']), '分类排序:整块移到目标前');
ok(typeof reorderTags === 'function' &&
  JSON.stringify(reorderTags(['工作', '学习', '投资', '副业', '其他'], '工作', '其他', false)) ===
  JSON.stringify(['学习', '投资', '副业', '工作', '其他']), '分类排序:拖到其他后仍停在其他前');
ok(typeof reorderTags === 'function' &&
  JSON.stringify(reorderTags(['工作', '学习', '其他'], '其他', '工作', true)) ===
  JSON.stringify(['工作', '学习', '其他']), '分类排序:其他固定最后');

// ── 认证
ok((await fetch('http://localhost:8899/api/data')).status === 401, '无口令 401');

// ── 建树: A ── B(子) ── C(孙) ;  A ── D(子)
const A = (await api('POST', '/api/task', { name: '任务A', month: '2026-07', priority: 'P0' })).body.task;
const B = (await api('POST', '/api/task', { name: '子B', parent_id: A.id })).body.task;
const C = (await api('POST', '/api/task', { name: '孙C', parent_id: B.id })).body.task;
const D = (await api('POST', '/api/task', { name: '子D', parent_id: A.id, start: '2026-07-16', end: '2026-07-17' })).body.task;
ok(A.status === 'planned' && A.month === '2026-07', 'A 直填月份生根 → planned');
ok(B.parent_id === A.id && B.kind === A.kind, 'B 挂 A,kind 继承');
ok(D.start_date === '2026-07-16', 'D 带日期生根');

// ── 进度与叶子
let data = (await api('GET', '/api/data')).body;
const find = (id) => data.tasks.find(t => t.id === id);
ok(find(A.id).leaves === 2 && find(A.id).done_leaves === 0, 'A 子树叶子=2(C,D)');

// ── 完成冒泡:勾 C → B 自动 done;勾 D → A 自动 done
await api('POST', `/api/task/${C.id}/toggle-done`);
data = (await api('GET', '/api/data')).body;
ok(find(B.id).status === 'done' && find(B.id).done_at, 'C 完成 → B 自动完成');
ok(find(A.id).status !== 'done', 'D 未完成 → A 不动');
await api('POST', `/api/task/${D.id}/toggle-done`);
data = (await api('GET', '/api/data')).body;
ok(find(A.id).status === 'done', '全部叶子完成 → A 冒泡完成');

// ── 父任务直接勾选 → 整棵子树级联完成/重开(此刻 A 全 done)
await api('POST', `/api/task/${A.id}/toggle-done`);      // 勾已完成的 A → 应重开整棵
data = (await api('GET', '/api/data')).body;
ok(find(A.id).status !== 'done' && find(B.id).status !== 'done' && find(C.id).status !== 'done' && find(D.id).status !== 'done', '勾父 A(已完成)→ 整棵子树级联重开');
await api('POST', `/api/task/${A.id}/toggle-done`);      // 再勾 A → 整棵级联完成
data = (await api('GET', '/api/data')).body;
ok(find(A.id).status === 'done' && find(B.id).status === 'done' && find(C.id).status === 'done' && find(D.id).status === 'done', '勾父 A → 整棵子树级联完成');

// ── 可逆:打开叶子 C → B、A 自动重开(其余仍 done)
await api('POST', `/api/task/${C.id}/toggle-done`);
data = (await api('GET', '/api/data')).body;
ok(find(B.id).status === 'planned' && find(A.id).status === 'planned', '重开叶子 C → B/A 连锁重开');
ok(find(D.id).status === 'done', '兄弟 D 不受影响仍完成');

// ── 给完成的父添新子 → 自动重开(先重新完成 A)
await api('POST', `/api/task/${C.id}/toggle-done`);
data = (await api('GET', '/api/data')).body;
ok(find(A.id).status === 'done', '重新完成 A');
const E = (await api('POST', '/api/task', { name: '子E', parent_id: A.id })).body.task;
data = (await api('GET', '/api/data')).body;
ok(find(A.id).status === 'planned', '完成的 A 添新子 → 自动重开');

// ── 挂靠(re-parent):E 挂到 B 下;循环防护
ok((await api('PATCH', `/api/task/${A.id}`, { parent_id: C.id })).status === 400, '循环挂靠被拒(A→C)');
await api('PATCH', `/api/task/${E.id}`, { parent_id: B.id });
data = (await api('GET', '/api/data')).body;
ok(find(E.id).parent_id === B.id, 'E 挂到 B 下');
ok(find(B.id).status === 'planned', 'B 因新子未完成而保持未完成');
// E 完成 → B 完成(C 已完成) → A 完成(D 已完成)
await api('POST', `/api/task/${E.id}/toggle-done`);
data = (await api('GET', '/api/data')).body;
ok(find(B.id).status === 'done' && find(A.id).status === 'done', '挂靠后冒泡链正确(E done→B done→A done)');
// 独立出去:E 清父 → B 仍 done(C 独存且 done)
await api('PATCH', `/api/task/${E.id}`, { parent_id: null });
data = (await api('GET', '/api/data')).body;
ok(find(E.id).parent_id === null, 'E 独立为顶层');

// ── PATCH 禁止直接 status=done
ok((await api('PATCH', `/api/task/${E.id}`, { status: 'done' })).status === 400, 'PATCH 拒绝 status=done');

// ── 顺延(月):显式月份 + 仅靠日期进入本月的部分完成任务都要顺延;已完成 A 不动
const F = (await api('POST', '/api/task', { name: 'F', month: '2026-07' })).body.task;
const G = (await api('POST', '/api/task', { name: 'G', month: '2026-07' })).body.task;
const dateParent = (await api('POST', '/api/task', { name: '日期型父任务', start: '2026-07-21', end: '2026-07-23' })).body.task;
const dateDoneChild = (await api('POST', '/api/task', { name: '已完成小任务', parent_id: dateParent.id })).body.task;
await api('POST', `/api/task/${dateDoneChild.id}/toggle-done`);
await api('POST', '/api/task', { name: '未完成小任务', parent_id: dateParent.id });
const roll = (await api('POST', '/api/rollover', { scope: 'month', from: '2026-07', to: '2026-08' })).body;
data = (await api('GET', '/api/data')).body;
ok(find(F.id).month === '2026-08' && find(G.id).month === '2026-08' && find(A.id).month === '2026-07', '月顺延移动显式归属本月的未完成任务,完成的 A 留在7月');
ok(roll.count === 3 && find(dateParent.id).month === '2026-08' && find(dateParent.id).status === 'planned', '月顺延包含仅靠日期进入本月且部分完成的任务簇');

// ── 每日执行
const ex1 = (await api('POST', '/api/execution', { text: '自由待办', date: '2026-07-15' })).body.execution;
ok(ex1.text === '自由待办' && !ex1.task_id, '自由文本待办');
const ex2 = (await api('POST', '/api/execution', { task_id: F.id, date: '2026-07-15' })).body.execution;
data = (await api('GET', '/api/data')).body;
const dataExecution = data.executions.find(execution => execution.id === ex2.id);
ok(Object.hasOwn(find(F.id), 'rollover_origin_week') &&
  dataExecution && Object.hasOwn(dataExecution, 'rollover_origin_date'),
  'GET /api/data returns rollover provenance fields');
ok(ex2.task_name === 'F', '任务关联待办带任务名');
ok((await api('POST', '/api/execution', { task_id: F.id, date: '2026-07-15' })).status === 409, '同任务同日查重 409');
// 勾关联叶子 → 任务完成联动
await api('PATCH', `/api/execution/${ex2.id}`, { done: true });
data = (await api('GET', '/api/data')).body;
ok(find(F.id).status === 'done', '勾执行记录 → 叶子任务完成');
// 非叶子打卡不完成任务
const exA = (await api('POST', '/api/execution', { task_id: A.id, date: '2026-07-15' })).body.execution;
await api('PATCH', `/api/execution/${exA.id}`, { done: true });
data = (await api('GET', '/api/data')).body;
ok(find(A.id).status === 'done', '非叶子打卡不改任务状态(A 本来就 done,无副作用)');
// 升格
const pr = (await api('POST', `/api/execution/${ex1.id}/promote`)).body;
ok(pr.task && pr.task.status === 'pool' && pr.task.name === '自由待办', '升格:自由待办 → pool 任务');
// 日顺延
const ex3 = (await api('POST', '/api/execution', { text: '明天再说', date: '2026-07-15' })).body.execution;
const rd = (await api('POST', '/api/rollover', { scope: 'day', from: '2026-07-15', to: '2026-07-16' })).body;
ok(rd.count >= 1, '日顺延未完成待办');

// ── 归档/恢复/硬删
await api('DELETE', `/api/task/${A.id}`);
data = (await api('GET', '/api/data')).body;
ok(!find(A.id) && !find(B.id) && !find(C.id), '归档 A → 整棵子树从默认视图消失');
data = (await api('GET', '/api/data?archived=1')).body;
ok(find(A.id).status === 'archived' && find(C.id).status === 'archived', '带 archived=1 可见,子树全归档');
await api('POST', `/api/task/${A.id}/restore`);
data = (await api('GET', '/api/data')).body;
ok(find(A.id) && find(C.id), '恢复 A → 子树回来');
await api('DELETE', `/api/task/${E.id}`);
ok((await api('DELETE', `/api/task/${E.id}?hard=1`)).body.hard === true, '归档后可硬删');
data = (await api('GET', '/api/data?archived=1')).body;
ok(!find(E.id), '硬删后彻底消失');

// ── 年度目标
const g = (await api('POST', '/api/goal', { name: '测试目标', domain: '副业' })).body.goal;
await api('PATCH', `/api/goal/${g.id}`, { progress: 40 });
data = (await api('GET', '/api/data')).body;
ok(data.goals.find(x => x.id === g.id).progress === 40, '目标增改');

// ── 目标区任务:仅挂目标生根 → status='goal'(不进池);PATCH 放行入池
const gt = (await api('POST', '/api/task', { name: '目标区任务', goal_id: g.id })).body.task;
ok(gt.status === 'goal', '仅挂目标生根 → goal 状态(不进任务池)');
await api('PATCH', `/api/task/${gt.id}`, { status: 'pool' });
data = (await api('GET', '/api/data')).body;
ok(find(gt.id).status === 'pool', 'PATCH status:pool → 放行入任务池');

// ── 标签持久化
const tg = (await api('POST', '/api/tags', { tags: ['工作', '学习', '自定义X'] })).body;
ok(tg.ok && tg.tags.length === 3, '保存标签列表(去重校验)');
data = (await api('GET', '/api/data')).body;
ok(Array.isArray(data.tags) && data.tags.includes('自定义X'), 'GET /api/data 返回自定义标签');
ok((await api('POST', '/api/tags', { tags: 'bad' })).status === 400, '标签校验:非数组 400');

// ── 全量过往每日待办顺延
const { createRequire: cr } = await import('node:module');
const { open } = cr(import.meta.url)('./db.js');
const tdb = open(process.env.DB_PATH);
const dayTask = (await api('POST', '/api/task', { name: '每日关联任务' })).body.task;
const oldFree = (await api('POST', '/api/execution', { text: '旧自由待办', date: '2026-07-01' })).body.execution;
const oldLinked = (await api('POST', '/api/execution', { task_id: dayTask.id, date: '2026-07-02' })).body.execution;
const todayLinked = (await api('POST', '/api/execution', { task_id: dayTask.id, date: '2026-07-10' })).body.execution;
const completedOld = (await api('POST', '/api/execution', { text: '旧已完成', date: '2026-07-03' })).body.execution;
await api('PATCH', `/api/execution/${completedOld.id}`, { done: true });
const pastDay = await api('POST', '/api/rollover/past', { scope: 'day', to: '2026-07-10' });
ok(pastDay.status === 200 && pastDay.body.count === 2 && pastDay.body.merged === 1 &&
  Array.isArray(pastDay.body.roots) && pastDay.body.roots.length === 0,
  '全部过往每日待办拉到今天并合并冲突');
const executionById = tdb.prepare('SELECT * FROM executions WHERE id=?');
const movedFree = executionById.get(oldFree.id);
const keptToday = executionById.get(todayLinked.id);
ok(movedFree?.date === '2026-07-10' && movedFree.rollover_origin_date === '2026-07-01', '自由待办保留首次来源日');
ok(keptToday?.rollover_origin_date === '2026-07-02' && !executionById.get(oldLinked.id), '关联待办冲突合并到今天记录');
ok(executionById.get(completedOld.id)?.date === '2026-07-03', '已完成历史不顺延');
const mergeAudit = tdb.prepare(`SELECT after_json FROM audit WHERE entity='execution' AND after_json IS NOT NULL ORDER BY id DESC`).all()
  .map(x => { try { return JSON.parse(x.after_json); } catch { return null; } })
  .find(x => x?.removed_id === oldLinked.id && x?.kept_id === todayLinked.id);
ok(!!mergeAudit, '关联待办合并审计记录 removed_id/kept_id');
const pastDayAgain = await api('POST', '/api/rollover/past', { scope: 'day', to: '2026-07-10' });
ok(pastDayAgain.status === 200 && pastDayAgain.body.count === 0 && pastDayAgain.body.merged === 0, '重复顺延同一目标日幂等');

const provenance = (await api('POST', '/api/execution', { text: '已有来源待办', date: '2026-07-04' })).body.execution;
tdb.prepare('UPDATE executions SET rollover_origin_date=? WHERE id=?').run('2026-06-20', provenance.id);
const provenanceRoll = await api('POST', '/api/rollover/past', { scope: 'day', to: '2026-07-10' });
ok(provenanceRoll.status === 200 && provenanceRoll.body.count === 1 &&
  executionById.get(provenance.id)?.rollover_origin_date === '2026-06-20',
  '再次顺延不覆盖首次来源日');

const completedTargetTask = (await api('POST', '/api/task', { name: '目标日已完成任务' })).body.task;
const completedTargetOld = (await api('POST', '/api/execution', { task_id: completedTargetTask.id, date: '2026-07-07' })).body.execution;
const completedTarget = (await api('POST', '/api/execution', { task_id: completedTargetTask.id, date: '2026-07-10' })).body.execution;
tdb.prepare('UPDATE executions SET done=1,text=? WHERE id=?').run('目标日保留文本', completedTarget.id);
const completedTargetRoll = await api('POST', '/api/rollover/past', { scope: 'day', to: '2026-07-10' });
const keptCompletedTarget = tdb.prepare('SELECT * FROM executions WHERE id=?').get(completedTarget.id);
ok(completedTargetRoll.status === 200 && completedTargetRoll.body.count === 1 && completedTargetRoll.body.merged === 1 &&
  keptCompletedTarget?.done === 1 && keptCompletedTarget.text === '目标日保留文本' &&
  keptCompletedTarget.rollover_origin_date === '2026-07-07' && !tdb.prepare('SELECT id FROM executions WHERE id=?').get(completedTargetOld.id),
  '合并保留目标日记录的完成与文本语义');
ok((await api('POST', '/api/rollover/past', { scope: 'day', to: '2026-02-30' })).status === 400, '过往每日顺延拒绝非法目标日期');

const txFirst = (await api('POST', '/api/execution', { text: '事务记录一', date: '2026-07-05' })).body.execution;
const txSecond = (await api('POST', '/api/execution', { text: '事务记录二', date: '2026-07-06' })).body.execution;
tdb.exec(`CREATE TRIGGER fail_past_day_rollover BEFORE UPDATE OF date ON executions
  WHEN OLD.id=${txSecond.id} BEGIN SELECT RAISE(ABORT,'test rollback'); END`);
const failedTx = await api('POST', '/api/rollover/past', { scope: 'day', to: '2026-07-10' });
const rolledBack = tdb.prepare('SELECT id,date FROM executions WHERE id IN (?,?) ORDER BY id').all(txFirst.id, txSecond.id);
ok(failedTx.status === 500 && rolledBack[0]?.date === '2026-07-05' && rolledBack[1]?.date === '2026-07-06', '每日顺延任一失败时整批事务回滚');
tdb.exec('DROP TRIGGER fail_past_day_rollover');

// ── 审计
const auditCount = tdb.prepare('SELECT COUNT(*) c FROM audit').get().c;
ok(auditCount > 20, `审计日志已记录(${auditCount}条)`);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
srv.close();
for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + suf); } catch {} }
process.exit(fail ? 1 : 0);
