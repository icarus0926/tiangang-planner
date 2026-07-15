// 集成测试:临时库 + 真服务,全 API 覆盖。node test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));

process.env.DB_PATH = path.join(HERE, 'data', `test-${Date.now()}.db`);
process.env.DASH_PASSWORD = 'testpw';
process.env.PORT = '8899';

const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const { app } = require('./server.js');
const srv = app.listen(8899);

const H = { 'Content-Type': 'application/json', 'x-dash-key': 'testpw' };
const api = async (method, p, body) => {
  const r = await fetch('http://localhost:8899' + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗', m));

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

// ── 顺延(月):建 2 个未完成 + 复用已完成 A(不该动)
const F = (await api('POST', '/api/task', { name: 'F', month: '2026-07' })).body.task;
const G = (await api('POST', '/api/task', { name: 'G', month: '2026-07' })).body.task;
const roll = (await api('POST', '/api/rollover', { scope: 'month', from: '2026-07', to: '2026-08' })).body;
data = (await api('GET', '/api/data')).body;
ok(roll.count === 2 && find(F.id).month === '2026-08' && find(A.id).month === '2026-07', '月顺延只动未完成(2条),完成的 A 留在7月');

// ── 每日执行
const ex1 = (await api('POST', '/api/execution', { text: '自由待办', date: '2026-07-15' })).body.execution;
ok(ex1.text === '自由待办' && !ex1.task_id, '自由文本待办');
const ex2 = (await api('POST', '/api/execution', { task_id: F.id, date: '2026-07-15' })).body.execution;
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

// ── 审计
const { createRequire: cr } = await import('node:module');
const { open } = cr(import.meta.url)('./db.js');
const tdb = open(process.env.DB_PATH);
const auditCount = tdb.prepare('SELECT COUNT(*) c FROM audit').get().c;
ok(auditCount > 20, `审计日志已记录(${auditCount}条)`);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
srv.close();
for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + suf); } catch {} }
process.exit(fail ? 1 : 0);
