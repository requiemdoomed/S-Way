/**
 * S-Way application bootstrap and router.
 * S-Way (SmartWay): Intelligent Document Authenticity and Authorship Analysis System
 * Author: Swayam Shakya
 */
import { $, $$, announce } from './dom.js';
import { SESSION } from './config.js';
import { session, onChange, clearSessionMemory } from './core/state.js';
import { loadCalibration } from './core/calibration.js';
import { destroyCharts } from './ui/charts.js';
import { toast } from './ui/common.js';
import { renderOverview } from './ui/overview.js';
import { renderAnalysis } from './ui/analysis.js';
import { renderCompare } from './ui/compare.js';
import { renderHandwriting } from './ui/handwriting.js';
import { renderSignature } from './ui/signature.js';
import { renderSource } from './ui/source.js';
import { renderReports } from './ui/report.js';
import { renderPrivacy, clearEverything } from './ui/privacy.js';
import { renderSettings, applyTheme, effectiveDark } from './ui/settings.js';
import { renderAbout } from './ui/about.js';
import { renderResearch } from './ui/research.js';
import { setRefresher } from './ui/bus.js';

const ROUTES = {
  overview: renderOverview,
  analysis: renderAnalysis,
  compare: renderCompare,
  handwriting: renderHandwriting,
  signature: renderSignature,
  source: renderSource,
  reports: renderReports,
  research: renderResearch,
  privacy: renderPrivacy,
  settings: renderSettings,
  about: renderAbout,
};

let current = null;

function parseRoute() {
  const m = /^#\/([a-z]+)(?:\/(.*))?$/.exec(location.hash);
  const name = m && ROUTES[m[1]] ? m[1] : 'overview';
  return { name, arg: m?.[2] ? decodeURIComponent(m[2]).slice(0, 64) : null };
}

export function render(focus = true) {
  const { name, arg } = parseRoute();
  const main = $('#view');
  destroyCharts();
  current = name;
  for (const a of $$('#nav a')) {
    if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  try {
    ROUTES[name](main, arg);
  } catch (err) {
    console.error('View failed to render');
    toast('This page could not be displayed. Try another section or clear the session.');
  }
  document.title = `${$('#nav a[aria-current="page"]')?.textContent || 'S-Way'} · S-Way`;
  if (focus) { main.focus({ preventScroll: true }); window.scrollTo({ top: 0 }); announce(`${document.title} loaded`); }
}

/** Re-render the current view when data it shows has changed (without stealing focus). */
export function refresh() {
  if (current) render(false);
}

function updateChip() {
  const n = session.order.length;
  $('#session-chip').textContent = n ? `${n} document${n === 1 ? '' : 's'} in memory` : 'No documents';
}

function setupTheme() {
  const btn = $('#theme-toggle');
  const label = () => { btn.textContent = effectiveDark() ? 'Daylight' : 'Lamplight'; };
  btn.addEventListener('click', () => {
    session.settings.theme = effectiveDark() ? 'light' : 'dark';
    applyTheme();
    label();
    if (current === 'settings') refresh();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', label);
  applyTheme();
  label();
}

function idleWatch() {
  setInterval(() => {
    if (session.order.length && Date.now() - session.lastActivity > SESSION.idleClearMs) {
      clearEverything({ silent: true }).then(() => toast('The session was idle for 30 minutes, so its documents were cleared from memory.'));
    }
  }, 60_000);
  for (const evt of ['pointerdown', 'keydown']) addEventListener(evt, () => { session.lastActivity = Date.now(); }, { passive: true });
}

function boot() {
  if (window.__SWAY_FRAMED__) return;
  addEventListener('error', () => toast('An unexpected error occurred. Your documents remain only in this tab.'));
  addEventListener('unhandledrejection', (e) => { e.preventDefault(); });
  // Drop files outside the drop zone must never navigate the tab to the file.
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => { if (!e.target.closest?.('.dropzone')) e.preventDefault(); });
  setRefresher(refresh);
  setupTheme();
  idleWatch();
  onChange((what) => {
    updateChip();
    if (what === 'cleared' || what === 'theme') refresh();
  });
  addEventListener('hashchange', () => render(true));
  updateChip();
  render(false);
  loadCalibration().then(() => { if (current === 'privacy' || current === 'about') refresh(); });
  addEventListener('pagehide', () => { clearSessionMemory(); });
}

boot();
