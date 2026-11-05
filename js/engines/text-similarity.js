/**
 * MODULE 3 — Text Similarity Engine.
 *
 * Compares two texts with several independent techniques and keeps each result
 * separate. Character offsets are returned for every match so the interface can
 * highlight the evidence in both documents.
 *
 *   Exact:      whole document, paragraph, sentence, shared word passages (≥ 8 words)
 *   Lexical:    token Jaccard, word 3-gram Jaccard, 5-gram containment, TF-IDF cosine
 *   Fuzzy:      character-trigram cosine per sentence → near-identical / possible paraphrase
 *   Structural: sentence/paragraph length distributions, heading sequence, paragraph order
 *
 * LIMITATION (stated in the report): "possible paraphrase" is detected from lexical
 * and character overlap. Paraphrases that change most of the wording (synonyms,
 * restructured sentences) can be missed. No neural sentence-embedding model is
 * bundled, because S-Way runs fully offline in the browser.
 */
import {
  normalize, tokenize, tokenizeWithOffsets, splitParagraphs, splitSentences, detectHeadings,
  ngrams, charNgrams, jaccard, containment, cosineMaps, tfidf, histogram, distributionSimilarity,
  lcsRatio, orderAgreement, STOPWORDS,
} from './text-utils.js';

export const DEFAULT_TEXT_THRESHOLDS = Object.freeze({
  passageMinWords: 8,
  sentenceMinWords: 5,
  nearIdentical: 0.85,
  paraphraseChar: 0.55,
  paraphraseCharWithWords: 0.45,
  paraphraseWordJaccard: 0.35,
  unique: 0.3,
});

const SENT_EDGES = [5, 10, 15, 20, 25, 30, 40, Infinity];
const PARA_EDGES = [20, 40, 60, 90, 130, 180, 250, Infinity];
const MAX_PASSAGES = 400;
const MAX_SENTENCE_FINDINGS = 300;

/** Find maximal shared word runs of at least minWords tokens. */
export function sharedPassages(textA, textB, minWords = 8) {
  const ta = tokenizeWithOffsets(textA);
  const tb = tokenizeWithOffsets(textB);
  const wa = ta.map((t) => t.w);
  const wb = tb.map((t) => t.w);
  if (wa.length < minWords || wb.length < minWords) return { passages: [], coveredA: 0, coveredB: 0, wordsA: wa.length, wordsB: wb.length };

  const index = new Map();
  for (let j = 0; j + minWords <= wb.length; j++) {
    const key = wb.slice(j, j + minWords).join(' ');
    const list = index.get(key);
    if (list) { if (list.length < 50) list.push(j); } else index.set(key, [j]);
  }
  const passages = [];
  const coveredA = new Uint8Array(wa.length);
  const coveredB = new Uint8Array(wb.length);
  let i = 0;
  while (i + minWords <= wa.length && passages.length < MAX_PASSAGES) {
    const cands = index.get(wa.slice(i, i + minWords).join(' '));
    if (!cands) { i++; continue; }
    let best = 0;
    let bestJ = -1;
    for (const j of cands) {
      let len = minWords;
      while (i + len < wa.length && j + len < wb.length && wa[i + len] === wb[j + len]) len++;
      if (len > best) { best = len; bestJ = j; }
    }
    passages.push({
      words: best,
      a: { start: ta[i].start, end: ta[i + best - 1].end, tokenStart: i },
      b: { start: tb[bestJ].start, end: tb[bestJ + best - 1].end, tokenStart: bestJ },
    });
    coveredA.fill(1, i, i + best);
    coveredB.fill(1, bestJ, bestJ + best);
    i += best;
  }
  const sum = (arr) => arr.reduce((s, v) => s + v, 0);
  return { passages, coveredA: sum(coveredA) / wa.length, coveredB: sum(coveredB) / wb.length, wordsA: wa.length, wordsB: wb.length };
}

const contentWords = (text) => tokenize(text).filter((w) => !STOPWORDS.has(w) && w.length > 2);

/** Align sentences of A to their most similar sentence in B. */
export function alignSentences(sentA, sentB, th = DEFAULT_TEXT_THRESHOLDS) {
  const prepB = sentB.map((s) => ({ s, words: tokenize(s.text), cw: new Set(contentWords(s.text)), cg: null }));
  const inverted = new Map();
  prepB.forEach((p, j) => { for (const w of p.cw) { if (!inverted.has(w)) inverted.set(w, []); inverted.get(w).push(j); } });

  const results = [];
  for (const sa of sentA) {
    const words = tokenize(sa.text);
    if (words.length < th.sentenceMinWords) { results.push({ a: sa, best: null, score: 0 }); continue; }
    const cw = new Set(contentWords(sa.text));
    const shared = new Map();
    for (const w of cw) for (const j of inverted.get(w) || []) shared.set(j, (shared.get(j) || 0) + 1);
    const cands = [...shared.entries()].sort((x, y) => y[1] - x[1]).slice(0, 25).map(([j]) => j);
    const cgA = charNgrams(sa.text, 3);
    const normA = words.join(' ');
    let best = null;
    for (const j of cands) {
      const pb = prepB[j];
      if (pb.words.length < th.sentenceMinWords) continue;
      pb.cg ??= charNgrams(pb.s.text, 3);
      const exact = normA === pb.words.join(' ');
      const charScore = exact ? 1 : cosineMaps(cgA, pb.cg);
      const wordScore = jaccard(cw, pb.cw);
      const score = Math.max(charScore, wordScore);
      if (!best || score > best.score) best = { b: pb.s, charScore, wordScore, score, exact };
    }
    results.push({ a: sa, best, score: best ? best.score : 0 });
  }
  return results;
}

export function categorize(m, th = DEFAULT_TEXT_THRESHOLDS) {
  if (!m) return 'none';
  if (m.exact) return 'exact';
  if (m.charScore >= th.nearIdentical) return 'near_identical';
  if (m.charScore >= th.paraphraseChar || (m.charScore >= th.paraphraseCharWithWords && m.wordScore >= th.paraphraseWordJaccard)) return 'possible_paraphrase';
  return 'none';
}

const span = (s) => ({ index: s.index, paragraph: s.paragraph, start: s.start, end: s.end });

/**
 * Compare two documents.
 * @param {{id:string,text:string}} A
 * @param {{id:string,text:string}} B
 */
export function compareTexts(A, B, thresholds = DEFAULT_TEXT_THRESHOLDS, minWords = 50) {
  const th = { ...DEFAULT_TEXT_THRESHOLDS, ...thresholds };
  const ta = String(A.text || '');
  const tb = String(B.text || '');
  const tokA = tokenize(ta);
  const tokB = tokenize(tb);
  const warnings = [];
  if (tokA.length < minWords || tokB.length < minWords) {
    warnings.push(`At least one document has fewer than ${minWords} words; textual similarity measures are unreliable on very short texts.`);
  }
  if (!tokA.length || !tokB.length) {
    return { module: 'text', pair: [A.id, B.id], status: 'insufficient', warnings: [...warnings, 'No readable text was available for comparison.'], words: { a: tokA.length, b: tokB.length } };
  }

  const exactDocument = normalize(ta) === normalize(tb);

  const parasA = splitParagraphs(ta);
  const parasB = splitParagraphs(tb);
  const paraKeyB = new Map(parasB.map((p) => [tokenize(p.text).join(' '), p]));
  const exactParagraphs = [];
  for (const p of parasA) {
    const key = tokenize(p.text).join(' ');
    if (key.split(' ').length >= th.sentenceMinWords && paraKeyB.has(key)) {
      const q = paraKeyB.get(key);
      exactParagraphs.push({ a: { index: p.index, start: p.start, end: p.end }, b: { index: q.index, start: q.start, end: q.end } });
    }
  }

  const sentA = splitSentences(ta);
  const sentB = splitSentences(tb);
  const alignAB = alignSentences(sentA, sentB, th);
  const alignBA = alignSentences(sentB, sentA, th);

  const sentenceMatches = [];
  const counts = { exact: 0, near_identical: 0, possible_paraphrase: 0 };
  for (const r of alignAB) {
    const cat = categorize(r.best, th);
    if (cat === 'none') continue;
    counts[cat]++;
    if (sentenceMatches.length < MAX_SENTENCE_FINDINGS) {
      sentenceMatches.push({
        category: cat,
        a: span(r.a),
        b: span(r.best.b),
        charScore: round(r.best.charScore),
        wordScore: round(r.best.wordScore),
      });
    }
  }
  const eligibleA = alignAB.filter((r) => tokenize(r.a.text).length >= th.sentenceMinWords).length || 1;

  const shared = sharedPassages(ta, tb, th.passageMinWords);
  const uniqueA = alignAB.filter((r) => r.score < th.unique && tokenize(r.a.text).length >= th.sentenceMinWords).map((r) => span(r.a));
  const uniqueB = alignBA.filter((r) => r.score < th.unique && tokenize(r.a.text).length >= th.sentenceMinWords).map((r) => span(r.a));

  const [vA, vB] = tfidf([tokA, tokB]);
  const g3A = new Set(ngrams(tokA, 3));
  const g3B = new Set(ngrams(tokB, 3));
  const g5A = new Set(ngrams(tokA, 5));
  const g5B = new Set(ngrams(tokB, 5));

  const sentLen = (ss) => ss.map((s) => tokenize(s.text).length).filter((n) => n > 0);
  const paraLen = (ps) => ps.map((p) => tokenize(p.text).length).filter((n) => n > 0);
  const headA = detectHeadings(ta).map(normalize);
  const headB = detectHeadings(tb).map(normalize);
  const orderPairs = sentenceMatches.filter((m) => m.category !== 'possible_paraphrase' || m.charScore > 0.6).map((m) => [m.a.index, m.b.index]);

  const metrics = {
    exactDocument,
    tokenJaccard: round(jaccard(new Set(tokA.filter((w) => !STOPWORDS.has(w))), new Set(tokB.filter((w) => !STOPWORDS.has(w))))),
    tfidfCosine: round(cosineMaps(vA, vB)),
    ngram3Jaccard: round(jaccard(g3A, g3B)),
    ngram5ContainmentAinB: round(containment(g5A, g5B)),
    ngram5ContainmentBinA: round(containment(g5B, g5A)),
    charTrigramCosine: round(cosineMaps(charNgrams(ta, 3), charNgrams(tb, 3))),
    sharedPassageCoverageA: round(shared.coveredA),
    sharedPassageCoverageB: round(shared.coveredB),
    sentenceMatchRateA: round((counts.exact + counts.near_identical) / eligibleA),
    paraphraseRateA: round(counts.possible_paraphrase / eligibleA),
    sentenceLengthSimilarity: round(distributionSimilarity(histogram(sentLen(sentA), SENT_EDGES), histogram(sentLen(sentB), SENT_EDGES))),
    paragraphLengthSimilarity: round(distributionSimilarity(histogram(paraLen(parasA), PARA_EDGES), histogram(paraLen(parasB), PARA_EDGES))),
    headingSequenceSimilarity: headA.length && headB.length ? round(lcsRatio(headA, headB)) : null,
    matchedOrderAgreement: orderAgreement(orderPairs) === null ? null : round(orderAgreement(orderPairs)),
  };

  const review = sentenceMatches
    .filter((m) => m.category === 'possible_paraphrase' || m.category === 'near_identical')
    .slice(0, 40)
    .map((m) => ({ ...m, reason: m.category === 'near_identical' ? 'Almost identical wording — check for minor edits.' : 'Overlapping wording — may be a paraphrase or a common phrasing; read both sentences.' }));

  return {
    module: 'text',
    pair: [A.id, B.id],
    status: warnings.length ? 'limited' : 'ok',
    words: { a: tokA.length, b: tokB.length },
    sentences: { a: sentA.length, b: sentB.length },
    metrics,
    counts,
    exactParagraphs,
    passages: shared.passages,
    sentenceMatches,
    uniqueA: uniqueA.slice(0, 200),
    uniqueB: uniqueB.slice(0, 200),
    review,
    warnings,
    method: 'Exact matching, word n-grams, TF-IDF cosine, character-trigram cosine sentence alignment, structural distributions.',
  };
}

function round(x, d = 4) {
  return Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null;
}
