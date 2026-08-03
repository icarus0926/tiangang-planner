(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TiangangTagOrder = api;
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
