/**
 * Safe DOM construction helpers.
 *
 * S-Way never assigns untrusted data to innerHTML/outerHTML/insertAdjacentHTML.
 * All text (filenames, OCR output, extracted document text, metadata) is inserted
 * with textContent via these helpers. Event handlers are attached as functions,
 * never as attribute strings, so a CSP without 'unsafe-inline' keeps working.
 */

const BLOCKED_PROPS = new Set(['innerHTML', 'outerHTML', 'srcdoc']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href']);
const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'path', 'g', 'circle', 'rect', 'line', 'polyline', 'text', 'title', 'defs', 'pattern', 'use']);

/** Only same-document fragments, relative paths, blob: and data:image URLs may be used. */
export function isSafeUrl(value) {
  const v = String(value).trim();
  if (v.startsWith('#')) return true;
  if (/^blob:/i.test(v)) return true;
  if (/^data:image\/(png|jpeg|webp);base64,/i.test(v)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return false; // any other scheme (javascript:, http:, etc.)
  return !v.startsWith('//');
}

/**
 * Create an element.
 * @param {string} tag
 * @param {object} [props] class, text, attrs, dataset, on: {event: fn}, style: {prop: value}
 * @param {...(Node|string|number|null|false|Array)} children
 */
export function h(tag, props = {}, ...children) {
  const isSvg = SVG_TAGS.has(tag);
  const el = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (BLOCKED_PROPS.has(key)) throw new Error(`Unsafe property ${key}`);
    if (key === 'class') {
      if (isSvg) el.setAttribute('class', value);
      else el.className = value;
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (key === 'on') {
      for (const [evt, fn] of Object.entries(value)) el.addEventListener(evt, fn);
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) el.dataset[k] = String(v);
    } else if (key === 'style') {
      for (const [k, v] of Object.entries(value)) el.style.setProperty(k, String(v));
    } else if (key === 'attrs') {
      for (const [k, v] of Object.entries(value)) setAttr(el, k, v);
    } else {
      setAttr(el, key, value);
    }
  }
  append(el, children);
  return el;
}

function setAttr(el, name, value) {
  const lower = name.toLowerCase();
  if (lower.startsWith('on')) throw new Error('Inline event handler attributes are not allowed');
  if (URL_ATTRS.has(lower) && !isSafeUrl(value)) throw new Error(`Unsafe URL for ${name}`);
  if (value === true) el.setAttribute(name, '');
  else el.setAttribute(name, String(value));
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Remove all children (used instead of innerHTML = ''). */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  return append(el, children);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Accessible live announcements for screen readers. */
export function announce(message) {
  const region = document.getElementById('sr-live');
  if (region) {
    region.textContent = '';
    requestAnimationFrame(() => { region.textContent = message; });
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function pct(x, digits = 0) {
  return Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : '—';
}

export function num(x, digits = 2) {
  return Number.isFinite(x) ? x.toFixed(digits) : '—';
}
