// 集成测试:临时库 + 真服务,全 API 覆盖。node test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
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

// ── Task 6 前端静态契约（真实浏览器行为另由 Playwright CLI 验收）
const frontHtml = fs.readFileSync(path.join(HERE, 'public', 'index.html'), 'utf8');
const frontSection = (from, to) => {
  const start = frontHtml.indexOf(from);
  const end = start < 0 ? -1 : frontHtml.indexOf(to, start + from.length);
  return start < 0 ? '' : frontHtml.slice(start, end < 0 ? undefined : end);
};
ok([
  ['rollPastMonth', '过往未完成 → 本月'],
  ['rollPastWeek', '过往未完成 → 本周'],
  ['rollPastDay', '过往未完成 → 今天'],
  ['rollMonth', '未完成顺延到下月 ⤳'],
  ['rollDay', '未完成顺延明天 ⤳']
].every(([id, label]) => new RegExp(`<button[^>]+id="${id}"[^>]*>${label}</button>`).test(frontHtml)),
'前端保留两个旧顺延按钮并提供三个全量顺延按钮');
ok(frontHtml.includes('.originchip{') && frontHtml.includes('.rollbtn.primary{') &&
  frontHtml.includes('.rollbtn:disabled{'), '来源徽章、主按钮与请求中禁用样式存在');

const originHelpers = frontSection('function inheritedOrigin(', '/* ================= API ================= */');
ok(originHelpers.includes("inheritedOrigin(item,'rollover_origin_week')") &&
  originHelpers.includes("inheritedOrigin(item,'rollover_origin_month')") &&
  originHelpers.includes('item.rollover_origin_date') && originHelpers.includes('${esc(title)}') &&
  originHelpers.includes('来自 ${weekLabel(raw)}'), '来源助手支持祖先最初周/月、执行最初日期与安全 title');

const originRuntime = frontSection('const esc=', 'let toastTimer=');
const loadOriginRuntime = ({ tasks, viewMonth = '2026-08', viewWeekMon = '2026-08-03' }) => {
  const context = vm.createContext({
    MAP: new Map(tasks.map(task => [task.id, task])),
    viewMonth,
    viewWeekMon
  });
  vm.runInContext(`${originRuntime};this.originOf=originOf;this.originBadge=originBadge;`, context);
  return context;
};
const originParent = {
  id: 9001, parent_id: null, status: 'planned', month: '2026-08',
  start_date: '2026-08-03', end_date: '2026-08-09',
  rollover_origin_week: '2026-07-20', rollover_origin_month: '2026-07'
};
const alignedMonthChild = {
  id: 9002, parent_id: originParent.id, status: 'planned', month: '2026-08',
  start_date: null, end_date: null, rollover_origin_week: null, rollover_origin_month: null
};
const alignedWeekChild = {
  id: 9003, parent_id: originParent.id, status: 'planned', month: '2026-08',
  start_date: '2026-08-05', end_date: '2026-08-06', rollover_origin_week: null, rollover_origin_month: null
};
const doneSibling = { ...alignedWeekChild, id: 9004, status: 'done' };
const archivedSibling = { ...alignedWeekChild, id: 9005, status: 'archived' };
const futureSibling = {
  ...alignedWeekChild, id: 9006, month: '2026-09', start_date: '2026-09-01', end_date: '2026-09-02'
};
const datelessPoolChild = {
  id: 9007, parent_id: originParent.id, status: 'pool', month: null,
  start_date: null, end_date: null, rollover_origin_week: null, rollover_origin_month: null
};
const ownOriginDone = {
  ...doneSibling, id: 9008, rollover_origin_week: '2026-06-29', rollover_origin_month: '2026-06'
};
const originCtx = loadOriginRuntime({
  tasks: [originParent, alignedMonthChild, alignedWeekChild, doneSibling, archivedSibling,
    futureSibling, datelessPoolChild, ownOriginDone]
});
ok(originCtx.originOf(alignedMonthChild, 'month') === '2026-07' &&
  originCtx.originOf(alignedWeekChild, 'week') === '2026-07-20',
  '来源继承保留当前渲染窗口内的开放子任务');
ok(originCtx.originOf(doneSibling, 'week') == null &&
  originCtx.originOf(archivedSibling, 'week') == null &&
  originCtx.originOf(futureSibling, 'week') == null &&
  originCtx.originOf(futureSibling, 'month') == null &&
  originCtx.originOf(datelessPoolChild, 'month') == null &&
  originCtx.originOf(ownOriginDone, 'week') === '2026-06-29' &&
  originCtx.originOf(ownOriginDone, 'month') === '2026-06',
  '来源继承拒绝完成/归档、窗口外未来和无日期池子节点且自身来源优先');
ok(originCtx.originBadge(alignedWeekChild, 'week').includes(
  'title="首次顺延来源：2026-07-20 至 2026-07-26"'),
  '周来源 tooltip 展示周一至周日 ISO 范围');

const planRender = frontSection('function renderPlanPool(', 'function renderDoneCards(');
const doneRender = frontSection('function renderDoneCards(', 'function monthRelevant(');
const outlineRender = frontSection('function renderOutline(', '/* ================= 甘特');
const ganttRender = frontSection('function renderGantt(', '/* ================= 周页');
const weekRender = frontSection('function renderWeek(', '/* ================= 日页');
const dayRender = frontSection('function renderDay(', '/* ================= 挂靠');
ok(planRender.includes("originBadge(t,'month')") && planRender.includes("treeRow(k,1,'month')") &&
  doneRender.includes("originBadge(t,'month')") &&
  outlineRender.includes("originBadge(t,'month')") &&
  ganttRender.includes("originBadge(t,isMonth?'month':'week')") &&
  weekRender.includes("originBadge(t,'week')") && dayRender.includes("originBadge(e,'day')"),
'来源徽章仅接入月规划/完成/大纲、月周甘特、周列表与日执行区域');
ok(!frontSection('function renderYear(', 'function renderMonth(').includes('originBadge(') &&
  !frontSection('function renderPool(', 'function renderPlanPool(').includes('originBadge('),
'年度与任务池不渲染来源徽章');

const rolloverAction = frontSection('async function runPastRollover(', '/* =================');
const rolloverBindings = frontSection("$('rollPastDay').addEventListener", '/* 创建矩阵 */');
ok(rolloverAction.includes("api('POST','/api/rollover/past',{scope,to})") &&
  rolloverAction.includes('if(!confirm(') && rolloverAction.includes('btn.disabled=true') &&
  rolloverAction.includes('await reload()') && rolloverAction.includes('finally{btn.disabled=false;}') &&
  rolloverBindings.includes("'day',") && rolloverBindings.includes("'week',mon") &&
  rolloverBindings.includes("'month',ym"), '全量顺延确认、精确 payload、忙碌态、重载与三类绑定完整');

const dayRolloverBinding = frontSection("$('rollPastDay').addEventListener", "$('rollPastWeek').addEventListener");
let capturedDayHandler = null, dayTodayCalls = 0, capturedDayTarget = null;
const dayButton = { addEventListener: (_event, handler) => { capturedDayHandler = handler; } };
const dayBindingContext = vm.createContext({
  $: () => dayButton,
  today: () => ['2026-08-06', '2026-08-07'][dayTodayCalls++],
  viewDay: '2026-08-01',
  runPastRollover: (_btn, scope, to, onTarget) => {
    capturedDayTarget = { scope, request: to };
    onTarget();
  }
});
vm.runInContext(dayRolloverBinding, dayBindingContext);
capturedDayHandler?.();
ok(dayTodayCalls === 1 && capturedDayTarget?.scope === 'day' &&
  capturedDayTarget.request === '2026-08-06' && dayBindingContext.viewDay === '2026-08-06',
  '每日全量顺延单次捕获 today 并复用为请求与成功视图目标');

// 直接执行 HTML 中的真实函数；仅替换浏览器/API 边界，不复制实现逻辑
const loadRunPastRollover = deps => {
  const context = vm.createContext({ ...deps });
  vm.runInContext(`${rolloverAction};this.runPastRollover=runPastRollover;`, context);
  return context.runPastRollover;
};

let cancelApiCalls = 0;
const cancelBtn = { disabled: false };
await loadRunPastRollover({
  confirm: () => false,
  api: async () => { cancelApiCalls++; },
  reload: async () => {},
  toast: () => {}
})(cancelBtn, 'day', '2026-08-06', () => {});
ok(cancelApiCalls === 0 && cancelBtn.disabled === false,
  '全量顺延行为：取消确认不请求且按钮保持可用');

const successEvents = [];
const successBtn = { disabled: false };
let successPayload = null, successDisabledDuring = false;
await loadRunPastRollover({
  confirm: () => { successEvents.push('confirm'); return true; },
  api: async (method, route, payload) => {
    successEvents.push('api'); successDisabledDuring = successBtn.disabled;
    successPayload = { method, route, scope: payload.scope, to: payload.to };
    return { count: 2 };
  },
  reload: async () => { successEvents.push('reload'); },
  toast: message => { successEvents.push('toast:' + message); }
})(successBtn, 'week', '2026-08-03', () => { successEvents.push('target'); });
ok(JSON.stringify(successPayload) === JSON.stringify({
  method: 'POST', route: '/api/rollover/past', scope: 'week', to: '2026-08-03'
}) && successDisabledDuring && successBtn.disabled === false &&
  successEvents.join('|') === 'confirm|api|target|reload|toast:已顺延 2 项到本周 ✓',
  '全量顺延行为：精确 payload、请求中禁用及成功 target→reload→toast');

let allFailuresRecovered = true;
for (const message of ['HTTP 500', 'network down']) {
  const events = [], btn = { disabled: false };
  await loadRunPastRollover({
    confirm: () => { events.push('confirm'); return true; },
    api: async () => { events.push('api'); throw new Error(message); },
    reload: async () => { events.push('reload'); throw new Error('reload failed'); },
    toast: text => { events.push('toast:' + text); }
  })(btn, 'month', '2026-08', () => { events.push('target'); });
  allFailuresRecovered &&= btn.disabled === false &&
    events.join('|') === `confirm|api|toast:顺延失败:${message}|reload`;
}
ok(allFailuresRecovered, '全量顺延行为：500/异常均尝试 reload、错误 toast 且 finally 恢复');

let concurrentApiCalls = 0, concurrentConfirms = 0, concurrentTargets = 0;
const concurrentBtn = { disabled: false }, releases = [];
const concurrentRun = loadRunPastRollover({
  confirm: () => { concurrentConfirms++; return true; },
  api: async () => {
    concurrentApiCalls++;
    return await new Promise(resolve => releases.push(resolve));
  },
  reload: async () => {},
  toast: () => {}
});
const firstRollover = concurrentRun(concurrentBtn, 'day', '2026-08-06', () => { concurrentTargets++; });
const duplicateRollover = concurrentRun(concurrentBtn, 'day', '2026-08-06', () => { concurrentTargets++; });
releases.forEach(resolve => resolve({ count: 1 }));
await Promise.all([firstRollover, duplicateRollover]);
ok(concurrentApiCalls === 1 && concurrentConfirms === 1 && concurrentTargets === 1 && concurrentBtn.disabled === false,
  '全量顺延行为：按钮禁用期间拒绝并发重复提交');

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
const monthDatePriority = [
  {id:11,parent_id:null,status:'planned',month:'2026-01',start_date:'2026-02-01',end_date:'2026-02-02'},
  {id:12,parent_id:null,status:'planned',month:'2026-01',start_date:'2026-03-10',end_date:'2026-03-12'},
  {id:13,parent_id:null,status:'planned',month:'2026-01',start_date:'2026-02-01',end_date:null},
  {id:14,parent_id:null,status:'planned',month:'2026-01',start_date:'2026-03-10',end_date:null},
  {id:15,parent_id:null,status:'planned',month:'2026-01',start_date:null,end_date:'2026-02-01'},
  {id:16,parent_id:null,status:'planned',month:'2026-01',start_date:null,end_date:'2026-03-12'},
  {id:17,parent_id:null,status:'planned',month:'2026-01',start_date:'2026-01-10',end_date:'2026-01-12'}
];
const monthDatePriorityPicked = rollHelp.selectPastRoots?.(monthDatePriority,'month','2026-02') || [];
const monthDatePriorityNodes = new Set(monthDatePriorityPicked.flatMap(g => g.nodes.map(x => x.id)));
ok(!monthDatePriorityNodes.has(11) && !monthDatePriorityNodes.has(12),
  '旧 month 不覆盖当前或未来完整日期区间');
ok(!monthDatePriorityNodes.has(13) && !monthDatePriorityNodes.has(14),
  '旧 month 不覆盖当前或未来 start-only 日期');
ok(!monthDatePriorityNodes.has(15) && !monthDatePriorityNodes.has(16),
  '旧 month 不覆盖当前或未来 end-only 日期');
ok(monthDatePriorityNodes.has(17), '旧 month 加真正旧日期仍可顺延');

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
tdb.exec('DELETE FROM executions; DELETE FROM tasks');

// ── 旧入口与新入口混用仍保留首次来源，且旧入口逐项审计包含来源状态
const legacyMonthTask = (await api('POST', '/api/task', {
  name: '旧月入口来源链', month: '2026-07'
})).body.task;
const legacyMonthAuditStart = tdb.prepare('SELECT COALESCE(MAX(id),0) id FROM audit').get().id;
const legacyMonthRoll = await api('POST', '/api/rollover', {
  scope: 'month', from: '2026-07', to: '2026-08'
});
const legacyMonthAfter = tdb.prepare('SELECT * FROM tasks WHERE id=?').get(legacyMonthTask.id);
const legacyMonthAuditRow = tdb.prepare(`SELECT before_json,after_json FROM audit
  WHERE id>? AND entity='task' AND entity_id=? AND action='rollover-month' ORDER BY id DESC LIMIT 1`)
  .get(legacyMonthAuditStart, legacyMonthTask.id);
const legacyMonthAuditState = legacyMonthAuditRow ? {
  before: JSON.parse(legacyMonthAuditRow.before_json),
  after: JSON.parse(legacyMonthAuditRow.after_json)
} : null;
ok(legacyMonthRoll.status === 200 &&
  JSON.stringify(Object.keys(legacyMonthRoll.body).sort()) === JSON.stringify(['count', 'ok']) &&
  legacyMonthRoll.body.count === 1 && legacyMonthAfter.month === '2026-08' &&
  legacyMonthAfter.rollover_origin_month === '2026-07',
  '旧月入口保持响应/移动语义并以 COALESCE 写入首次来源月');
ok(legacyMonthAuditState?.before.rollover_origin_month == null &&
  legacyMonthAuditState?.after.rollover_origin_month === '2026-07' &&
  legacyMonthAuditState?.before.month === '2026-07' && legacyMonthAuditState?.after.month === '2026-08',
  '旧月入口逐项审计 before/after 包含新持久来源状态');
const mixedMonthAuditStart = tdb.prepare('SELECT COALESCE(MAX(id),0) id FROM audit').get().id;
const mixedMonthRoll = await api('POST', '/api/rollover/past', { scope: 'month', to: '2026-09' });
const mixedMonthAfter = tdb.prepare('SELECT * FROM tasks WHERE id=?').get(legacyMonthTask.id);
const mixedMonthBatch = tdb.prepare(`SELECT after_json FROM audit
  WHERE id>? AND action='rollover-past-month' ORDER BY id DESC LIMIT 1`).get(mixedMonthAuditStart);
const mixedMonthBatchAfter = mixedMonthBatch ? JSON.parse(mixedMonthBatch.after_json) : null;
ok(mixedMonthRoll.status === 200 && mixedMonthRoll.body.count === 1 &&
  mixedMonthAfter.month === '2026-09' && mixedMonthAfter.rollover_origin_month === '2026-07',
  '旧月入口七月至八月后接全量顺延到九月仍保留七月来源');
ok(JSON.stringify(mixedMonthBatchAfter?.origins) === JSON.stringify(['2026-07']),
  '混用入口后的月批次审计汇总最终持久首次来源');

const legacyDayDates = tdb.prepare(`SELECT
  date('now','-10 day') origin,
  date('now','-9 day') middle,
  date('now','-8 day') target`).get();
const legacyDayExecution = (await api('POST', '/api/execution', {
  text: '旧日入口来源链', date: legacyDayDates.origin
})).body.execution;
const legacyDayAuditStart = tdb.prepare('SELECT COALESCE(MAX(id),0) id FROM audit').get().id;
const legacyDayRoll = await api('POST', '/api/rollover', {
  scope: 'day', from: legacyDayDates.origin, to: legacyDayDates.middle
});
const legacyDayAfter = tdb.prepare('SELECT * FROM executions WHERE id=?').get(legacyDayExecution.id);
const legacyDayAuditRow = tdb.prepare(`SELECT before_json,after_json FROM audit
  WHERE id>? AND entity='execution' AND entity_id=? AND action='rollover-day' ORDER BY id DESC LIMIT 1`)
  .get(legacyDayAuditStart, legacyDayExecution.id);
const legacyDayAuditState = legacyDayAuditRow ? {
  before: JSON.parse(legacyDayAuditRow.before_json),
  after: JSON.parse(legacyDayAuditRow.after_json)
} : null;
ok(legacyDayRoll.status === 200 &&
  JSON.stringify(Object.keys(legacyDayRoll.body).sort()) === JSON.stringify(['count', 'ok']) &&
  legacyDayRoll.body.count === 1 && legacyDayAfter.date === legacyDayDates.middle &&
  legacyDayAfter.rollover_origin_date === legacyDayDates.origin,
  '旧日入口保持响应/移动语义并以 COALESCE 写入首次来源日');
ok(legacyDayAuditState?.before.rollover_origin_date == null &&
  legacyDayAuditState?.after.rollover_origin_date === legacyDayDates.origin &&
  legacyDayAuditState?.before.date === legacyDayDates.origin &&
  legacyDayAuditState?.after.date === legacyDayDates.middle,
  '旧日入口逐项审计 before/after 包含新持久来源状态');
const mixedDayAuditStart = tdb.prepare('SELECT COALESCE(MAX(id),0) id FROM audit').get().id;
const mixedDayRoll = await api('POST', '/api/rollover/past', { scope: 'day', to: legacyDayDates.target });
const mixedDayAfter = tdb.prepare('SELECT * FROM executions WHERE id=?').get(legacyDayExecution.id);
const mixedDayBatch = tdb.prepare(`SELECT after_json FROM audit
  WHERE id>? AND action='rollover-past-day' ORDER BY id DESC LIMIT 1`).get(mixedDayAuditStart);
const mixedDayBatchAfter = mixedDayBatch ? JSON.parse(mixedDayBatch.after_json) : null;
ok(mixedDayRoll.status === 200 && mixedDayRoll.body.count === 1 &&
  mixedDayAfter.date === legacyDayDates.target && mixedDayAfter.rollover_origin_date === legacyDayDates.origin,
  '旧日入口顺延后接全量顺延仍保留最初日期来源');
ok(JSON.stringify(mixedDayBatchAfter?.origins) === JSON.stringify([legacyDayDates.origin]),
  '混用入口后的每日批次审计汇总最终持久首次来源');

tdb.exec('DELETE FROM executions'); // 隔离混用入口与此前每日 execution 夹具
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
const dayAuditStart = tdb.prepare('SELECT COALESCE(MAX(id),0) id FROM audit').get().id;
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
const dayBatchAudit = tdb.prepare(`SELECT after_json FROM audit
  WHERE id>? AND action='rollover-past-day' ORDER BY id DESC LIMIT 1`).get(dayAuditStart);
const dayBatchAuditAfter = dayBatchAudit ? JSON.parse(dayBatchAudit.after_json) : null;
ok(JSON.stringify(dayBatchAuditAfter?.origins) ===
  JSON.stringify([dayDates.old_free, dayDates.old_linked].sort()),
  '每日移动/合并批次审计按最终持久来源汇总 origins');
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
  text: '周接口隔离未完成 sentinel', date: '2026-07-18'
})).body.execution;
tdb.prepare('UPDATE executions SET done=0,notion_id=?,rollover_origin_date=? WHERE id=?')
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
ok(sentinelBefore.done === 0 && sentinelBefore.date < '2026-08-03' &&
  JSON.stringify(sentinelAfter) === JSON.stringify(sentinelBefore),
  '周顺延不修改旧日未完成 sentinel execution 的完整关键字段');

tdb.exec('DELETE FROM tasks');
const provenanceRoot = (await api('POST', '/api/task', { name: '多次顺延簇' })).body.task;
const provenanceTask = (await api('POST', '/api/task', {
  name: '多次顺延节点', parent_id: provenanceRoot.id, month: '2026-07', start: '2026-07-15', end: '2026-07-16'
})).body.task;
const provenanceWeekFirst = await api('POST', '/api/rollover/past', { scope: 'week', to: '2026-08-03' });
const provenanceWeekSecondAuditStart = tdb.prepare('SELECT COALESCE(MAX(id),0) id FROM audit').get().id;
const provenanceWeekSecond = await api('POST', '/api/rollover/past', { scope: 'week', to: '2026-08-10' });
data = (await api('GET', '/api/data')).body;
ok(provenanceWeekFirst.body.count === 1 && provenanceWeekSecond.body.count === 1 &&
  find(provenanceTask.id).start_date === '2026-08-12' && find(provenanceTask.id).end_date === '2026-08-13' &&
  find(provenanceRoot.id).rollover_origin_week === '2026-07-13' &&
  find(provenanceTask.id).rollover_origin_week === '2026-07-13' &&
  find(provenanceTask.id).rollover_origin_month === '2026-07',
  '多次周顺延继续平移排期且不覆盖首次来源周/月');
const provenanceWeekSecondAudit = tdb.prepare(`SELECT after_json FROM audit
  WHERE id>? AND action='rollover-past-week' ORDER BY id DESC LIMIT 1`).get(provenanceWeekSecondAuditStart);
const provenanceWeekSecondAuditAfter = provenanceWeekSecondAudit ? JSON.parse(provenanceWeekSecondAudit.after_json) : null;
ok(JSON.stringify(provenanceWeekSecondAuditAfter?.origins) === JSON.stringify(['2026-07-13']),
  '重复周顺延批次审计持续汇总最初持久来源周');

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

// ── 全量过往月任务簇顺延
tdb.exec('DELETE FROM executions; DELETE FROM tasks');
ok((await api('POST', '/api/rollover/past', { scope: 'month', to: '2026-8' })).status === 400 &&
  (await api('POST', '/api/rollover/past', { scope: 'month', to: '2026-13' })).status === 400 &&
  (await api('POST', '/api/rollover/past', { scope: 'month', to: '2026-02-01' })).status === 400,
  '过往月顺延严格拒绝非 YYYY-MM 或非法月份');

const mRoot = (await api('POST', '/api/task', {
  name: '月末过往月簇', month: '2026-01', start: '2026-01-31', end: '2026-01-31'
})).body.task;
const mOpen = (await api('POST', '/api/task', {
  name: '月末未完成子节点', parent_id: mRoot.id, start: '2026-01-31', end: '2026-01-31'
})).body.task;
const mDone = (await api('POST', '/api/task', {
  name: '月已完成子节点', parent_id: mRoot.id, start: '2026-01-20', end: '2026-01-21'
})).body.task;
await api('POST', `/api/task/${mDone.id}/toggle-done`);
const mDoneBefore = tdb.prepare('SELECT * FROM tasks WHERE id=?').get(mDone.id);

const relativeRoot = (await api('POST', '/api/task', {
  name: '月相对排期根', month: '2026-01', start: '2026-01-15', end: '2026-01-16'
})).body.task;
const relativeChild = (await api('POST', '/api/task', {
  name: '月相对排期子', parent_id: relativeRoot.id, month: '2026-01', start: '2026-01-20', end: '2026-01-22'
})).body.task;
tdb.prepare('UPDATE tasks SET rollover_origin_month=?,rollover_origin_week=? WHERE id=?')
  .run('2025-12', '2025-12-29', relativeChild.id);

const intersectingMonth = (await api('POST', '/api/task', {
  name: '与目标月相交', month: '2026-01', start: '2026-01-31', end: '2026-02-02'
})).body.task;
const currentMonth = (await api('POST', '/api/task', {
  name: '目标月任务', month: '2026-02', start: '2026-02-10', end: '2026-02-11'
})).body.task;
const futureMonth = (await api('POST', '/api/task', {
  name: '未来月任务', month: '2026-03', start: '2026-03-01', end: '2026-03-02'
})).body.task;
const barePool = (await api('POST', '/api/task', { name: '无日期普通池' })).body.task;
const archivedMonth = (await api('POST', '/api/task', {
  name: '已归档旧月', month: '2026-01', start: '2026-01-10', end: '2026-01-11'
})).body.task;
await api('DELETE', `/api/task/${archivedMonth.id}`);

const currentParent = (await api('POST', '/api/task', {
  name: '目标月父节点', month: '2026-02', start: '2026-02-05', end: '2026-02-06'
})).body.task;
const oldChildBranch = (await api('POST', '/api/task', {
  name: '父节点下旧子分支', parent_id: currentParent.id, month: '2026-01', start: '2026-01-18', end: '2026-01-19'
})).body.task;

const oldMonthCurrentRange = (await api('POST', '/api/task', {
  name: '旧月当前完整区间', month: '2026-01', start: '2026-02-01', end: '2026-02-02'
})).body.task;
const oldMonthFutureRange = (await api('POST', '/api/task', {
  name: '旧月未来完整区间', month: '2026-01', start: '2026-03-10', end: '2026-03-12'
})).body.task;
const oldMonthCurrentStartOnly = (await api('POST', '/api/task', {
  name: '旧月当前仅开始日', month: '2026-01', start: '2026-02-01'
})).body.task;
const oldMonthFutureStartOnly = (await api('POST', '/api/task', {
  name: '旧月未来仅开始日', month: '2026-01', start: '2026-03-10'
})).body.task;
const oldMonthCurrentEndOnly = (await api('POST', '/api/task', {
  name: '旧月当前仅结束日', month: '2026-01', end: '2026-02-01'
})).body.task;
const oldMonthFutureEndOnly = (await api('POST', '/api/task', {
  name: '旧月未来仅结束日', month: '2026-01', end: '2026-03-12'
})).body.task;
const protectedMonthRanges = [
  oldMonthCurrentRange, oldMonthFutureRange,
  oldMonthCurrentStartOnly, oldMonthFutureStartOnly,
  oldMonthCurrentEndOnly, oldMonthFutureEndOnly
];
const protectedMonthBefore = new Map(protectedMonthRanges.map(t =>
  [t.id, tdb.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)]));

const monthSentinel = (await api('POST', '/api/execution', {
  text: '月接口隔离未完成 sentinel', date: '2026-01-18'
})).body.execution;
tdb.prepare('UPDATE executions SET done=0,notion_id=?,rollover_origin_date=? WHERE id=?')
  .run('month-sentinel-notion', '2025-12-31', monthSentinel.id);
const monthExecutionFields = 'id,task_id,text,date,done,notion_id,rollover_origin_date';
const monthSentinelBefore = tdb.prepare(`SELECT ${monthExecutionFields} FROM executions WHERE id=?`).get(monthSentinel.id);
const monthAuditStart = tdb.prepare('SELECT COALESCE(MAX(id),0) id FROM audit').get().id;

const pastMonth = await api('POST', '/api/rollover/past', { scope: 'month', to: '2026-02' });
data = (await api('GET', '/api/data')).body;
const expectedMonthRoots = [mRoot.id, relativeRoot.id, oldChildBranch.id];
ok(pastMonth.status === 200 && pastMonth.body.count === 5 && pastMonth.body.merged === 0 &&
  pastMonth.body.roots?.length === expectedMonthRoots.length &&
  expectedMonthRoots.every(id => pastMonth.body.roots.includes(id)),
  '过往月任务簇返回实际移动节点数、簇根和统一 merged');
ok(protectedMonthRanges.every(t => !pastMonth.body.roots?.includes(t.id)),
  '旧 month 的当前未来完整/单边日期任务均不进入 API roots');
ok(find(mRoot.id).start_date === '2026-02-28' && find(mRoot.id).end_date === '2026-02-28' &&
  find(mOpen.id).start_date === '2026-02-28' && find(mOpen.id).end_date === '2026-02-28',
  '月末锚点 1/31 夹到 2/28 且同簇使用同一 deltaDays');
ok(find(relativeRoot.id).start_date === '2026-02-15' && find(relativeRoot.id).end_date === '2026-02-16' &&
  find(relativeChild.id).start_date === '2026-02-20' && find(relativeChild.id).end_date === '2026-02-22',
  '月簇按天整体平移并保持节点时长与树内相对位置');
ok(find(mRoot.id).month === '2026-02' && find(mOpen.id).month === '2026-02' &&
  find(relativeRoot.id).month === '2026-02' && find(relativeChild.id).month === '2026-02' &&
  find(oldChildBranch.id).month === '2026-02',
  '每个实际移动的月节点归属目标月');
ok(find(mRoot.id).rollover_origin_month === '2026-01' && find(mOpen.id).rollover_origin_month === '2026-01' &&
  find(relativeRoot.id).rollover_origin_month === '2026-01' &&
  find(relativeChild.id).rollover_origin_month === '2025-12' &&
  find(relativeChild.id).rollover_origin_week === '2025-12-29',
  '月簇根与移动节点记录首次来源月且不覆盖已有来源周/月');
ok(find(mDone.id).start_date === mDoneBefore.start_date && find(mDone.id).end_date === mDoneBefore.end_date &&
  find(mDone.id).done_at === mDoneBefore.done_at && find(mDone.id).month === mDoneBefore.month,
  '部分完成父簇只顺延开放节点并原地保留完成后代与 done_at');
ok(find(intersectingMonth.id).start_date === '2026-01-31' && find(intersectingMonth.id).month === '2026-01' &&
  find(currentMonth.id).start_date === '2026-02-10' && find(futureMonth.id).start_date === '2026-03-01' &&
  find(barePool.id).month == null && find(barePool.id).rollover_origin_month == null,
  '与目标月相交、当前未来和无日期普通池节点不移动');
const archivedMonthAfter = (await api('GET', '/api/data?archived=1')).body.tasks.find(t => t.id === archivedMonth.id);
ok(archivedMonthAfter?.start_date === '2026-01-10' && archivedMonthAfter.month === '2026-01' &&
  archivedMonthAfter.rollover_origin_month == null,
  'archived 旧月节点不移动');
ok(find(currentParent.id).month === '2026-02' && find(currentParent.id).start_date === '2026-02-05' &&
  find(currentParent.id).rollover_origin_month == null &&
  find(oldChildBranch.id).start_date === '2026-02-18' && find(oldChildBranch.id).end_date === '2026-02-19',
  '当前月父节点不动且其旧子分支独立顺延');
const taskRowUnchanged = id => JSON.stringify(tdb.prepare('SELECT * FROM tasks WHERE id=?').get(id)) ===
  JSON.stringify(protectedMonthBefore.get(id));
ok([oldMonthCurrentRange.id, oldMonthFutureRange.id].every(taskRowUnchanged),
  'API 后旧 month 的当前未来完整区间全部字段不变');
ok([oldMonthCurrentStartOnly.id, oldMonthFutureStartOnly.id].every(taskRowUnchanged),
  'API 后旧 month 的当前未来 start-only 全部字段不变');
ok([oldMonthCurrentEndOnly.id, oldMonthFutureEndOnly.id].every(taskRowUnchanged),
  'API 后旧 month 的当前未来 end-only 全部字段不变');
const monthSentinelAfter = tdb.prepare(`SELECT ${monthExecutionFields} FROM executions WHERE id=?`).get(monthSentinel.id);
ok(JSON.stringify(monthSentinelAfter) === JSON.stringify(monthSentinelBefore),
  '月顺延不修改旧日未完成 execution 的完整关键字段');

const monthAudits = tdb.prepare('SELECT entity_id,action,before_json,after_json FROM audit WHERE id>? ORDER BY id')
  .all(monthAuditStart).map(row => ({
    entity_id: row.entity_id,
    action: row.action,
    before: row.before_json ? JSON.parse(row.before_json) : null,
    after: row.after_json ? JSON.parse(row.after_json) : null
  }));
const monthMovedIds = [mRoot.id, mOpen.id, relativeRoot.id, relativeChild.id, oldChildBranch.id];
ok(monthMovedIds.every(id => monthAudits.some(row => row.entity_id === id && row.action === 'rollover-month' &&
  row.before && row.after && (row.before.start_date !== row.after.start_date || row.before.month !== row.after.month))),
  '月顺延逐项审计每个实际移动节点');
const monthBatchAudit = monthAudits.find(row => row.entity_id == null && row.action === 'rollover-past-month');
const monthOriginByRoot = new Map((monthBatchAudit?.after?.roots || [])
  .map((rootId, index) => [rootId, monthBatchAudit.after.origins?.[index]]));
ok(monthBatchAudit &&
  monthBatchAudit.after?.to === '2026-02' && monthBatchAudit.after.count === 5 &&
  monthBatchAudit.after.roots?.length === expectedMonthRoots.length &&
  expectedMonthRoots.every(id => monthBatchAudit.after.roots.includes(id)) &&
  monthOriginByRoot.get(mRoot.id) === '2026-01' &&
  monthOriginByRoot.get(relativeRoot.id) === '2025-12' &&
  monthOriginByRoot.get(oldChildBranch.id) === '2026-01',
  '月顺延批次审计记录与 roots 对应的持久首次 origins');
const pastMonthAgain = await api('POST', '/api/rollover/past', { scope: 'month', to: '2026-02' });
ok(pastMonthAgain.status === 200 && pastMonthAgain.body.count === 0 &&
  pastMonthAgain.body.roots?.length === 0 && pastMonthAgain.body.merged === 0,
  '重复顺延同一目标月返回空结果');

tdb.exec('DELETE FROM executions; DELETE FROM tasks');
const bareMonth = (await api('POST', '/api/task', { name: '旧月无日期', month: '2026-06' })).body.task;
const bareMonthRoll = await api('POST', '/api/rollover/past', { scope: 'month', to: '2026-08' });
data = (await api('GET', '/api/data')).body;
ok(bareMonthRoll.status === 200 && bareMonthRoll.body.count === 1 &&
  JSON.stringify(bareMonthRoll.body.roots) === JSON.stringify([bareMonth.id]) &&
  find(bareMonth.id).month === '2026-08' && find(bareMonth.id).rollover_origin_month === '2026-06',
  '无日期旧 month 更新归属并记录首次来源月');

tdb.exec('DELETE FROM tasks');
const repeatedRoot = (await api('POST', '/api/task', { name: '多次月顺延簇' })).body.task;
const repeatedTask = (await api('POST', '/api/task', {
  name: '多次月顺延节点', parent_id: repeatedRoot.id, month: '2026-07', start: '2026-07-15', end: '2026-07-16'
})).body.task;
const repeatedMonthFirst = await api('POST', '/api/rollover/past', { scope: 'month', to: '2026-08' });
const repeatedMonthSecondAuditStart = tdb.prepare('SELECT COALESCE(MAX(id),0) id FROM audit').get().id;
const repeatedMonthSecond = await api('POST', '/api/rollover/past', { scope: 'month', to: '2026-09' });
data = (await api('GET', '/api/data')).body;
ok(repeatedMonthFirst.body.count === 1 && repeatedMonthSecond.body.count === 1 &&
  find(repeatedTask.id).start_date === '2026-09-15' && find(repeatedTask.id).end_date === '2026-09-16' &&
  find(repeatedRoot.id).rollover_origin_month === '2026-07' &&
  find(repeatedTask.id).rollover_origin_month === '2026-07' && find(repeatedTask.id).month === '2026-09',
  '多次月顺延继续平移排期且保留最早原始月');
const repeatedMonthSecondAudit = tdb.prepare(`SELECT after_json FROM audit
  WHERE id>? AND action='rollover-past-month' ORDER BY id DESC LIMIT 1`).get(repeatedMonthSecondAuditStart);
const repeatedMonthSecondAuditAfter = repeatedMonthSecondAudit ? JSON.parse(repeatedMonthSecondAudit.after_json) : null;
ok(JSON.stringify(repeatedMonthSecondAuditAfter?.origins) === JSON.stringify(['2026-07']),
  '重复月顺延批次审计持续汇总最初持久来源月');

tdb.exec('DELETE FROM tasks');
const monthTxRoot = (await api('POST', '/api/task', { name: '月事务簇' })).body.task;
const monthTxFirst = (await api('POST', '/api/task', {
  name: '月事务节点一', parent_id: monthTxRoot.id, month: '2026-01', start: '2026-01-10', end: '2026-01-11'
})).body.task;
const monthTxSecond = (await api('POST', '/api/task', {
  name: '月事务节点二', parent_id: monthTxRoot.id, month: '2026-01', start: '2026-01-20', end: '2026-01-21'
})).body.task;
tdb.exec(`CREATE TRIGGER fail_past_month_rollover BEFORE UPDATE OF start_date ON tasks
  WHEN OLD.id=${monthTxSecond.id} BEGIN SELECT RAISE(ABORT,'test month rollback'); END`);
const monthTxAuditBefore = tdb.prepare('SELECT COUNT(*) count,COALESCE(MAX(id),0) max_id FROM audit').get();
const failedMonthTx = await api('POST', '/api/rollover/past', { scope: 'month', to: '2026-02' });
const monthRolledBack = tdb.prepare('SELECT * FROM tasks WHERE id IN (?,?,?) ORDER BY id')
  .all(monthTxRoot.id, monthTxFirst.id, monthTxSecond.id);
const monthTxAuditAfter = tdb.prepare('SELECT COUNT(*) count,COALESCE(MAX(id),0) max_id FROM audit').get();
ok(failedMonthTx.status === 500 && monthRolledBack[0]?.rollover_origin_month == null &&
  monthRolledBack[1]?.start_date === '2026-01-10' && monthRolledBack[1]?.month === '2026-01' &&
  monthRolledBack[1]?.rollover_origin_month == null &&
  monthRolledBack[2]?.start_date === '2026-01-20' && monthRolledBack[2]?.month === '2026-01' &&
  monthRolledBack[2]?.rollover_origin_month == null,
  '月顺延任一节点失败时整批任务与来源月事务回滚');
ok(monthTxAuditAfter.count === monthTxAuditBefore.count && monthTxAuditAfter.max_id === monthTxAuditBefore.max_id,
  '月顺延失败时逐项和批次 audit 均不留新增记录');
tdb.exec('DROP TRIGGER fail_past_month_rollover');

// ── 审计
const auditCount = tdb.prepare('SELECT COUNT(*) c FROM audit').get().c;
ok(auditCount > 20, `审计日志已记录(${auditCount}条)`);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
srv.close();
for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + suf); } catch {} }
process.exit(fail ? 1 : 0);
