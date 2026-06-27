/**
 * Ingest a dataset's PDF(s) into the vector store.
 *
 *   pnpm ingest <dataset> [--pdf <file>]
 *   pnpm ingest pirate-borg
 *
 * With no --pdf it indexes every *.pdf under data/<dataset>/. Text is extracted
 * per page (so each chunk keeps its source page number for citation), chunked
 * with overlap, embedded locally, and written under the dataset's partition.
 *
 * Run via tsx (ESM) so pdfjs-dist's ESM legacy build loads cleanly; the runtime
 * bot never imports pdfjs.
 */
import fs from "fs";
import path from "path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { embedPassages } from "../src/rag/embeddings";
import { replaceDataset, type ChunkRow } from "../src/rag/store";

const MAX_CHARS = 900;
const OVERLAP = 150;
const EMBED_BATCH = 32;

interface PageText {
  page: number;
  text: string;
}

interface PdfItem {
  str: string;
  x: number; // left edge (transform[4])
  y: number; // baseline (transform[5])
  w: number; // glyph-run width
  size: number; // font size (transform[0])
}

// A line's items share a baseline within this fraction of the font size.
const LINE_TOL = 0.4;
// Insert a space between two glyph runs only when the horizontal gap exceeds
// this fraction of the font size. Tighter gaps are kerning/drop-cap splits and
// must be joined with no space ("s"+"kill" -> "skill", not "s kill").
const SPACE_GAP = 0.28;

/**
 * Reconstruct a page's text from positioned glyph runs.
 *
 * pdfjs emits items in draw order with each run mangled by drop caps and
 * kerning ("Skill Check" -> "s","kill Che","C","k"). We regroup by baseline
 * into lines, order each line left-to-right, and re-insert spaces from the
 * measured x-gaps — recovering real words and reading order.
 */
function reconstructLines(items: PdfItem[]): { y: number; size: number; text: string }[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfItem[][] = [];
  let cur: PdfItem[] = [];
  let lineY = Infinity;
  for (const it of sorted) {
    const tol = Math.max(it.size, 8) * LINE_TOL;
    if (cur.length === 0 || Math.abs(it.y - lineY) <= tol) {
      cur.push(it);
      lineY = cur.length === 1 ? it.y : lineY; // anchor to first item's baseline
    } else {
      lines.push(cur);
      cur = [it];
      lineY = it.y;
    }
  }
  if (cur.length) lines.push(cur);

  return lines.map((line) => {
    const ordered = [...line].sort((a, b) => a.x - b.x);
    let text = "";
    let prevEnd = -Infinity;
    let size = 0;
    for (const it of ordered) {
      size = Math.max(size, it.size);
      const gap = it.x - prevEnd;
      const needSpace =
        text.length > 0 &&
        !/\s$/.test(text) &&
        !/^\s/.test(it.str) &&
        gap > it.size * SPACE_GAP;
      if (needSpace) text += " ";
      text += it.str;
      prevEnd = it.x + it.w;
    }
    return { y: line[0].y, size, text };
  });
}

/**
 * Find column boundaries from vertical whitespace gutters. A real column
 * separator is empty across the *whole* page height — intra-column gaps (e.g.
 * between a roll number and its text) get filled by some other line at that x,
 * so they never show up as page-wide gutters. We mark every x covered by any
 * glyph run, then read off the wide uncovered runs as separators.
 *
 * Returns the sorted band edges, e.g. [0, gutterMid, width]; items are bucketed
 * by x-center into the bands between consecutive edges (read left-to-right).
 */
const MIN_GUTTER = 11; // px; narrower gaps are inter-word, not columns
function detectColumnEdges(items: PdfItem[], width: number): number[] {
  const W = Math.ceil(width);
  const covered = new Uint8Array(W + 1);
  for (const it of items) {
    const x0 = Math.max(0, Math.floor(it.x));
    const x1 = Math.min(W, Math.ceil(it.x + (it.w || it.size)));
    for (let x = x0; x <= x1; x++) covered[x] = 1;
  }
  const edges: number[] = [0];
  let run = 0;
  for (let x = 0; x <= W; x++) {
    if (!covered[x]) {
      run++;
    } else {
      // Close a gutter, but ignore the page's left/right margins.
      const start = x - run;
      if (run >= MIN_GUTTER && start > 30 && x < W - 30) {
        edges.push(Math.round(start + run / 2));
      }
      run = 0;
    }
  }
  edges.push(W);
  return edges;
}

/** Collapse dotted leaders and runs of whitespace introduced by extraction. */
function cleanLine(text: string): string {
  return text
    .replace(/\s*\.{3,}\s*/g, " ") // skill-table dotted leaders -> single space
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function extractPages(pdfPath: string): Promise<PageText[]> {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await getDocument({ data }).promise;
  const pages: PageText[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items: PdfItem[] = [];
    for (const raw of content.items as Array<{
      str?: string;
      width?: number;
      transform?: number[];
    }>) {
      if (typeof raw.str !== "string" || !raw.str.trim() || !raw.transform) continue;
      items.push({
        str: raw.str,
        x: raw.transform[4],
        y: raw.transform[5],
        w: raw.width ?? 0,
        size: Math.abs(raw.transform[0]) || 10,
      });
    }

    // Split into columns, reconstruct each independently, then read L-to-R so a
    // body column never interleaves with a sidebar / stat block sharing its rows.
    const edges = detectColumnEdges(items, viewport.width);
    const bands: PdfItem[][] = Array.from({ length: edges.length - 1 }, () => []);
    for (const it of items) {
      const cx = it.x + (it.w || it.size) / 2;
      let b = 0;
      while (b < edges.length - 2 && cx >= edges[b + 1]) b++;
      bands[b].push(it);
    }

    const blocks = bands
      .map((band) =>
        reconstructLines(band)
          // Drop running headers / page numbers in the top & bottom margins.
          .filter((l) => {
            const t = l.text.trim();
            const inTopMargin = l.y > viewport.height - 60;
            const inBottomMargin = l.y < 40;
            if ((inTopMargin || inBottomMargin) && /^\d{1,4}$/.test(t)) return false;
            if (inTopMargin && l.size >= 18) return false; // running title
            return true;
          })
          .map((l) => cleanLine(l.text))
          .filter((t) => t.length > 0)
          .join("\n")
      )
      .filter((b) => b.length > 0);

    pages.push({ page: p, text: blocks.join("\n\n") });
  }
  return pages;
}

/** Split one page's text into overlapping chunks, breaking on whitespace. */
function chunkPage(text: string): string[] {
  const clean = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= MAX_CHARS) return clean ? [clean] : [];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + MAX_CHARS, clean.length);
    if (end < clean.length) {
      const ws = clean.lastIndexOf(" ", end);
      if (ws > start + MAX_CHARS / 2) end = ws;
    }
    const piece = clean.slice(start, end).trim();
    if (piece.length >= 20) chunks.push(piece);
    if (end >= clean.length) break;
    start = end - OVERLAP;
  }
  return chunks;
}

async function main(): Promise<void> {
  const dataset = process.argv[2];
  if (!dataset || dataset.startsWith("--")) {
    console.error("Usage: pnpm ingest <dataset> [--pdf <file>]");
    process.exit(1);
  }

  const pdfFlagIdx = process.argv.indexOf("--pdf");
  const datasetDir = path.resolve(process.cwd(), "data", dataset);

  let pdfPaths: string[];
  if (pdfFlagIdx !== -1 && process.argv[pdfFlagIdx + 1]) {
    pdfPaths = [path.resolve(process.argv[pdfFlagIdx + 1])];
  } else {
    if (!fs.existsSync(datasetDir)) {
      console.error(`No directory data/${dataset}/ and no --pdf given.`);
      process.exit(1);
    }
    pdfPaths = fs
      .readdirSync(datasetDir)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .map((f) => path.join(datasetDir, f));
  }

  if (pdfPaths.length === 0) {
    console.error(`No PDFs found for dataset "${dataset}".`);
    process.exit(1);
  }

  // 1. Extract + chunk, keeping page numbers and source document. The source is
  // the PDF filename minus extension, so a multi-book dataset can cite
  // "(Core Rulebook, p.27)" instead of an ambiguous bare page number.
  const chunks: { page: number; source: string; text: string }[] = [];
  for (const pdfPath of pdfPaths) {
    const source = path.basename(pdfPath, path.extname(pdfPath));
    console.log(`Extracting ${path.basename(pdfPath)} ...`);
    const pages = await extractPages(pdfPath);
    for (const { page, text } of pages) {
      for (const piece of chunkPage(text)) chunks.push({ page, source, text: piece });
    }
  }
  console.log(`Got ${chunks.length} chunks. Embedding (local model) ...`);

  // 2. Embed in batches.
  const rows: ChunkRow[] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const vecs = await embedPassages(batch.map((c) => c.text));
    batch.forEach((c, j) =>
      rows.push({ page: c.page, source: c.source, text: c.text, embedding: vecs[j] })
    );
    process.stdout.write(`\r  embedded ${Math.min(i + EMBED_BATCH, chunks.length)}/${chunks.length}`);
  }
  process.stdout.write("\n");

  // 3. Write under the dataset partition.
  replaceDataset(dataset, rows);
  console.log(`Indexed ${rows.length} chunks into "${dataset}".`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
