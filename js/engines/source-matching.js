/**
 * MODULE 7 — Source and Plagiarism Investigation.
 *
 * Matches each examined document against the source/reference documents the user
 * supplied in this session (no internet search is performed — S-Way makes no
 * network requests). For every match it reports the passage, the source document,
 * page/paragraph references, the method and a score.
 */
import { compareTexts } from './text-similarity.js';
import { tokenizeWithOffsets } from './text-utils.js';

/** Map a character offset to a 1-based page number using page start offsets. */
export function pageOf(offset, pageStarts = [0]) {
  let p = 0;
  for (let i = 0; i < pageStarts.length; i++) if (offset >= pageStarts[i]) p = i;
  return p + 1;
}

/**
 * @param {Array<{id,name,text,pageStarts}>} examined
 * @param {Array<{id,name,text,pageStarts}>} sources
 */
export function investigateSources(examined, sources, thresholds) {
  const results = [];
  for (const ex of examined) {
    const words = tokenizeWithOffsets(ex.text);
    const covered = new Uint8Array(ex.text.length);
    const perSource = [];
    for (const src of sources) {
      if (src.id === ex.id) continue;
      const cmp = compareTexts({ id: ex.id, text: ex.text }, { id: src.id, text: src.text }, thresholds);
      if (cmp.status === 'insufficient') continue;
      const matches = [];
      for (const p of cmp.passages) {
        covered.fill(1, p.a.start, p.a.end);
        matches.push({
          method: 'Exact shared passage',
          score: 1,
          words: p.words,
          examined: { start: p.a.start, end: p.a.end, page: pageOf(p.a.start, ex.pageStarts) },
          source: { start: p.b.start, end: p.b.end, page: pageOf(p.b.start, src.pageStarts) },
        });
      }
      for (const m of cmp.sentenceMatches) {
        if (m.category === 'exact') continue; // already represented by shared passages
        const overlapsPassage = cmp.passages.some((p) => m.a.start < p.a.end && m.a.end > p.a.start);
        if (overlapsPassage) continue;
        if (m.category === 'near_identical') covered.fill(1, m.a.start, m.a.end);
        matches.push({
          method: m.category === 'near_identical' ? 'Near-identical sentence (character-trigram similarity)' : 'Possible paraphrase (lexical overlap)',
          score: m.charScore,
          examined: { start: m.a.start, end: m.a.end, page: pageOf(m.a.start, ex.pageStarts), paragraph: m.a.paragraph + 1 },
          source: { start: m.b.start, end: m.b.end, page: pageOf(m.b.start, src.pageStarts), paragraph: m.b.paragraph + 1 },
        });
      }
      matches.sort((a, b) => a.examined.start - b.examined.start);
      perSource.push({
        sourceId: src.id,
        sourceName: src.name,
        sharedPassageCoverage: cmp.metrics.sharedPassageCoverageA,
        paraphraseRate: cmp.metrics.paraphraseRateA,
        orderAgreement: cmp.metrics.matchedOrderAgreement,
        matchCount: matches.length,
        matches: matches.slice(0, 200),
      });
    }
    let coveredWords = 0;
    for (const w of words) if (covered[w.start]) coveredWords++;
    perSource.sort((a, b) => b.sharedPassageCoverage - a.sharedPassageCoverage || b.matchCount - a.matchCount);
    results.push({
      examinedId: ex.id,
      examinedName: ex.name,
      words: words.length,
      combinedCoverage: words.length ? Math.round((coveredWords / words.length) * 10000) / 10000 : 0,
      sources: perSource,
    });
  }
  return {
    module: 'source',
    scope: `Compared against ${sources.length} document(s) supplied in this session. No internet or external database was searched.`,
    results,
  };
}
