/**
 * Shared text processing utilities: normalisation, segmentation with character
 * offsets (needed for highlighting), tokenisation, n-grams and vector maths.
 * Pure functions — usable in the browser, in Web Workers and in Node tests.
 */

export const FUNCTION_WORDS = [
  'the', 'of', 'and', 'to', 'a', 'in', 'that', 'is', 'was', 'it', 'for', 'on', 'with', 'as', 'he', 'she',
  'be', 'at', 'by', 'this', 'had', 'not', 'are', 'but', 'from', 'or', 'have', 'an', 'they', 'which',
  'one', 'you', 'were', 'all', 'we', 'her', 'his', 'there', 'been', 'if', 'more', 'when', 'will',
  'would', 'who', 'so', 'no', 'can', 'its', 'than', 'what', 'their', 'our', 'into', 'may', 'upon',
  'these', 'also', 'such', 'some', 'very', 'only', 'then', 'should', 'must', 'however', 'because',
];

export const STOPWORDS = new Set([
  ...FUNCTION_WORDS, 'i', 'me', 'my', 'him', 'them', 'us', 'your', 'do', 'does', 'did', 'has', 'about',
  'over', 'out', 'up', 'down', 'any', 'each', 'other', 'how', 'where', 'why', 'here', 'just', 'too',
  'most', 'many', 'much', 'own', 'same', 'both', 'few', 'those', 'own', 'while', 'being', 'after',
  'before', 'between', 'through', 'during', 'without', 'within', 'again', 'further', 'once', 'nor',
  'off', 'under', 'above', 'below', 'until', 'against', 'am', 'myself', 'yourself', 'itself',
]);

export const TRANSITION_WORDS = [
  'however', 'therefore', 'moreover', 'furthermore', 'consequently', 'thus', 'nevertheless', 'meanwhile',
  'additionally', 'similarly', 'likewise', 'instead', 'otherwise', 'finally', 'firstly', 'secondly',
  'overall', 'hence', 'accordingly', 'although', 'whereas', 'indeed', 'besides', 'nonetheless', 'still',
];

/** Normalise for matching: Unicode-compatible, lower-case, unified quotes/dashes, collapsed whitespace. */
export function normalize(text) {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;

/** Tokens with character offsets. */
export function tokenizeWithOffsets(text) {
  const out = [];
  for (const m of String(text).matchAll(WORD_RE)) {
    out.push({ w: m[0].toLowerCase().replace(/’/g, "'"), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function tokenize(text) {
  return tokenizeWithOffsets(text).map((t) => t.w);
}

/** Paragraphs with offsets. Blank lines separate paragraphs; if there are none, single newlines do. */
export function splitParagraphs(text) {
  const t = String(text);
  const sep = /\n\s*\n/.test(t) ? /\n\s*\n+/g : /\n+/g;
  const out = [];
  let last = 0;
  const push = (s, e) => {
    const raw = t.slice(s, e);
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (body) out.push({ text: body, start: s + lead, end: s + lead + body.length, index: out.length });
  };
  for (const m of t.matchAll(sep)) { push(last, m.index); last = m.index + m[0].length; }
  push(last, t.length);
  return out;
}

const ABBREV = /\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|fig|no|vol|pp|ch|approx|inc|ltd|co)\.$/i;

/** Sentences with offsets and the paragraph they belong to. */
export function splitSentences(text) {
  const out = [];
  for (const para of splitParagraphs(text)) {
    const p = para.text;
    let start = 0;
    const re = /[.!?]+["')\]]*(?=\s+|$)/g;
    let m;
    while ((m = re.exec(p))) {
      const end = m.index + m[0].length;
      const candidate = p.slice(start, end);
      if (ABBREV.test(candidate.trim()) || /\b[A-Z]\.$/.test(candidate.trim())) continue;
      addSentence(out, p, start, end, para);
      start = end;
    }
    if (start < p.length) addSentence(out, p, start, p.length, para);
  }
  return out;
}

function addSentence(out, p, s, e, para) {
  const raw = p.slice(s, e);
  const lead = raw.length - raw.trimStart().length;
  const body = raw.trim();
  if (!body) return;
  out.push({ text: body, start: para.start + s + lead, end: para.start + s + lead + body.length, paragraph: para.index, index: out.length });
}

/** Headings: short lines without terminal punctuation, followed by more text. */
export function detectHeadings(text) {
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 2 && l.length < 80 && !/[.!?,;:]$/.test(l) && l.split(/\s+/).length <= 10 && /^[\p{Lu}\p{N}]/u.test(l));
}

export function ngrams(tokens, n) {
  const out = [];
  for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n).join(' '));
  return out;
}

export function charNgrams(text, n = 3) {
  const t = ` ${normalize(text).replace(/[^\p{L}\p{N} ]/gu, '')} `;
  const out = new Map();
  for (let i = 0; i + n <= t.length; i++) {
    const g = t.slice(i, i + n);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

export function counts(items) {
  const m = new Map();
  for (const it of items) m.set(it, (m.get(it) || 0) + 1);
  return m;
}

export function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** |A ∩ B| / |A| — how much of A is found in B. */
export function containment(a, b) {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (!A.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / A.size;
}

export function cosineMaps(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) { na += v * v; const w = b.get(k); if (w) dot += v * w; }
  for (const v of b.values()) nb += v * v;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function cosineVec(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** TF-IDF vectors for a list of token arrays. IDF is smoothed: log((1+N)/(1+df)) + 1. */
export function tfidf(docsTokens, { removeStopwords = true } = {}) {
  const N = docsTokens.length;
  const df = new Map();
  const tfs = docsTokens.map((toks) => {
    const tf = counts(removeStopwords ? toks.filter((t) => !STOPWORDS.has(t)) : toks);
    for (const k of tf.keys()) df.set(k, (df.get(k) || 0) + 1);
    return tf;
  });
  return tfs.map((tf) => {
    const v = new Map();
    for (const [k, c] of tf) v.set(k, (1 + Math.log(c)) * (Math.log((1 + N) / (1 + df.get(k))) + 1));
    return v;
  });
}

export const mean = (xs) => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : 0);
export function std(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, c) => a + (c - m) ** 2, 0) / (xs.length - 1));
}
export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, c) => a - c);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Normalised histogram of values into fixed bins (last bin is open-ended). */
export function histogram(values, edges) {
  const h = new Array(edges.length).fill(0);
  for (const v of values) {
    let i = edges.findIndex((e) => v < e);
    if (i < 0) i = edges.length - 1;
    h[i]++;
  }
  const total = values.length || 1;
  return h.map((c) => c / total);
}

/** 1 − Jensen–Shannon divergence (base 2) between two distributions: 1 = identical. */
export function distributionSimilarity(p, q) {
  const m = p.map((v, i) => (v + q[i]) / 2);
  const kl = (a, b) => a.reduce((s, v, i) => (v > 0 && b[i] > 0 ? s + v * Math.log2(v / b[i]) : s), 0);
  return 1 - (kl(p, m) + kl(q, m)) / 2;
}

/** Longest common subsequence ratio for two sequences. */
export function lcsRatio(a, b) {
  if (!a.length || !b.length) return 0;
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return (2 * dp[b.length]) / (a.length + b.length);
}

/** Kendall rank correlation of two equal-length rank lists, mapped to [0,1]. */
export function orderAgreement(pairs) {
  if (pairs.length < 2) return null;
  let concordant = 0;
  let total = 0;
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const s = Math.sign(pairs[i][0] - pairs[j][0]) * Math.sign(pairs[i][1] - pairs[j][1]);
      if (s !== 0) { total++; if (s > 0) concordant++; }
    }
  }
  return total ? concordant / total : null;
}
