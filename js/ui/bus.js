/** Tiny indirection so views can ask the router to re-render without importing app.js (avoids import cycles). */
let refresher = () => {};
export function setRefresher(fn) { refresher = fn; }
export function refreshView() { refresher(); }
