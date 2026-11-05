/**
 * Every object URL S-Way creates is registered here so it can be revoked:
 * when a document is removed, when a download finishes, and when the session
 * is cleared. Unrevoked blob URLs would keep document bytes alive in memory.
 */
const urls = new Set();
let created = 0;
let revoked = 0;

export function createObjectUrl(blob) {
  const url = URL.createObjectURL(blob);
  urls.add(url);
  created++;
  return url;
}

export function revokeObjectUrl(url) {
  if (url && urls.has(url)) {
    URL.revokeObjectURL(url);
    urls.delete(url);
    revoked++;
  }
}

export function revokeAll() {
  const n = urls.size;
  for (const url of urls) URL.revokeObjectURL(url);
  revoked += n;
  urls.clear();
  return n;
}

export function blobStats() {
  return { active: urls.size, created, revoked };
}

/** Trigger a download of in-memory data and revoke the URL straight after. */
export function downloadBlob(blob, filename) {
  const url = createObjectUrl(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.replace(/[^\w.\- ]+/g, '_');
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => revokeObjectUrl(url), 1500);
}
