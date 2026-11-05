/**
 * MODULE 4 — Stylometric Writing Analysis.
 *
 * Extracts an explainable feature vector describing *how* a text is written, then
 * compares documents feature-by-feature.
 *
 * How differences are judged: each document is split into ~100-word chunks and
 * every feature is measured per chunk. The difference between two documents is
 * compared with the natural variation of that feature *within* the documents
 * (Welch-style z score). A feature "matches" when the between-document gap is
 * small relative to the within-document variation and "differs" when it is large.
 * This avoids fixed, arbitrary tolerances and automatically becomes more cautious
 * for short or internally inconsistent texts.
 *
 * Topic words are deliberately excluded: function words, punctuation and
 * sentence structure carry style while being relatively topic-independent.
 * Genre and subject still influence style — the report says so.
 */
import {
  tokenize, splitParagraphs, splitSentences, FUNCTION_WORDS, TRANSITION_WORDS, mean, std, cosineVec,
} from './text-utils.js';

const PUNCT = [[',', 'comma'], [';', 'semicolon'], [':', 'colon'], ['!', 'exclamation'], ['?', 'question'], ['-', 'dash'], ['(', 'parenthesis'], ['"', 'quote'], ["'", 'apostrophe']];
const TOP_FUNCTION_WORDS = FUNCTION_WORDS.slice(0, 30);
const PRONOUNS = new Set(['i', 'we', 'you', 'he', 'she', 'it', 'they', 'this', 'these', 'there']);
const CONJ = new Set(['and', 'but', 'or', 'so', 'yet', 'because', 'although', 'however', 'while', 'when', 'if']);
const ARTICLES = new Set(['the', 'a', 'an']);

/** Human-readable descriptions for the report and tooltips. */
export const FEATURE_INFO = {
  avgSentenceLength: 'Average words per sentence',
  sentenceLengthSd: 'Variation in sentence length (standard deviation)',
  avgParagraphLength: 'Average sentences per paragraph',
  avgWordLength: 'Average letters per word',
  longWordRate: 'Share of words with 7+ letters',
  shortWordRate: 'Share of words with 1–3 letters',
  mattr: 'Vocabulary diversity (moving-average type–token ratio, 50-word window)',
  hapaxRate: 'Share of words used only once',
  repeatedTrigramRate: 'Share of repeated three-word phrases',
  capitalRate: 'Capital letters per letter',
  allCapsRate: 'Words written fully in capitals',
  digitRate: 'Digits per character',
  contractionRate: "Contractions per word (e.g. don't)",
  transitionRate: 'Transition words per 100 words (however, therefore…)',
  openPronoun: 'Sentences opening with a pronoun / "there"',
  openConjunction: 'Sentences opening with a conjunction or connective',
  openArticle: 'Sentences opening with an article',
  paraEndQuestion: 'Paragraphs ending in a question',
  ...Object.fromEntries(PUNCT.map(([, n]) => [`punct_${n}`, `Use of ${n} marks per 100 words`])),
  ...Object.fromEntries(TOP_FUNCTION_WORDS.map((w) => [`fw_${w}`, `Frequency of the function word "${w}" per 100 words`])),
};

export const FEATURE_GROUPS = {
  'Sentence & paragraph structure': ['avgSentenceLength', 'sentenceLengthSd', 'avgParagraphLength', 'openPronoun', 'openConjunction', 'openArticle', 'paraEndQuestion'],
  'Word choice & vocabulary': ['avgWordLength', 'longWordRate', 'shortWordRate', 'mattr', 'hapaxRate', 'repeatedTrigramRate', 'contractionRate', 'transitionRate'],
  'Punctuation & capitalisation': ['capitalRate', 'allCapsRate', 'digitRate', ...PUNCT.map(([, n]) => `punct_${n}`)],
  'Function-word profile': TOP_FUNCTION_WORDS.map((w) => `fw_${w}`),
};

function mattr(tokens, w = 50) {
  if (tokens.length <= w) return tokens.length ? new Set(tokens).size / tokens.length : 0;
  const freq = new Map();
  let distinct = 0;
  for (let i = 0; i < w; i++) { const c = freq.get(tokens[i]) || 0; if (!c) distinct++; freq.set(tokens[i], c + 1); }
  let total = distinct;
  let n = 1;
  for (let i = w; i < tokens.length; i++) {
    const out = tokens[i - w];
    const co = freq.get(out) - 1;
    freq.set(out, co);
    if (!co) distinct--;
    const ci = freq.get(tokens[i]) || 0;
    if (!ci) distinct++;
    freq.set(tokens[i], ci + 1);
    total += distinct;
    n++;
  }
  return total / n / w;
}

/** Extract the feature vector of one piece of text. */
export function extractStyleFeatures(text) {
  const t = String(text || '');
  const tokens = tokenize(t);
  const words = tokens.length || 1;
  const sentences = splitSentences(t);
  const paragraphs = splitParagraphs(t);
  const sentLens = sentences.map((s) => tokenize(s.text).length).filter((n) => n > 0);
  const letters = (t.match(/\p{L}/gu) || []).length || 1;
  const chars = t.length || 1;
  const freq = new Map();
  for (const w of tokens) freq.set(w, (freq.get(w) || 0) + 1);
  const tri = new Map();
  for (let i = 0; i + 3 <= tokens.length; i++) { const k = tokens.slice(i, i + 3).join(' '); tri.set(k, (tri.get(k) || 0) + 1); }
  let repeatedTri = 0;
  for (const c of tri.values()) if (c > 1) repeatedTri += c;
  const rawWords = t.match(/[\p{L}]+(?:['’][\p{L}]+)*/gu) || [];
  const firstWords = sentences.map((s) => tokenize(s.text)[0]).filter(Boolean);
  const nS = firstWords.length || 1;

  const f = {
    avgSentenceLength: mean(sentLens),
    sentenceLengthSd: std(sentLens),
    avgParagraphLength: paragraphs.length ? sentences.length / paragraphs.length : 0,
    avgWordLength: mean(tokens.map((w) => w.length)),
    longWordRate: tokens.filter((w) => w.length >= 7).length / words,
    shortWordRate: tokens.filter((w) => w.length <= 3).length / words,
    mattr: mattr(tokens),
    hapaxRate: [...freq.values()].filter((c) => c === 1).length / words,
    repeatedTrigramRate: tokens.length > 3 ? repeatedTri / (tokens.length - 2) : 0,
    capitalRate: (t.match(/\p{Lu}/gu) || []).length / letters,
    allCapsRate: rawWords.filter((w) => w.length > 1 && w === w.toUpperCase() && /\p{Lu}/u.test(w)).length / words,
    digitRate: (t.match(/\p{N}/gu) || []).length / chars,
    contractionRate: rawWords.filter((w) => /['’]/.test(w)).length / words,
    transitionRate: (tokens.filter((w) => TRANSITION_WORDS.includes(w)).length / words) * 100,
    openPronoun: firstWords.filter((w) => PRONOUNS.has(w)).length / nS,
    openConjunction: firstWords.filter((w) => CONJ.has(w)).length / nS,
    openArticle: firstWords.filter((w) => ARTICLES.has(w)).length / nS,
    paraEndQuestion: paragraphs.length ? paragraphs.filter((p) => /\?["')]*$/.test(p.text)).length / paragraphs.length : 0,
  };
  for (const [ch, name] of PUNCT) f[`punct_${name}`] = (t.split(ch).length - 1) / words * 100;
  for (const w of TOP_FUNCTION_WORDS) f[`fw_${w}`] = ((freq.get(w) || 0) / words) * 100;
  return { features: f, words: tokens.length, sentences: sentences.length, paragraphs: paragraphs.length };
}

/** Split text into consecutive chunks of roughly `size` words, respecting sentence boundaries. */
export function chunkText(text, size = 100) {
  const chunks = [];
  let cur = [];
  let n = 0;
  for (const s of splitSentences(text)) {
    cur.push(s.text);
    n += tokenize(s.text).length;
    if (n >= size) { chunks.push(cur.join(' ')); cur = []; n = 0; }
  }
  if (n >= size / 2) chunks.push(cur.join(' '));
  return chunks;
}

/** Per-feature mean and standard deviation over chunks. */
export function chunkProfile(text, size = 100) {
  const chunks = chunkText(text, size).map((c) => extractStyleFeatures(c).features);
  const names = Object.keys(FEATURE_INFO);
  const profile = {};
  for (const k of names) {
    const vals = chunks.map((c) => c[k]);
    profile[k] = { mean: mean(vals), sd: std(vals), n: vals.length };
  }
  return { profile, chunks: chunks.length };
}

/**
 * Compare the writing style of two texts.
 * @returns per-feature verdicts, group summaries, cosine similarity and distance on standardised vectors.
 */
export function compareStyle(A, B, { minWords = 300, chunkWords = 100 } = {}) {
  const fa = extractStyleFeatures(A.text);
  const fb = extractStyleFeatures(B.text);
  const warnings = [];
  const sufficient = fa.words >= minWords && fb.words >= minWords;
  if (!sufficient) warnings.push(`Style comparison needs at least ${minWords} words per document for meaningful results (got ${fa.words} and ${fb.words}). Treat these results as indicative only.`);
  if (!fa.words || !fb.words) return { module: 'style', pair: [A.id, B.id], status: 'insufficient', warnings: [...warnings, 'No readable text was available.'] };

  const pa = chunkProfile(A.text, chunkWords);
  const pb = chunkProfile(B.text, chunkWords);
  const usingChunks = pa.chunks >= 3 && pb.chunks >= 3;
  if (!usingChunks) warnings.push('Too little text to measure within-document variation; differences are judged against a conservative fallback scale.');

  const features = [];
  const za = [];
  const zb = [];
  for (const name of Object.keys(FEATURE_INFO)) {
    const a = fa.features[name];
    const b = fb.features[name];
    let scale;
    if (usingChunks) {
      const sa = pa.profile[name];
      const sb = pb.profile[name];
      scale = Math.sqrt((sa.sd ** 2) / sa.n + (sb.sd ** 2) / sb.n);
      // Floor: never let a perfectly constant feature turn tiny gaps into huge z scores.
      scale = Math.max(scale, 0.1 * Math.max(Math.abs(a), Math.abs(b), 1e-3), 1e-4);
    } else {
      scale = Math.max(0.25 * Math.max(Math.abs(a), Math.abs(b)), 1e-3);
    }
    const z = Math.abs(a - b) / scale;
    const pooledSd = usingChunks ? Math.max(Math.sqrt((pa.profile[name].sd ** 2 + pb.profile[name].sd ** 2) / 2), 1e-3) : scale;
    const centre = (a + b) / 2;
    za.push((a - centre) / pooledSd);
    zb.push((b - centre) / pooledSd);
    features.push({
      name, label: FEATURE_INFO[name], a: round(a), b: round(b), z: round(z),
      verdict: z < 1 ? 'match' : z < 2.5 ? 'partial' : 'differs',
    });
  }

  const groups = Object.entries(FEATURE_GROUPS).map(([group, names]) => {
    const fs = features.filter((x) => names.includes(x.name));
    return {
      group,
      match: fs.filter((x) => x.verdict === 'match').length,
      partial: fs.filter((x) => x.verdict === 'partial').length,
      differs: fs.filter((x) => x.verdict === 'differs').length,
      total: fs.length,
    };
  });

  // Similarity on raw feature vectors standardised by each feature's pooled within-document SD.
  const stdA = [];
  const stdB = [];
  features.forEach((x, i) => {
    const sd = usingChunks ? Math.max(Math.sqrt((pa.profile[x.name].sd ** 2 + pb.profile[x.name].sd ** 2) / 2), 1e-3) : 1;
    stdA.push(fa.features[x.name] / sd);
    stdB.push(fb.features[x.name] / sd);
  });
  const euclidean = Math.sqrt(za.reduce((s, v, i) => s + (v - zb[i]) ** 2, 0)) / Math.sqrt(za.length);

  const matched = features.filter((x) => x.verdict === 'match').length;
  const differs = features.filter((x) => x.verdict === 'differs').length;

  return {
    module: 'style',
    pair: [A.id, B.id],
    status: sufficient ? 'ok' : 'limited',
    words: { a: fa.words, b: fb.words },
    chunks: { a: pa.chunks, b: pb.chunks },
    usingChunkVariation: usingChunks,
    agreement: round(matched / features.length),
    disagreement: round(differs / features.length),
    cosineStandardized: round(cosineVec(stdA, stdB)),
    standardizedDistance: round(euclidean),
    features,
    groups,
    strongestMatches: [...features].sort((x, y) => x.z - y.z).slice(0, 6),
    strongestDifferences: [...features].sort((x, y) => y.z - x.z).slice(0, 6),
    warnings,
    method: 'Chunk-based Welch z-scores on 57 stylometric features; cosine similarity and Euclidean distance on standardised vectors.',
  };
}

/** Agglomerative (average-linkage) clustering of documents by style distance, for 3+ documents. */
export function clusterByStyle(docs, threshold = 0.6) {
  const n = docs.length;
  if (n < 3) return null;
  const dist = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = compareStyle(docs[i], docs[j]);
      dist[i][j] = dist[j][i] = r.disagreement ?? 1;
    }
  }
  let clusters = docs.map((d, i) => [i]);
  for (;;) {
    let best = null;
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        let s = 0;
        for (const i of clusters[a]) for (const j of clusters[b]) s += dist[i][j];
        const avg = s / (clusters[a].length * clusters[b].length);
        if (!best || avg < best.avg) best = { a, b, avg };
      }
    }
    if (!best || best.avg > threshold) break;
    clusters[best.a] = [...clusters[best.a], ...clusters[best.b]];
    clusters = clusters.filter((_, k) => k !== best.b);
  }
  return { clusters: clusters.map((c) => c.map((i) => docs[i].id)), distance: dist, threshold, measure: 'Share of stylometric features that differ (z ≥ 2.5)' };
}

function round(x, d = 4) {
  return Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null;
}
