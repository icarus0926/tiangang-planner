// 一次性:从 Notion 全量拉取旧系统数据 → snapshot.json 永久留档
// 凭据读老项目 ../sync-server/.env;需要本机代理(Nano)在运行
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const envText = fs.readFileSync(path.join(HERE, '../../sync-server/.env'), 'utf8');
const env = Object.fromEntries(envText.split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).split('#')[0].trim()]));

const H = { 'Authorization': `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
const DBS = {
  goals: env.DB_GOALS, growthPool: env.DB_GROWTH_POOL, workPool: env.DB_WORK_POOL,
  monthly: env.DB_MONTHLY, weekly: env.DB_WEEKLY, daily: env.DB_DAILY,
};

async function queryAll(dbId) {
  let results = [], cursor;
  do {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST', headers: H, body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }),
    });
    if (!r.ok) throw new Error(`query ${dbId}: ${r.status} ${await r.text()}`);
    const j = await r.json();
    results = results.concat(j.results);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return results;
}
async function listTodos(pageId) {
  let results = [], cursor;
  do {
    const url = `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100` + (cursor ? `&start_cursor=${cursor}` : '');
    const r = await fetch(url, { headers: H });
    if (!r.ok) throw new Error(`blocks ${pageId}: ${r.status}`);
    const j = await r.json();
    results = results.concat(j.results);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return results.filter(b => b.type === 'to_do').map(b => ({
    id: b.id,
    text: (b.to_do.rich_text || []).map(t => t.plain_text).join(''),
    checked: !!b.to_do.checked,
  }));
}

const snap = { fetched_at: new Date().toISOString(), dbs: {}, steps: {} };
for (const [key, id] of Object.entries(DBS)) {
  snap.dbs[key] = await queryAll(id);
  console.log(`${key}: ${snap.dbs[key].length} 行`);
}
// 步骤块:月度页 + 周任务页(独立周任务可能有步骤)
const hostPages = [...snap.dbs.monthly.map(p => p.id), ...snap.dbs.weekly.map(p => p.id)];
for (const pid of hostPages) {
  const todos = await listTodos(pid);
  if (todos.length) { snap.steps[pid] = todos; }
}
console.log(`步骤宿主页: ${Object.keys(snap.steps).length} 个,共 ${Object.values(snap.steps).flat().length} 条步骤`);

const out = path.join(HERE, 'snapshot.json');
fs.writeFileSync(out, JSON.stringify(snap, null, 1));
console.log(`已存 ${out} (${Math.round(fs.statSync(out).size / 1024)}KB)`);
