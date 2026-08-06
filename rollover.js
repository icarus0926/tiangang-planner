const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const DAY_MS = 864e5;

const asDate = s => new Date(`${s}T00:00:00Z`);
const iso = d => d.toISOString().slice(0, 10);
const isIsoDate = s => typeof s === 'string' && DATE_RE.test(s) &&
  !Number.isNaN(asDate(s).getTime()) && iso(asDate(s)) === s;
const isIsoMonth = s => typeof s === 'string' && MONTH_RE.test(s) &&
  +s.slice(5, 7) >= 1 && +s.slice(5, 7) <= 12;

function addDaysIso(s, n) {
  const d = asDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

function dayDiffIso(a, b) {
  return Math.round((asDate(b) - asDate(a)) / DAY_MS);
}

function mondayOfIso(s) {
  const d = asDate(s);
  return addDaysIso(s, -((d.getUTCDay() + 6) % 7));
}

function validateTarget(scope, to) {
  if (scope === 'month') return isIsoMonth(to);
  if (!isIsoDate(to)) return false;
  return scope === 'day' || (scope === 'week' && mondayOfIso(to) === to);
}

function monthAnchorDelta(anchorDate, targetMonth) {
  const day = +anchorDate.slice(8, 10);
  const [year, month] = targetMonth.split('-').map(Number);
  const max = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return dayDiffIso(anchorDate, `${targetMonth}-${String(Math.min(day, max)).padStart(2, '0')}`);
}

function selectPastRoots(tasks, scope, to) {
  if (!validateTarget(scope, to) || !['week', 'month'].includes(scope)) return [];

  const ordered = [];
  const byId = new Map();
  const indices = new Map();
  for (const [index, task] of tasks.entries()) {
    if (!task || task.id == null || byId.has(task.id)) continue;
    ordered.push(task);
    byId.set(task.id, task);
    indices.set(task.id, index);
  }

  const compare = (a, b) => {
    const aSort = a.sort != null && Number.isFinite(Number(a.sort)) ? Number(a.sort) : Number(a.id);
    const bSort = b.sort != null && Number.isFinite(Number(b.sort)) ? Number(b.sort) : Number(b.id);
    return aSort - bSort || Number(a.id) - Number(b.id) ||
      indices.get(a.id) - indices.get(b.id);
  };
  const isOpen = task => task.status !== 'done' && task.status !== 'archived';
  const targetMonth = scope === 'month' ? to : to.slice(0, 7);
  const targetEnd = scope === 'week' ? addDaysIso(to, 6) : null;
  const isPast = task => {
    if (scope === 'month' && hasCurrentWindowDate(task)) return false;
    const endIsPast = isIsoDate(task.end_date) && task.end_date < (scope === 'week' ? to : `${to}-01`);
    return scope === 'week'
      ? endIsPast
      : (isIsoMonth(task.month) && task.month < to) || endIsPast;
  };
  const hasCurrentWindowDate = task => isIsoDate(task.start_date) && isIsoDate(task.end_date) &&
    task.start_date <= (scope === 'week' ? targetEnd : `${to}-31`) &&
    task.end_date >= (scope === 'week' ? to : `${to}-01`);
  const isUndatedUnmonth = task => !task.month && !task.start_date && !task.end_date;
  const rootFor = task => {
    let root = task;
    let parent = byId.get(root.parent_id);
    while (parent && isOpen(parent)) {
      if (isUndatedUnmonth(parent) || isPast(parent)) {
        root = parent;
        parent = byId.get(root.parent_id);
        continue;
      }
      if ((isIsoMonth(parent.month) && parent.month >= targetMonth) || hasCurrentWindowDate(parent)) break;
      break;
    }
    return root;
  };

  const groups = new Map();
  for (const task of ordered) {
    if (!isOpen(task) || !isPast(task)) continue;
    const root = rootFor(task);
    if (!groups.has(root.id)) groups.set(root.id, { root, nodes: new Map() });
    groups.get(root.id).nodes.set(task.id, task);
  }

  return [...groups.values()].map(group => {
    const nodes = [...group.nodes.values()].sort(compare);
    const scheduled = nodes
      .map(task => isIsoDate(task.start_date) ? task.start_date : (isIsoDate(task.end_date) ? task.end_date : null))
      .filter(Boolean)
      .sort()[0];
    const origins = nodes.map(task => {
      if (scope === 'week') return isIsoDate(task.start_date) ? task.start_date : task.end_date;
      if (isIsoMonth(task.month) && task.month < to) return task.month;
      const date = isIsoDate(task.start_date) ? task.start_date : task.end_date;
      return date ? date.slice(0, 7) : null;
    }).filter(Boolean).sort();
    const origin = scope === 'week' ? mondayOfIso(scheduled) : origins[0];
    return {
      root: group.root,
      nodes,
      origin,
      deltaDays: scope === 'week'
        ? dayDiffIso(origin, to)
        : (scheduled ? monthAnchorDelta(scheduled, to) : 0)
    };
  }).sort((a, b) => compare(a.root, b.root));
}

module.exports = { validateTarget, mondayOfIso, addDaysIso, dayDiffIso, monthAnchorDelta, selectPastRoots };
