/**
 * In-memory session state. Nothing here is written to cookies, localStorage,
 * sessionStorage or IndexedDB. Closing or reloading the tab discards everything.
 * The only optional persistence is the opt-in report archive (core/report-store.js).
 */
import { revokeAll } from '../security/blob-registry.js';

export const session = {
  /** @type {Map<string, object>} document id → document */
  docs: new Map(),
  order: [],
  /** document id → user-confirmed signature region {x,y,w,h} in working-image pixels */
  signatureRegions: new Map(),
  report: null,
  /** Reports produced in this tab (kept in memory only, newest first, max 5). */
  history: [],
  settings: { theme: 'auto', saveReports: false, motion: 'auto' },
  lastActivity: Date.now(),
  clearedAt: null,
};

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function changed(what) {
  session.lastActivity = Date.now();
  for (const fn of listeners) { try { fn(what); } catch (err) { console.error('UI update failed'); } }
}

export const docList = () => session.order.map((id) => session.docs.get(id)).filter(Boolean);

/** The text used for analysis: the user's correction if present, else the extracted original. */
export const effectiveText = (d) => (d?.text ? (d.text.corrected ?? d.text.original) : '');

/** Drop every reference to a document's content. Byte buffers are zeroed first. */
export function wipeDocument(d) {
  if (!d) return;
  try { d.bytes?.fill?.(0); } catch { /* detached */ }
  d.bytes = null;
  for (const p of d.pages || []) {
    try { p.gray?.data?.fill?.(255); } catch { /* ignore */ }
    p.gray = null;
  }
  d.pages = [];
  d.visual = null;
  d.text = null;
}

export function removeDocument(id, revoke) {
  const d = session.docs.get(id);
  if (!d) return;
  for (const p of d.pages || []) if (p.preview) revoke(p.preview);
  if (d.thumb) revoke(d.thumb);
  wipeDocument(d);
  session.docs.delete(id);
  session.order = session.order.filter((x) => x !== id);
  session.signatureRegions.delete(id);
  changed('docs');
}

/** Clear everything held in memory for this session. Returns a summary for the user. */
export function clearSessionMemory() {
  const docs = session.docs.size;
  for (const d of session.docs.values()) wipeDocument(d);
  session.docs.clear();
  session.order = [];
  session.signatureRegions.clear();
  session.report = null;
  session.history = [];
  const urls = revokeAll();
  session.clearedAt = new Date();
  changed('cleared');
  return { docs, urls };
}
