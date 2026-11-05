/**
 * OPTIONAL, OPT-IN local report archive (disabled by default).
 *
 * When — and only when — the user enables "Save reports on this device" in Settings,
 * finished reports (findings and measurements, never the uploaded files themselves)
 * can be saved to this browser's IndexedDB. Browser storage is NOT encrypted; anyone
 * with access to this browser profile could read it. "Delete all saved reports"
 * removes the whole database.
 */
const DB = 'sway-saved-reports';
const STORE = 'reports';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('Local storage is unavailable in this browser.'));
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(out?.result ?? out); };
    t.onerror = () => { db.close(); reject(new Error('Local storage operation failed.')); };
  });
}

export async function saveReport(report) {
  const db = await open();
  return tx(db, 'readwrite', (s) => s.put({ id: report.id, savedAt: new Date().toISOString(), report }));
}

export async function listReports() {
  if (!(await exists())) return [];
  const db = await open();
  return tx(db, 'readonly', (s) => s.getAll());
}

/** Whether the archive database exists, without creating it. */
export async function exists() {
  if (!indexedDB.databases) return false;
  try { return (await indexedDB.databases()).some((d) => d.name === DB); } catch { return false; }
}

export function deleteAllReports() {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
    req.onblocked = () => resolve(false);
  });
}
