/**
 * S-Way central security & processing configuration.
 *
 * Every limit used anywhere in the application is defined here so it can be
 * reviewed and tuned in one place. Nothing in this file is secret: S-Way runs
 * entirely in the browser and has no server, API keys or credentials.
 *
 * Author: Swayam Shakya
 */

export const APP = Object.freeze({
  name: 'S-Way',
  fullName: 'SmartWay',
  title: 'S-Way (SmartWay): Intelligent Document Authenticity and Authorship Analysis System',
  tagline: 'Beyond Similarity. Into Document Intelligence.',
  author: 'Swayam Shakya',
  version: '1.1.0',
  disclaimer:
    'S-Way does not establish identity, misconduct, forgery, or plagiarism as a final determination. ' +
    'Findings require appropriate human examination.',
});

const MB = 1024 * 1024;

/** Upload limits (section 3.4 of the security specification). */
export const UPLOAD_LIMITS = Object.freeze({
  maxFileBytes: 15 * MB,
  maxFilesPerAnalysis: 10,
  maxCombinedBytes: 40 * MB,
  maxPdfPages: 50,
  maxImageWidth: 10000,
  maxImageHeight: 10000,
  /** Pixel budget guards against 10000x10000 RGBA (400 MB) decodes. */
  maxImagePixels: 40_000_000,
  maxExtractedChars: 2_000_000,
  maxDocxExpandedBytes: 100 * MB,
  maxDisplayNameLength: 120,
});

/** Archive (DOCX/ZIP) restrictions (section 3.5). */
export const ARCHIVE_LIMITS = Object.freeze({
  maxEntries: 1000,
  maxTotalUncompressed: 100 * MB,
  maxEntryUncompressed: 50 * MB,
  /** Compression ratio limit applied to entries larger than ratioCheckMinBytes. */
  maxCompressionRatio: 100,
  ratioCheckMinBytes: 64 * 1024,
  maxXmlBytesParsed: 25 * MB,
  maxNestingDepth: 1, // S-Way never opens archives found inside archives.
});

/** Processing timeouts in milliseconds (section 4.3). */
export const TIMEOUTS = Object.freeze({
  validationMs: 15_000,
  fileParseMs: 20_000,
  pdfPageRenderMs: 15_000,
  ocrPageMs: 60_000,
  textExtractionMs: 30_000,
  preprocessingMs: 15_000,
  moduleMs: 45_000,
  signatureMs: 20_000,
  reportMs: 20_000,
  /** Whole job ceiling (spec: 120 s). Extraction + analysis must finish within it. */
  jobMs: 120_000,
  queueWaitMs: 60_000,
});

/** Rendering and memory limits (sections 4.2, 4.4, 4.5). */
export const RENDER_LIMITS = Object.freeze({
  /** Longest side of a rendered PDF page / working image, in pixels. */
  maxWorkingSide: 1800,
  /** Max PDF render scale (1.0 = 72 dpi). 2.5 ≈ 180 dpi. */
  maxPdfScale: 2.5,
  /** Visual modules (handwriting/layout/signature) analyse at most this many pages per document. */
  maxVisualPagesPerDoc: 5,
  /** OCR is run on at most this many pages in a single analysis. */
  maxOcrPagesPerAnalysis: 30,
  /** OCR input longest side. */
  maxOcrSide: 2400,
  previewSide: 900,
});

/**
 * Client-side rate limits (section 2.2). S-Way has no server, so these protect the
 * user's own device from runaway or accidental repeated heavy processing. They are
 * sliding windows over the last 10 minutes and are kept in memory only.
 */
const TEN_MIN = 10 * 60 * 1000;
export const RATE_LIMITS = Object.freeze({
  analysis: { limit: 5, windowMs: TEN_MIN },
  upload: { limit: 10, windowMs: TEN_MIN },
  ocr: { limit: 10, windowMs: TEN_MIN },
  ml: { limit: 5, windowMs: TEN_MIN },
  export: { limit: 10, windowMs: TEN_MIN },
});

/** Bounded job queue (section 2.5). */
export const QUEUE_LIMITS = Object.freeze({
  maxConcurrentJobs: 1,
  maxPendingJobs: 2,
});

/** Session lifetime: in-memory data is cleared automatically after this idle period. */
export const SESSION = Object.freeze({
  idleClearMs: 30 * 60 * 1000,
});

/** Allowed formats and the MIME types the browser may legitimately declare for each. */
export const FORMATS = Object.freeze({
  pdf: { exts: ['pdf'], mimes: ['application/pdf'], label: 'PDF' },
  png: { exts: ['png'], mimes: ['image/png'], label: 'PNG image' },
  jpeg: { exts: ['jpg', 'jpeg'], mimes: ['image/jpeg', 'image/pjpeg'], label: 'JPEG image' },
  webp: { exts: ['webp'], mimes: ['image/webp'], label: 'WEBP image' },
  docx: {
    exts: ['docx'],
    mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    label: 'Word document (DOCX)',
  },
  txt: { exts: ['txt'], mimes: ['text/plain'], label: 'Plain text' },
});

/** MIME values that carry no information and are therefore not treated as a mismatch. */
export const NEUTRAL_MIMES = Object.freeze(['', 'application/octet-stream']);

export const ROLES = Object.freeze([
  { id: 'unassigned', label: 'No role assigned' },
  { id: 'reference', label: 'Reference document' },
  { id: 'examined', label: 'Document under examination' },
  { id: 'known', label: 'Known writing sample' },
  { id: 'unknown', label: 'Unknown writing sample' },
  { id: 'source', label: 'Source material' },
  { id: 'submission', label: 'Assignment submission' },
]);

export const CONTENT_TYPES = Object.freeze([
  { id: 'auto', label: 'Detect automatically' },
  { id: 'digital', label: 'Digitally typed text' },
  { id: 'printed', label: 'Printed / scanned page' },
  { id: 'handwritten', label: 'Handwritten page' },
  { id: 'signature', label: 'Signature image' },
]);

export const MODULES = Object.freeze([
  { id: 'text', label: 'Textual similarity', needs: 'text', min: 2 },
  { id: 'style', label: 'Writing-style comparison', needs: 'text', min: 2 },
  { id: 'handwriting', label: 'Handwriting feature comparison', needs: 'handwritten', min: 2 },
  { id: 'signature', label: 'Signature visual comparison', needs: 'signature', min: 2 },
  { id: 'source', label: 'Source matching', needs: 'source', min: 2 },
  { id: 'layout', label: 'Layout comparison', needs: 'visual', min: 2 },
  { id: 'anomaly', label: 'Anomaly & consistency screening', needs: 'any', min: 1 },
]);

/** Minimum evidence sizes below which results are flagged as insufficient. */
export const EVIDENCE_MINIMUMS = Object.freeze({
  textWords: 50,
  styleWords: 300,
  styleChunkWords: 100,
  ocrConfidence: 70,
  handwritingLines: 3,
  handwritingComponents: 40,
});
