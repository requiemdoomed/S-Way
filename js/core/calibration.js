/**
 * Trusted model/calibration registry.
 *
 * S-Way ships no downloadable neural models. Its only "model artifact" is
 * models/calibration.json — thresholds and variability scales produced by the
 * research notebook. It is loaded from this site only, and its SHA-256 digest
 * must match the entry in models/model_manifest.json. If anything is missing or
 * does not match, built-in defaults are used and the Privacy Center says so.
 * Documents can never cause other files or URLs to be loaded.
 */
import { DEFAULT_TEXT_THRESHOLDS } from '../engines/text-similarity.js';
import { DEFAULT_HANDWRITING_SCALES } from '../engines/handwriting.js';
import { DEFAULT_FUSION_THRESHOLDS } from './fusion.js';

export const calibration = {
  source: 'built-in defaults',
  verified: false,
  text: { ...DEFAULT_TEXT_THRESHOLDS },
  handwritingScales: { ...DEFAULT_HANDWRITING_SCALES },
  fusion: structuredClone(DEFAULT_FUSION_THRESHOLDS),
  info: null,
};

async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function loadCalibration() {
  try {
    const [mRes, cRes] = await Promise.all([
      fetch('models/model_manifest.json', { cache: 'no-store', credentials: 'omit' }),
      fetch('models/calibration.json', { cache: 'no-store', credentials: 'omit' }),
    ]);
    if (!mRes.ok || !cRes.ok) throw new Error('missing');
    const manifest = await mRes.json();
    const buf = await cRes.arrayBuffer();
    const entry = manifest.artifacts?.find((a) => a.file === 'calibration.json');
    if (!entry) throw new Error('not registered');
    const digest = await sha256Hex(buf);
    if (digest !== entry.sha256) throw new Error('digest mismatch');
    const data = JSON.parse(new TextDecoder().decode(buf));
    const num = (v) => typeof v === 'number' && Number.isFinite(v);
    for (const [k, v] of Object.entries(data.text || {})) if (k in calibration.text && num(v)) calibration.text[k] = v;
    for (const [k, v] of Object.entries(data.handwritingScales || {})) if (k in calibration.handwritingScales && num(v) && v >= 0) calibration.handwritingScales[k] = v;
    for (const [group, obj] of Object.entries(data.fusion || {})) {
      if (!calibration.fusion[group]) continue;
      for (const [k, v] of Object.entries(obj)) if (k in calibration.fusion[group] && num(v)) calibration.fusion[group][k] = v;
    }
    calibration.source = `models/calibration.json (${data.generated || 'undated'})`;
    calibration.verified = true;
    calibration.info = { generated: data.generated, notes: data.notes, digest };
  } catch (err) {
    calibration.source = `built-in defaults (calibration file ${err.message === 'digest mismatch' ? 'failed its integrity check' : 'unavailable'})`;
    calibration.verified = false;
  }
  return calibration;
}
