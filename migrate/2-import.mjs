// snapshot.json → data/tiangang.db
// 安全:目标库已存在时拒绝执行(防止覆盖上线后的新数据),用 --force 覆盖重建
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { open, tx, DB_PATH } = require('../db.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(fs.readFileSync(path.join(HERE, 'snapshot.json'), 'utf8'));

if (fs.existsSync(DB_PATH) && !process.argv.includes('--force')) {
  console.error(`目标库已存在: ${DB_PATH}\n为防覆盖上线后的数据,请确认后加 --force 重建`);
  process.exit(1);
}
for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suf); } catch {} }
const db = open();

// ---- Notion 属性取值助手(raw API shape) ----
const P = pg => pg.properties || {};
const title = p => (p?.title || []).map(t => t.plain_text).join('');
const text  = p => (p?.rich_text || []).map(t => t.plain_text).join('');
const sel   = p => p?.select?.name || '';
const stat  = p => p?.status?.name || '';
const num   = p => p?.number ?? 0;
const chk   = p => !!p?.checkbox;
const date  = p => p?.date?.start || '';
const rel   = p => (p?.relation || []).map(r => r.id);
// 步骤文本尾部 📅 标记(与老系统同一正则)
const MARK = /\s*📅️?\s*(\d{4}-\d{2}-\d{2})(?:\s*(?:→|->)\s*(\d{4}-\d{2}-\d{2}))?\s*$/;
const parseMark = plain => {
  const m = (plain || '').match(MARK);
  if (!m) return { text: plain, s: null, e: null };
  return { text: plain.slice(0, m.index), s: m[1], e: m[2] || m[1] };
};

const goalMap = new Map();   // notion goal id → new id
const taskMap = new Map();   // notion page id(池/月度/周/步骤块) → new task id
const stats = { merged: 0, notes: 0 };

tx(db, () => {
  const insGoal = db.prepare(`INSERT INTO goals(name,domain,criteria,year,progress,status,sort,notion_id) VALUES(?,?,?,?,?,?,?,?)`);
  const insTask = db.prepare(`INSERT INTO tasks(parent_id,goal_id,name,kind,priority,status,month,start_date,end_date,sort,note,done_at,notion_id)
                              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insExec = db.prepare(`INSERT INTO executions(task_id,text,date,done,notion_id) VALUES(?,?,?,?,?)`);

  // ① 年度目标
  snap.dbs.goals.forEach((g, i) => {
    const p = P(g);
    const r = insGoal.run(title(p['目标']), sel(p['领域']), text(p['成功标准']),
      parseInt(sel(p['年份'])) || 2026, num(p['当前进度']), stat(p['状态']) || '未开始', i + 1, g.id);
    goalMap.set(g.id, Number(r.lastInsertRowid));
  });

  // ② 任务池(个人成长+主业)→ 顶层任务
  const poolStatus = s => s === '待分配' ? 'pool' : (s === '已完成' ? 'done' : (s === '已分配' || s === '进行中') ? 'planned' : 'archived');
  for (const [key, kind] of [['growthPool', '个人成长'], ['workPool', '工作']]) {
    snap.dbs[key].forEach((t, i) => {
      const p = P(t);
      const st = poolStatus(sel(p['状态']));
      const gid = rel(p['关联年度目标'])[0];
      const r = insTask.run(null, gid ? goalMap.get(gid) ?? null : null, title(p['任务']), kind,
        sel(p['优先级']) || null, st, null, null, null, (i + 1) * 10, null,
        st === 'done' ? snap.fetched_at.slice(0, 10) : null, t.id);
      taskMap.set(t.id, Number(r.lastInsertRowid));
    });
  }

  // ③ 月度条目:有池关联 → 合并到池任务(月度名为准,池异名进备注);无关联 → 新建
  const updTask = db.prepare(`UPDATE tasks SET name=?, status=?, month=?, kind=?, priority=COALESCE(?,priority), note=COALESCE(?,note) WHERE id=?`);
  const getName = db.prepare(`SELECT name FROM tasks WHERE id=?`);
  snap.dbs.monthly.forEach(m => {
    const p = P(m);
    const poolId = rel(p['关联任务池'])[0] || rel(p['关联主业任务池'])[0] || null;
    const pct = num(p['完成度']);
    let note = (pct > 0 && pct < 100) ? `迁移备注:原手填完成度 ${pct}%` : null;
    if (note) stats.notes++;
    if (poolId && taskMap.has(poolId)) {
      const tid = taskMap.get(poolId);
      const mName = title(p['事项']);
      const poolName = getName.get(tid).name;
      if (poolName !== mName) { note = ((note ? note + ';' : '') + `迁移备注:任务池原名「${poolName}」`); stats.notes++; }
      updTask.run(mName, 'planned', sel(p['月份']) || null, sel(p['类型']) || '个人成长', sel(p['优先级']) || null, note, tid);
      taskMap.set(m.id, tid);   // 月度页 id 也映射到同一任务
      stats.merged++;
    } else {
      const r = insTask.run(null, null, title(p['事项']), sel(p['类型']) || '个人成长',
        sel(p['优先级']) || null, 'planned', sel(p['月份']) || null, null, null, null, note, null, m.id);
      taskMap.set(m.id, Number(r.lastInsertRowid));
    }
  });

  // ④ 周条目:有月度关联 → 日期/排序回填;独立 → 新建顶层任务(有日期,status planned)
  const updSched = db.prepare(`UPDATE tasks SET start_date=?, end_date=?, sort=COALESCE(?,sort), done_at=COALESCE(?,done_at), status=CASE WHEN ?='1' THEN 'done' ELSE status END WHERE id=?`);
  snap.dbs.weekly.forEach(w => {
    const p = P(w);
    const mId = rel(p['关联月度事项'])[0];
    const done = chk(p['完成情况']);
    if (mId && taskMap.has(mId)) {
      updSched.run(date(p['开始日期']) || null, date(p['结束日期']) || null,
        p['排序']?.number ?? null, done ? snap.fetched_at.slice(0, 10) : null, done ? '1' : '0', taskMap.get(mId));
      taskMap.set(w.id, taskMap.get(mId));   // 周页 id(步骤宿主可能是它)也映射过去
    } else {
      const r = insTask.run(null, null, title(p['任务']), sel(p['类型']) || '个人成长',
        sel(p['优先级']) || null, done ? 'done' : 'planned', null,
        date(p['开始日期']) || null, date(p['结束日期']) || null,
        p['排序']?.number ?? null, null, done ? snap.fetched_at.slice(0, 10) : null, w.id);
      taskMap.set(w.id, Number(r.lastInsertRowid));
    }
  });

  // ⑤ 步骤块 → 子任务(宿主=月度页或周任务页)
  for (const [hostPage, todos] of Object.entries(snap.steps)) {
    const parentId = taskMap.get(hostPage);
    if (!parentId) { console.warn(`! 步骤宿主未映射,跳过 ${hostPage} (${todos.length}条)`); continue; }
    todos.forEach((td, i) => {
      const mk = parseMark(td.text);
      const r = insTask.run(parentId, null, mk.text.trim() || '(未命名)', null, null,
        td.checked ? 'done' : 'planned', null, mk.s, mk.e, (i + 1) * 10, null,
        td.checked ? snap.fetched_at.slice(0, 10) : null, td.id);
      taskMap.set(td.id, Number(r.lastInsertRowid));
    });
  }

  // ⑥ 每日待办 → executions('mId|bId' 经 blockId 映射;无关联=自由文本)
  snap.dbs.daily.forEach(d => {
    const p = P(d);
    const ref = text(p['关联步骤']);
    const bId = ref.includes('|') ? ref.split('|')[1] : null;
    const tid = bId ? taskMap.get(bId) ?? null : null;
    insExec.run(tid, tid ? null : title(p['待办']), date(p['日期']) || snap.fetched_at.slice(0, 10),
      chk(p['完成']) ? 1 : 0, d.id);
  });
});

// ---- 对账 ----
const c = q => db.prepare(q).get().c;
console.log('=== 导入对账 ===');
console.log(`goals:      ${c('SELECT COUNT(*) c FROM goals')}  (快照 ${snap.dbs.goals.length})`);
console.log(`tasks 总数:  ${c('SELECT COUNT(*) c FROM tasks')}`);
console.log(`  顶层:      ${c('SELECT COUNT(*) c FROM tasks WHERE parent_id IS NULL')}`);
console.log(`  子任务:    ${c('SELECT COUNT(*) c FROM tasks WHERE parent_id IS NOT NULL')}  (快照步骤 ${Object.values(snap.steps).flat().length})`);
console.log(`  pool:      ${c("SELECT COUNT(*) c FROM tasks WHERE status='pool'")}`);
console.log(`  planned:   ${c("SELECT COUNT(*) c FROM tasks WHERE status='planned'")}`);
console.log(`  done:      ${c("SELECT COUNT(*) c FROM tasks WHERE status='done'")}`);
console.log(`  有月份:    ${c('SELECT COUNT(*) c FROM tasks WHERE month IS NOT NULL')}`);
console.log(`  有日期:    ${c('SELECT COUNT(*) c FROM tasks WHERE start_date IS NOT NULL')}`);
console.log(`  月度合并:  ${stats.merged} 条(池+月度合一) / 迁移备注 ${stats.notes} 条`);
console.log(`executions: ${c('SELECT COUNT(*) c FROM executions')}  (快照 ${snap.dbs.daily.length})`);
console.log('\n=== 抽样(树) ===');
for (const row of db.prepare(`SELECT id,name,status,month,start_date,end_date FROM tasks WHERE parent_id IS NULL AND start_date IS NOT NULL LIMIT 3`).all()) {
  console.log(`▸ [${row.id}] ${row.name} (${row.status}, ${row.month || '-'}, ${row.start_date}→${row.end_date})`);
  for (const ch of db.prepare(`SELECT id,name,status,start_date,end_date FROM tasks WHERE parent_id=?`).all(row.id)) {
    console.log(`   └ [${ch.id}] ${ch.name} (${ch.status}${ch.start_date ? ', ' + ch.start_date + '→' + ch.end_date : ''})`);
  }
}
console.log('\n导入完成 →', DB_PATH);
