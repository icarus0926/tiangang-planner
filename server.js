/**
 * 天罡日程 2.0 · 本地任务树后端
 * - SQLite(node:sqlite) 单文件数据库,毫秒级读写,事务原子
 * - 任务=递归树(parent_id);完成自下而上冒泡;字段点亮决定层级可见性
 * - 全部写操作记 audit;启动+每24h 自动备份
 */
try { require('dotenv').config({ path: __dirname + '/.env' }); } catch (e) { /* 无 dotenv 时用系统环境变量 */ }
const express = require('express');
const path = require('path');
const { open, tx, backup } = require('./db.js');

const app = express();
app.use(express.json());
const KEY = process.env.DASH_PASSWORD || '';
const PORT = process.env.PORT || 8787;
const db = open();

// 备份:启动时 + 每 24h
const b0 = backup(db); if (b0) console.log('启动备份 →', b0);
setInterval(() => backup(db), 24 * 3600 * 1000).unref();

// ---- 助手 ----
const today = () => { const n = new Date(); return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0'); };
const getTask = id => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const childrenOf = id => db.prepare('SELECT * FROM tasks WHERE parent_id=?').all(id);
const descendantIds = id => db.prepare(`WITH RECURSIVE d(id) AS (SELECT id FROM tasks WHERE id=? UNION ALL SELECT t.id FROM tasks t JOIN d ON t.parent_id=d.id) SELECT id FROM d`).all(id).map(r => r.id);
const audit = (entity, entityId, action, before, after) =>
  db.prepare('INSERT INTO audit(entity,entity_id,action,before_json,after_json) VALUES(?,?,?,?,?)')
    .run(entity, entityId ?? null, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);

// 完成冒泡:从 taskId 的父链向上,父的 done = 全体子 done(排除 archived)
function bubbleDone(taskId) {
  let cur = getTask(taskId);
  while (cur && cur.parent_id) {
    const parent = getTask(cur.parent_id);
    if (!parent) break;
    const kids = db.prepare(`SELECT status FROM tasks WHERE parent_id=? AND status!='archived'`).all(parent.id);
    const allDone = kids.length > 0 && kids.every(k => k.status === 'done');
    if (allDone && parent.status !== 'done') {
      db.prepare(`UPDATE tasks SET status='done', done_at=? WHERE id=?`).run(today(), parent.id);
      audit('task', parent.id, 'auto-done', { status: parent.status }, { status: 'done' });
    } else if (!allDone && parent.status === 'done') {
      db.prepare(`UPDATE tasks SET status='planned', done_at=NULL WHERE id=?`).run(parent.id);
      audit('task', parent.id, 'auto-reopen', { status: 'done' }, { status: 'planned' });
    } else break;   // 父状态没变,更上层也不会变
    cur = parent;
  }
}

// ---- 口令门 ----
app.use('/api', (req, res, next) => {
  if (KEY && req.headers['x-dash-key'] !== KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// ---- 读 ----
app.get('/api/data', (req, res) => {
  try {
    const goals = db.prepare('SELECT * FROM goals ORDER BY sort').all();
    const showArchived = req.query.archived === '1';
    const tasks = db.prepare(`SELECT * FROM tasks ${showArchived ? '' : "WHERE status!='archived'"} ORDER BY sort, id`).all();
    // 子树叶子进度(内存后序遍历,一次算完)
    const kids = new Map();
    tasks.forEach(t => { if (t.parent_id) { (kids.get(t.parent_id) || kids.set(t.parent_id, []).get(t.parent_id)).push(t); } });
    const prog = new Map();
    const calc = t => {
      if (prog.has(t.id)) return prog.get(t.id);
      const ch = kids.get(t.id) || [];
      let r;
      if (!ch.length) r = { leaves: 1, done: t.status === 'done' ? 1 : 0 };
      else r = ch.map(calc).reduce((a, c) => ({ leaves: a.leaves + c.leaves, done: a.done + c.done }), { leaves: 0, done: 0 });
      prog.set(t.id, r); return r;
    };
    tasks.forEach(calc);
    const out = tasks.map(t => ({ ...t, leaves: prog.get(t.id).leaves, done_leaves: prog.get(t.id).done }));
    const executions = db.prepare(`SELECT e.*, t.name AS task_name, t.parent_id AS task_parent FROM executions e LEFT JOIN tasks t ON t.id=e.task_id WHERE e.date >= date('now','-45 day') ORDER BY e.id`).all();
    res.json({ goals, tasks: out, executions, snapshot: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---- 年度目标 ----
app.post('/api/goal', (req, res) => {
  try {
    const { name, domain, criteria } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'missing name' });
    const r = db.prepare(`INSERT INTO goals(name,domain,criteria,sort) VALUES(?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM goals))`)
      .run(name.trim(), domain || null, criteria || null);
    const row = db.prepare('SELECT * FROM goals WHERE id=?').get(Number(r.lastInsertRowid));
    audit('goal', row.id, 'create', null, row);
    res.json({ ok: true, goal: row });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.patch('/api/goal/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const before = db.prepare('SELECT * FROM goals WHERE id=?').get(id);
    if (!before) return res.status(404).json({ error: 'not found' });
    const allowed = ['name', 'domain', 'criteria', 'progress', 'status', 'sort'];
    const sets = [], vals = [];
    for (const k of allowed) if (k in (req.body || {})) { sets.push(`${k}=?`); vals.push(req.body[k]); }
    if (!sets.length) return res.status(400).json({ error: 'no fields' });
    db.prepare(`UPDATE goals SET ${sets.join(',')} WHERE id=?`).run(...vals, id);
    const after = db.prepare('SELECT * FROM goals WHERE id=?').get(id);
    audit('goal', id, 'update', before, after);
    res.json({ ok: true, goal: after });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.delete('/api/goal/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const before = db.prepare('SELECT * FROM goals WHERE id=?').get(id);
    if (!before) return res.status(404).json({ error: 'not found' });
    db.prepare('DELETE FROM goals WHERE id=?').run(id);   // tasks.goal_id 外键 SET NULL
    audit('goal', id, 'delete', before, null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---- 任务 ----
app.post('/api/task', (req, res) => {
  try {
    const { name, parent_id, goal_id, kind, priority, month, start, end } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'missing name' });
    if (parent_id && !getTask(parent_id)) return res.status(400).json({ error: 'parent not found' });
    const parent = parent_id ? getTask(parent_id) : null;
    const status = (month || start || parent) ? 'planned' : 'pool';   // 生根尺度决定初始状态
    const r = db.prepare(`INSERT INTO tasks(parent_id,goal_id,name,kind,priority,status,month,start_date,end_date,sort)
      VALUES(?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+10 FROM tasks WHERE parent_id IS ?))`)
      .run(parent_id ?? null, goal_id ?? null, name.trim(),
        kind || (parent ? parent.kind : '个人成长'), priority ?? null,
        req.body.status === 'pool' ? 'pool' : status,
        month ?? null, start ?? null, end ?? null, parent_id ?? null);
    const row = getTask(Number(r.lastInsertRowid));
    audit('task', row.id, 'create', null, row);
    if (parent_id) bubbleDone(row.id);   // 给已完成的父添新子 → 父自动重开
    res.json({ ok: true, task: row });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.patch('/api/task/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const before = getTask(id);
    if (!before) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    if ('status' in b && b.status === 'done') return res.status(400).json({ error: 'use /toggle-done' });
    if ('parent_id' in b && b.parent_id != null) {
      if (Number(b.parent_id) === id || descendantIds(id).includes(Number(b.parent_id)))
        return res.status(400).json({ error: 'cycle: 不能挂到自己或自己的子孙下' });
      if (!getTask(b.parent_id)) return res.status(400).json({ error: 'parent not found' });
    }
    const allowed = ['name', 'parent_id', 'goal_id', 'kind', 'priority', 'status', 'month', 'start_date', 'end_date', 'sort', 'note'];
    const sets = [], vals = [];
    for (const k of allowed) if (k in b) { sets.push(`${k}=?`); vals.push(b[k]); }
    if (!sets.length) return res.status(400).json({ error: 'no fields' });
    tx(db, () => {
      db.prepare(`UPDATE tasks SET ${sets.join(',')} WHERE id=?`).run(...vals, id);
      if ('parent_id' in b) {   // 挂靠/独立:新旧父链都要重新冒泡
        if (before.parent_id) {
          // 旧父:还有孩子→从任一孩子冒泡(重估旧父及其祖先);没孩子了→旧父成叶子,只重估其祖先
          const remain = childrenOf(before.parent_id)[0];
          bubbleDone(remain ? remain.id : before.parent_id);
        }
        bubbleDone(id);        // 新父链
      }
    });
    const after = getTask(id);
    audit('task', id, 'update', before, after);
    res.json({ ok: true, task: after });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/task/:id/toggle-done', (req, res) => {
  try {
    const id = Number(req.params.id);
    const t = getTask(id);
    if (!t) return res.status(404).json({ error: 'not found' });
    const nowDone = t.status !== 'done';
    const ids = descendantIds(id);   // 含自身 + 全部子孙:勾父=整棵子树级联,取消=整棵重开
    const ph = ids.map(() => '?').join(',');
    tx(db, () => {
      if (nowDone) {
        db.prepare(`UPDATE tasks SET status='done', done_at=? WHERE id IN (${ph}) AND status!='archived'`).run(today(), ...ids);
      } else {
        // 重开整棵子树:各节点按自身字段回落 planned/pool(有月份/日期/父→planned,否则回池)
        db.prepare(`UPDATE tasks SET status=CASE WHEN month IS NOT NULL OR start_date IS NOT NULL OR parent_id IS NOT NULL THEN 'planned' ELSE 'pool' END, done_at=NULL WHERE id IN (${ph}) AND status!='archived'`).run(...ids);
      }
      bubbleDone(id);   // 再向上冒泡更新祖先(兄弟未完成则父保持未完成)
    });
    audit('task', id, 'toggle-done', { status: t.status }, { status: nowDone ? 'done' : 'reopen', subtree: ids.length });
    res.json({ ok: true, task: getTask(id) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.delete('/api/task/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const t = getTask(id);
    if (!t) return res.status(404).json({ error: 'not found' });
    if (req.query.hard === '1') {
      if (t.status !== 'archived') return res.status(400).json({ error: '先归档再硬删' });
      db.prepare('DELETE FROM tasks WHERE id=?').run(id);   // 子树 FK 级联删除
      audit('task', id, 'hard-delete', t, null);
      return res.json({ ok: true, hard: true });
    }
    const ids = descendantIds(id);
    tx(db, () => {
      db.prepare(`UPDATE tasks SET status='archived' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      if (t.parent_id) bubbleDone(id);
    });
    audit('task', id, 'archive', { status: t.status }, { status: 'archived', subtree: ids.length });
    res.json({ ok: true, archived: ids.length });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/task/:id/restore', (req, res) => {
  try {
    const id = Number(req.params.id);
    const t = getTask(id);
    if (!t || t.status !== 'archived' && t.status !== 'done') return res.status(400).json({ error: 'only archived/done can restore' });
    const ids = descendantIds(id);
    tx(db, () => {
      // 恢复整棵子树:有月份/日期/父 → planned,否则回池;done 的恢复为未完成
      db.prepare(`UPDATE tasks SET status=CASE WHEN month IS NOT NULL OR start_date IS NOT NULL OR parent_id IS NOT NULL THEN 'planned' ELSE 'pool' END, done_at=NULL WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      bubbleDone(id);
    });
    audit('task', id, 'restore', { status: t.status }, { subtree: ids.length });
    res.json({ ok: true, task: getTask(id) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---- 顺延(事务批量) ----
app.post('/api/rollover', (req, res) => {
  try {
    const { scope, from, to } = req.body || {};
    if (!from || !to) return res.status(400).json({ error: 'missing from/to' });
    let n = 0;
    tx(db, () => {
      if (scope === 'month') {
        const rows = db.prepare(`SELECT id FROM tasks WHERE month=? AND status='planned'`).all(from);
        db.prepare(`UPDATE tasks SET month=? WHERE month=? AND status='planned'`).run(to, from);
        n = rows.length;
        audit('task', null, 'rollover-month', { from, to }, { count: n });
      } else if (scope === 'day') {
        const rows = db.prepare(`SELECT id FROM executions WHERE date=? AND done=0`).all(from);
        db.prepare(`UPDATE executions SET date=? WHERE date=? AND done=0`).run(to, from);
        n = rows.length;
        audit('execution', null, 'rollover-day', { from, to }, { count: n });
      } else throw new Error('bad scope');
    });
    res.json({ ok: true, count: n });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---- 每日执行 ----
app.post('/api/execution', (req, res) => {
  try {
    const { task_id, text, date } = req.body || {};
    if (!date) return res.status(400).json({ error: 'missing date' });
    if (!task_id && !(text && text.trim())) return res.status(400).json({ error: 'need task_id or text' });
    if (task_id) {
      if (!getTask(task_id)) return res.status(400).json({ error: 'task not found' });
      const dup = db.prepare('SELECT id FROM executions WHERE task_id=? AND date=?').get(task_id, date);
      if (dup) return res.status(409).json({ error: 'exists', id: dup.id });
    }
    const r = db.prepare('INSERT INTO executions(task_id,text,date) VALUES(?,?,?)').run(task_id ?? null, task_id ? null : text.trim(), date);
    const row = db.prepare('SELECT e.*, t.name AS task_name FROM executions e LEFT JOIN tasks t ON t.id=e.task_id WHERE e.id=?').get(Number(r.lastInsertRowid));
    audit('execution', row.id, 'create', null, row);
    res.json({ ok: true, execution: row });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.patch('/api/execution/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const ex = db.prepare('SELECT * FROM executions WHERE id=?').get(id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    const done = req.body?.done ? 1 : 0;
    let taskToggled = false;
    tx(db, () => {
      db.prepare('UPDATE executions SET done=? WHERE id=?').run(done, id);
      // 关联叶子任务 → 联动任务完成;非叶子 → 仅打卡
      if (ex.task_id) {
        const kidCount = db.prepare(`SELECT COUNT(*) c FROM tasks WHERE parent_id=? AND status!='archived'`).get(ex.task_id).c;
        const t = getTask(ex.task_id);
        if (kidCount === 0 && t && ((done && t.status !== 'done') || (!done && t.status === 'done'))) {
          db.prepare(`UPDATE tasks SET status=?, done_at=? WHERE id=?`)
            .run(done ? 'done' : 'planned', done ? today() : null, ex.task_id);
          bubbleDone(ex.task_id);
          taskToggled = true;
        }
      }
    });
    audit('execution', id, 'toggle', { done: ex.done }, { done, taskToggled });
    res.json({ ok: true, taskToggled });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/execution/:id/promote', (req, res) => {
  try {
    const id = Number(req.params.id);
    const ex = db.prepare('SELECT * FROM executions WHERE id=?').get(id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    if (ex.task_id) return res.status(400).json({ error: 'already linked' });
    let task;
    tx(db, () => {
      const r = db.prepare(`INSERT INTO tasks(name,status,sort) VALUES(?, 'pool', (SELECT COALESCE(MAX(sort),0)+10 FROM tasks WHERE parent_id IS NULL))`).run(ex.text || '(未命名)');
      task = getTask(Number(r.lastInsertRowid));
      if (ex.done) { db.prepare(`UPDATE tasks SET status='done', done_at=? WHERE id=?`).run(today(), task.id); task = getTask(task.id); }
      db.prepare('UPDATE executions SET task_id=?, text=NULL WHERE id=?').run(task.id, id);
    });
    audit('execution', id, 'promote', ex, { task_id: task.id });
    res.json({ ok: true, task });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.delete('/api/execution/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const ex = db.prepare('SELECT * FROM executions WHERE id=?').get(id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    db.prepare('DELETE FROM executions WHERE id=?').run(id);
    audit('execution', id, 'delete', ex, null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---- 静态托管 ----
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`天罡日程 2.0 → http://localhost:${PORT}`));
}
module.exports = { app, db };
