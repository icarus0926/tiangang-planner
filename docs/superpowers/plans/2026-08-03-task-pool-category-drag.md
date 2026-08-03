# Task Pool Category Drag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让任务池分类可从左侧分类区域直接整块拖动排序，并把新顺序持久化，且不破坏任务卡跨分类拖动。

**Architecture:** 保持现有 `meta.tags` JSON 数组作为分类顺序的唯一存储，不新增数据库或接口。新增一个无 DOM 依赖的纯排序助手供浏览器和 Node 测试共用；任务池把每个分类包装成 `.pool-group`，分类左侧区域发起 `tagorder` 拖动，整组容器负责插入提示和落点。

**Tech Stack:** 原生 HTML/CSS/JavaScript、CommonJS 兼容的浏览器脚本、Express 4、Node.js 22.5+、真实浏览器。

## Global Constraints

- 不新增第三方拖拽库、前端构建步骤、数据库表或 REST 路由。
- 不增加专门拖拽手柄；从分类名称所在左侧区域直接拖动。
- `其他` 始终固定最后，不能作为拖动源，但可作为“放到末尾”的落点。
- 任务卡 `pooltag` 拖拽、规划池/甘特拖拽、分类按钮和输入框行为必须保持。
- 分类排序只改 tags 数组，不改任务 `kind`、`sort`、月份、日期或父子关系。

---

### Task 1: 可测试的标签顺序算法

**Files:**
- Create: `public/tag-order.js`
- Modify: `public/index.html`（在主脚本前加载 helper）
- Modify: `test.mjs`（新增纯函数回归断言）

**Interfaces:**
- Consumes: `tags: string[]`，`source: string`，`target: string`，`before: boolean`。
- Produces: `TiangangTagOrder.reorderTags(tags, source, target, before): string[]`；Node 中通过 `module.exports` 暴露同一函数。

- [x] **Step 1: 写失败测试**

在 `test.mjs` 的 `createRequire` 后加载尚不存在的 helper，捕获缺失并用现有 `ok()` 记录失败：

```js
let reorderTags;
try { ({ reorderTags } = require('./public/tag-order.js')); } catch (_) {}
```

在认证测试之前增加三条行为断言：

```js
ok(typeof reorderTags === 'function' &&
  JSON.stringify(reorderTags(['工作','学习','投资','副业','其他'],'投资','工作',true)) ===
  JSON.stringify(['投资','工作','学习','副业','其他']), '分类排序:整块移到目标前');
ok(typeof reorderTags === 'function' &&
  JSON.stringify(reorderTags(['工作','学习','投资','副业','其他'],'工作','其他',false)) ===
  JSON.stringify(['学习','投资','副业','工作','其他']), '分类排序:拖到其他后仍停在其他前');
ok(typeof reorderTags === 'function' &&
  JSON.stringify(reorderTags(['工作','学习','其他'],'其他','工作',true)) ===
  JSON.stringify(['工作','学习','其他']), '分类排序:其他固定最后');
```

- [x] **Step 2: 运行测试并确认 RED**

Run: `npm test`

Expected: 现有 41 项通过，新加的 3 条“分类排序”失败，原因是 `reorderTags` 不存在。

- [x] **Step 3: 写最小纯函数**

创建 `public/tag-order.js`：

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TiangangTagOrder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function reorderTags(tags, source, target, before) {
    const other = '其他';
    const list = [...new Set((tags || []).filter(Boolean))];
    if (source === other || !list.includes(source) || !list.includes(target) || source === target) return list;
    const movable = list.filter(x => x !== other && x !== source);
    let index = target === other ? movable.length : movable.indexOf(target) + (before ? 0 : 1);
    if (index < 0) index = movable.length;
    movable.splice(index, 0, source);
    return list.includes(other) ? [...movable, other] : movable;
  }
  return { reorderTags };
});
```

在 `public/index.html` 的主内联脚本前添加：

```html
<script src="/tag-order.js"></script>
```

- [x] **Step 4: 运行测试并确认 GREEN**

Run: `npm test`

Expected: `44 通过, 0 失败`。

### Task 2: 分类整块拖拽 UI

**Files:**
- Modify: `public/index.html`（任务池 CSS、`renderPool()`、`bindPoolCardOps()`）

**Interfaces:**
- Consumes: `TiangangTagOrder.reorderTags()`、现有 `TAGS`、`dragged`、`mutate()`、`POST /api/tags`。
- Produces: `.pool-group[data-taggroup]`、`.pl-lab[data-tagdrag]` 和 `dragged.kind='tagorder'`。

- [x] **Step 1: 建立失败的浏览器验收**

在隔离临时库启动 8898 服务并创建“工作/学习/投资/副业”分类与示例任务。打开月度页后检查：

```js
const groups = [...document.querySelectorAll('#poolLayers [data-taggroup]')];
return {
  groupCount: groups.length,
  draggableLabels: document.querySelectorAll('#poolLayers .pl-lab[draggable="true"]').length
};
```

Expected before implementation: `groupCount === 0`、`draggableLabels === 0`，验收失败。

- [x] **Step 2: 包装完整分类块并添加视觉状态**

`renderPool()` 每个标签返回：

```html
<div class="pool-group" data-taggroup="工作">
  <div class="pool-layer">
    <div class="pl-lab" data-tagdrag="工作" draggable="true">...</div>
    <div class="pl-cards" data-tagdrop="工作">...</div>
  </div>
  <!-- 展开的子任务面板 -->
  <!-- 分类添加框 -->
</div>
```

`其他` 的 `.pl-lab` 使用 `draggable="false"`。增加 `.pool-group.tagorder-dragging`、`.tagorder-before`、`.tagorder-after` 样式，分别表达整组半透明和上下插入线；`.pl-lab[data-tagdrag]` 使用 `cursor:grab`，不显示新图标。

- [x] **Step 3: 实现相互隔离的拖放事件**

在 `bindPoolCardOps(root)` 中：

```js
root.querySelectorAll('[data-tagdrag]').forEach(label => {
  label.addEventListener('dragstart', e => {
    const tag = label.dataset.tagdrag;
    if (!tag || tag === '其他' || e.target.closest('.ab,button,input')) return e.preventDefault();
    const group = label.closest('[data-taggroup]');
    dragged = { kind: 'tagorder', tag };
    group.classList.add('tagorder-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tag);
    try { e.dataTransfer.setDragImage(group, 18, 18); } catch (_) {}
  });
  label.addEventListener('dragend', () => {
    dragged = null;
    root.querySelectorAll('.tagorder-dragging,.tagorder-before,.tagorder-after')
      .forEach(el => el.classList.remove('tagorder-dragging','tagorder-before','tagorder-after'));
  });
});
```

每个 `[data-taggroup]` 在 `dragged.kind==='tagorder'` 时接收 `dragover/drop`，以容器中线判定 `before`，调用：

```js
const next = TiangangTagOrder.reorderTags(TAGS, dragged.tag, target, before);
if (next.join('\0') !== TAGS.join('\0')) {
  mutate(() => api('POST', '/api/tags', { tags: next.filter(x => x !== '其他') }), '分类顺序已保存 ✓');
}
```

原 `[data-pdrag]` 与 `[data-tagdrop]` 事件仅识别 `pooltag`，无需改变业务逻辑。

- [x] **Step 4: 浏览器验证 GREEN**

在临时 8898 页面依次验证：

- 分类组与可拖左侧区域存在。
- 把“投资”拖到“工作”上方，完整组顺序变为 `投资,工作,学习,副业,其他`。
- 刷新后顺序保持。
- 把“工作”的一张任务卡拖到“学习”，只改变该任务标签，分类顺序不变。
- 点击分类区的 `＋/✎/×` 不触发分类拖动。
- 控制台无异常。

### Task 3: 文档、部署与提交

**Files:**
- Modify: `docs/agent/FRONTEND_GUIDE.md`
- Modify: `docs/agent/PROJECT_MEMORY.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: 已验证的分类排序行为。
- Produces: 后续 Agent 可维护的交互契约和用户说明。

- [x] **Step 1: 同步文档**

明确记录：分类左侧区域直接拖动、整组换位、顺序存入 tags 数组、“其他”固定最后、任务卡拖分类与分类排序使用不同 `dragged.kind`。

- [x] **Step 2: 完整验证**

Run:

```powershell
npm test
node --check server.js
git diff --check
```

Expected: `44 通过, 0 失败`，语法与差异检查通过；敏感信息扫描 0 命中。

- [x] **Step 3: 重启本地服务并检查**

只停止已确认命令行为 `node server.js` 的 8790 PID，再从项目目录隐藏启动新进程。检查 `GET http://127.0.0.1:8790/` 返回 200。

- [x] **Step 4: 提交并推送**

```powershell
git add public/tag-order.js public/index.html test.mjs README.md docs/agent docs/superpowers
git commit -m "支持任务池分类整块拖动排序"
git push origin main
```

提交作者必须为 `icarus0926 <kemuli0926@gmail.com>`，不得添加 Agent co-author trailer。
