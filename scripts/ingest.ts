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

async function extractPages(pdfPath: string): Promise<PageText[]> {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await getDocument({ data, isEvalSupported: false }).promise;
  const pages: PageText[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
      if (typeof item.str !== "string") continue;
      text += item.str;
      text += item.hasEOL ? "\n" : " ";
    }
    pages.push({ page: p, text });
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

  // 1. Extract + chunk, keeping page numbers.
  const chunks: { page: number; text: string }[] = [];
  for (const pdfPath of pdfPaths) {
    console.log(`Extracting ${path.basename(pdfPath)} ...`);
    const pages = await extractPages(pdfPath);
    for (const { page, text } of pages) {
      for (const piece of chunkPage(text)) chunks.push({ page, text: piece });
    }
  }
  console.log(`Got ${chunks.length} chunks. Embedding (local model) ...`);

  // 2. Embed in batches.
  const rows: ChunkRow[] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const vecs = await embedPassages(batch.map((c) => c.text));
    batch.forEach((c, j) => rows.push({ page: c.page, text: c.text, embedding: vecs[j] }));
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
