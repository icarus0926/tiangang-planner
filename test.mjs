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
tdb.exec('DELETE FROM executions'); // 隔离此前已完成验证的每日 execution 夹具
const dayDates = tdb.prepare(`SELECT
  date('now','-7 day') old_free,
  date('now','-6 day') old_linked,
  date('now','-5 day') completed_old,
  date('now','-4 day') provenance,
  date('now','-30 day') provenance_origin,
  date('now','-3 day') completed_target_old,
  date('now','-2 day') tx_first,
  date('now','-1 day') tx_second,
  date('now') target,
  date('now','+1 day') future`).get();
const dayTask = (await api('POST', '/api/task', { name: '每日关联任务' })).body.task;
const oldFree = (await api('POST', '/api/execution', { text: '旧自由待办', date: dayDates.old_free })).body.execution;
const oldLinked = (await api('POST', '/api/execution', { task_id: dayTask.id, date: dayDates.old_linked })).body.execution;
const todayLinked = (await api('POST', '/api/execution', { task_id: dayTask.id, date: dayDates.target })).body.execution;
const completedOld = (await api('POST', '/api/execution', { text: '旧已完成', date: dayDates.completed_old })).body.execution;
const futureFree = (await api('POST', '/api/execution', { text: '未来自由待办', date: dayDates.future })).body.execution;
await api('PATCH', `/api/execution/${completedOld.id}`, { done: true });
const pastDay = await api('POST', '/api/rollover/past', { scope: 'day', to: dayDates.target });
ok(pastDay.status === 200 && pastDay.body.count === 2 && pastDay.body.merged === 1 &&
  Array.isArray(pastDay.body.roots) && pastDay.body.roots.length === 0,
  '全部过往每日待办拉到今天并合并冲突');
data = (await api('GET', '/api/data')).body;
const movedFree = data.executions.find(x => x.id === oldFree.id);
const keptToday = data.executions.find(x => x.id === todayLinked.id);
ok(movedFree?.date === dayDates.target && movedFree.rollover_origin_date === dayDates.old_free, '自由待办保留首次来源日并由 API 暴露');
ok(keptToday?.rollover_origin_date === dayDates.old_linked && !data.executions.some(x => x.id === oldLinked.id), '关联待办冲突合并结果由 API 暴露');
ok(data.executions.find(x => x.id === completedOld.id)?.date === dayDates.completed_old, '已完成历史不顺延');
ok(data.executions.find(x => x.id === futureFree.id)?.date === dayDates.future, '未来每日待办不顺延');
const mergeAudit = tdb.prepare(`SELECT after_json FROM audit WHERE entity='execution' AND after_json IS NOT NULL ORDER BY id DESC`).all()
  .map(x => { try { return JSON.parse(x.after_json); } catch { return null; } })
  .find(x => x?.removed_id === oldLinked.id && x?.kept_id === todayLinked.id);
ok(!!mergeAudit, '关联待办合并审计记录 removed_id/kept_id');
const pastDayAgain = await api('POST', '/api/rollover/past', { scope: 'day', to: dayDates.target });
ok(pastDayAgain.status === 200 && pastDayAgain.body.count === 0 && pastDayAgain.body.merged === 0, '重复顺延同一目标日幂等');

const provenance = (await api('POST', '/api/execution', { text: '已有来源待办', date: dayDates.provenance })).body.execution;
tdb.prepare('UPDATE executions SET rollover_origin_date=? WHERE id=?').run(dayDates.provenance_origin, provenance.id);
const provenanceRoll = await api('POST', '/api/rollover/past', { scope: 'day', to: dayDates.target });
data = (await api('GET', '/api/data')).body;
ok(provenanceRoll.status === 200 && provenanceRoll.body.count === 1 &&
  data.executions.find(x => x.id === provenance.id)?.rollover_origin_date === dayDates.provenance_origin,
  '再次顺延不覆盖首次来源日且由 API 暴露');

const completedTargetTask = (await api('POST', '/api/task', { name: '目标日已完成任务' })).body.task;
const completedTargetOld = (await api('POST', '/api/execution', { task_id: completedTargetTask.id, date: dayDates.completed_target_old })).body.execution;
const completedTarget = (await api('POST', '/api/execution', { task_id: completedTargetTask.id, date: dayDates.target })).body.execution;
tdb.prepare('UPDATE executions SET done=1,text=? WHERE id=?').run('目标日保留文本', completedTarget.id);
const completedTargetRoll = await api('POST', '/api/rollover/past', { scope: 'day', to: dayDates.target });
const keptCompletedTarget = tdb.prepare('SELECT * FROM executions WHERE id=?').get(completedTarget.id);
ok(completedTargetRoll.status === 200 && completedTargetRoll.body.count === 1 && completedTargetRoll.body.merged === 1 &&
  keptCompletedTarget?.done === 1 && keptCompletedTarget.text === '目标日保留文本' &&
  keptCompletedTarget.rollover_origin_date === dayDates.completed_target_old && !tdb.prepare('SELECT id FROM executions WHERE id=?').get(completedTargetOld.id),
  '合并保留目标日记录的完成与文本语义');
ok((await api('POST', '/api/rollover/past', { scope: 'day', to: '2026-02-30' })).status === 400, '过往每日顺延拒绝非法目标日期');

const txFirst = (await api('POST', '/api/execution', { text: '事务记录一', date: dayDates.tx_first })).body.execution;
const txSecond = (await api('POST', '/api/execution', { text: '事务记录二', date: dayDates.tx_second })).body.execution;
tdb.exec(`CREATE TRIGGER fail_past_day_rollover BEFORE UPDATE OF date ON executions
  WHEN OLD.id=${txSecond.id} BEGIN SELECT RAISE(ABORT,'test rollback'); END`);
const failedTx = await api('POST', '/api/rollover/past', { scope: 'day', to: dayDates.target });
const rolledBack = tdb.prepare('SELECT id,date FROM executions WHERE id IN (?,?) ORDER BY id').all(txFirst.id, txSecond.id);
ok(failedTx.status === 500 && rolledBack[0]?.date === dayDates.tx_first && rolledBack[1]?.date === dayDates.tx_second, '每日顺延任一失败时整批事务回滚');
tdb.exec('DROP TRIGGER fail_past_day_rollover');

// ── 全量过往周任务簇顺延
tdb.exec('DELETE FROM executions; DELETE FROM tasks');
const wRoot = (await api('POST', '/api/task', { name: '过往周簇' })).body.task;
const wOpen = (await api('POST', '/api/task', {
  name: '周未完成', parent_id: wRoot.id, month: '2026-07', start: '2026-07-22', end: '2026-07-24'
})).body.task;
const wLater = (await api('POST', '/api/task', {
  name: '周后续未完成', parent_id: wRoot.id, month: '2026-07', start: '2026-07-29', end: '2026-07-31'
})).body.task;
const wDone = (await api('POST', '/api/task', {
  name: '周已完成', parent_id: wRoot.id, month: '2026-07', start: '2026-07-20', end: '2026-07-21'
})).body.task;
await api('POST', `/api/task/${wDone.id}/toggle-done`);
const wDoneBefore = tdb.prepare('SELECT * FROM tasks WHERE id=?').get(wDone.id);
const wCurrent = (await api('POST', '/api/task', { name: '已在本周', start: '2026-08-05', end: '2026-08-08' })).body.task;
const wFuture = (await api('POST', '/api/task', { name: '未来周任务', start: '2026-08-18', end: '2026-08-19' })).body.task;
const wPool = (await api('POST', '/api/task', { name: '无日期普通池' })).body.task;
const wArchived = (await api('POST', '/api/task', { name: '已归档过期任务', start: '2026-07-23', end: '2026-07-24' })).body.task;
await api('DELETE', `/api/task/${wArchived.id}`);

ok((await api('POST', '/api/rollover/past', { scope: 'week', to: '2026-08-04' })).status === 400,
  '过往周顺延拒绝非周一目标');
const weekAuditStart = tdb.prepare('SELECT COALESCE(MAX(id),0) id FROM audit').get().id;
const pastWeek = await api('POST', '/api/rollover/past', { scope: 'week', to: '2026-08-03' });
data = (await api('GET', '/api/data')).body;
ok(pastWeek.status === 200 && pastWeek.body.count === 2 &&
  JSON.stringify(pastWeek.body.roots) === JSON.stringify([wRoot.id]),
  '过往周簇按最高无日期父节点处理并返回移动数/簇根');
ok(find(wOpen.id).start_date === '2026-08-05' && find(wOpen.id).end_date === '2026-08-07' &&
  find(wLater.id).start_date === '2026-08-12' && find(wLater.id).end_date === '2026-08-14',
  '周簇统一平移 14 天并保持星期、时长和树内相对排期');
ok(find(wRoot.id).rollover_origin_week === '2026-07-20' &&
  find(wOpen.id).rollover_origin_week === '2026-07-20' &&
  find(wLater.id).rollover_origin_week === '2026-07-20',
  '簇根和全部移动节点记录首次来源周');
ok(find(wOpen.id).month === '2026-08' && find(wLater.id).month === '2026-08' &&
  find(wOpen.id).rollover_origin_month === '2026-07' && find(wLater.id).rollover_origin_month === '2026-07',
  '跨月周顺延更新目标月份并保留首次来源月');
ok(find(wDone.id).start_date === wDoneBefore.start_date && find(wDone.id).end_date === wDoneBefore.end_date &&
  find(wDone.id).done_at === wDoneBefore.done_at,
  '部分完成父簇只顺延开放分支且已完成历史/done_at 不变');
ok(find(wCurrent.id).start_date === '2026-08-05' && find(wFuture.id).start_date === '2026-08-18' &&
  find(wPool.id).start_date == null && find(wPool.id).rollover_origin_week == null,
  '本周相交、未来和无日期普通池节点不移动');
const archivedData = (await api('GET', '/api/data?archived=1')).body;
const archivedAfter = archivedData.tasks.find(t => t.id === wArchived.id);
ok(archivedAfter?.start_date === '2026-07-23' && archivedAfter.rollover_origin_week == null,
  'archived 过期节点不移动');

const weekAudits = tdb.prepare('SELECT entity_id,before_json,after_json FROM audit WHERE id>? ORDER BY id').all(weekAuditStart)
  .map(row => ({
    entity_id: row.entity_id,
    before: row.before_json ? JSON.parse(row.before_json) : null,
    after: row.after_json ? JSON.parse(row.after_json) : null
  }));
const auditedTaskChange = id => weekAudits.some(row => row.entity_id === id && row.before && row.after &&
  (row.before.start_date !== row.after.start_date || row.before.rollover_origin_week !== row.after.rollover_origin_week));
ok([wRoot.id, wOpen.id, wLater.id].every(auditedTaskChange), '周顺延逐项审计簇根来源与每个实际移动');
ok(weekAudits.some(row => row.entity_id == null && row.after?.to === '2026-08-03' &&
  row.after.count === 2 && JSON.stringify(row.after.roots) === JSON.stringify([wRoot.id]) &&
  JSON.stringify(row.after.origins) === JSON.stringify(['2026-07-20'])),
  '周顺延批次审计记录 to/count/roots/origins');
const pastWeekAgain = await api('POST', '/api/rollover/past', { scope: 'week', to: '2026-08-03' });
ok(pastWeekAgain.status === 200 && pastWeekAgain.body.count === 0 && pastWeekAgain.body.roots.length === 0,
  '重复顺延同一目标周幂等');

const weekEdgeRoot = (await api('POST', '/api/task', { name: '周单边日期簇' })).body.task;
const endOnly = (await api('POST', '/api/task', {
  name: '仅结束日期', parent_id: weekEdgeRoot.id, end: '2026-07-24'
})).body.task;
const startOnly = (await api('POST', '/api/task', {
  name: '仅开始日期', parent_id: weekEdgeRoot.id, start: '2026-07-22'
})).body.task;
const startOnlyBefore = tdb.prepare('SELECT * FROM tasks WHERE id=?').get(startOnly.id);
const sentinelExecution = (await api('POST', '/api/execution', {
  text: '周接口隔离 sentinel', date: '2026-07-18'
})).body.execution;
tdb.prepare('UPDATE executions SET done=1,notion_id=?,rollover_origin_date=? WHERE id=?')
  .run('sentinel-notion', '2026-06-30', sentinelExecution.id);
const executionFields = 'id,task_id,text,date,done,notion_id,rollover_origin_date';
const sentinelBefore = tdb.prepare(`SELECT ${executionFields} FROM executions WHERE id=?`).get(sentinelExecution.id);
const edgeWeek = await api('POST', '/api/rollover/past', { scope: 'week', to: '2026-08-03' });
const endOnlyAfter = tdb.prepare('SELECT * FROM tasks WHERE id=?').get(endOnly.id);
const startOnlyAfter = tdb.prepare('SELECT * FROM tasks WHERE id=?').get(startOnly.id);
const sentinelAfter = tdb.prepare(`SELECT ${executionFields} FROM executions WHERE id=?`).get(sentinelExecution.id);
ok(edgeWeek.status === 200 && edgeWeek.body.count === 1 &&
  JSON.stringify(edgeWeek.body.roots) === JSON.stringify([weekEdgeRoot.id]) &&
  endOnlyAfter.start_date == null && endOnlyAfter.end_date === '2026-08-07',
  '仅 end_date 的过往任务被选中且只平移结束日期');
ok(JSON.stringify(startOnlyAfter) === JSON.stringify(startOnlyBefore),
  '仅 start_date 的任务不满足有效结束日期规则且全部字段不变');
ok(JSON.stringify(sentinelAfter) === JSON.stringify(sentinelBefore),
  '周顺延不修改 sentinel execution 的完整关键字段');

tdb.exec('DELETE FROM tasks');
const provenanceRoot = (await api('POST', '/api/task', { name: '多次顺延簇' })).body.task;
const provenanceTask = (await api('POST', '/api/task', {
  name: '多次顺延节点', parent_id: provenanceRoot.id, month: '2026-07', start: '2026-07-15', end: '2026-07-16'
})).body.task;
const provenanceWeekFirst = await api('POST', '/api/rollover/past', { scope: 'week', to: '2026-08-03' });
const provenanceWeekSecond = await api('POST', '/api/rollover/past', { scope: 'week', to: '2026-08-10' });
data = (await api('GET', '/api/data')).body;
ok(provenanceWeekFirst.body.count === 1 && provenanceWeekSecond.body.count === 1 &&
  find(provenanceTask.id).start_date === '2026-08-12' && find(provenanceTask.id).end_date === '2026-08-13' &&
  find(provenanceRoot.id).rollover_origin_week === '2026-07-13' &&
  find(provenanceTask.id).rollover_origin_week === '2026-07-13' &&
  find(provenanceTask.id).rollover_origin_month === '2026-07',
  '多次周顺延继续平移排期且不覆盖首次来源周/月');

tdb.exec('DELETE FROM tasks');
const weekTxRoot = (await api('POST', '/api/task', { name: '周事务簇' })).body.task;
const weekTxFirst = (await api('POST', '/api/task', {
  name: '周事务节点一', parent_id: weekTxRoot.id, start: '2026-07-22', end: '2026-07-24'
})).body.task;
const weekTxSecond = (await api('POST', '/api/task', {
  name: '周事务节点二', parent_id: weekTxRoot.id, start: '2026-07-29', end: '2026-07-31'
})).body.task;
tdb.exec(`CREATE TRIGGER fail_past_week_rollover BEFORE UPDATE OF start_date ON tasks
  WHEN OLD.id=${weekTxSecond.id} BEGIN SELECT RAISE(ABORT,'test week rollback'); END`);
const weekTxAuditBefore = tdb.prepare('SELECT COUNT(*) count,COALESCE(MAX(id),0) max_id FROM audit').get();
const failedWeekTx = await api('POST', '/api/rollover/past', { scope: 'week', to: '2026-08-03' });
const weekRolledBack = tdb.prepare('SELECT * FROM tasks WHERE id IN (?,?,?) ORDER BY id')
  .all(weekTxRoot.id, weekTxFirst.id, weekTxSecond.id);
const weekTxAuditAfter = tdb.prepare('SELECT COUNT(*) count,COALESCE(MAX(id),0) max_id FROM audit').get();
ok(failedWeekTx.status === 500 && weekRolledBack[0]?.rollover_origin_week == null &&
  weekRolledBack[1]?.start_date === '2026-07-22' && weekRolledBack[1]?.rollover_origin_week == null &&
  weekRolledBack[2]?.start_date === '2026-07-29' && weekRolledBack[2]?.rollover_origin_week == null,
  '周顺延任一节点失败时整批任务/来源审计事务回滚');
ok(weekTxAuditAfter.count === weekTxAuditBefore.count && weekTxAuditAfter.max_id === weekTxAuditBefore.max_id,
  '周顺延失败时逐项和批次 audit 均不留新增记录');
tdb.exec('DROP TRIGGER fail_past_week_rollover');

// ── 审计
const auditCount = tdb.prepare('SELECT COUNT(*) c FROM audit').get().c;
ok(auditCount > 20, `审计日志已记录(${auditCount}条)`);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
srv.close();
for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + suf); } catch {} }
process.exit(fail ? 1 : 0);
