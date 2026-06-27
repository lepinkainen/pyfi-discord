# Vision-LLM PDF ingestion (option, not yet implemented)

A future quality-ceiling path for the RAG ingest pipeline (`scripts/ingest.ts`). The
current pipeline extracts text with **pdfjs-dist** + a heuristic layout pass
(column-banding, line reconstruction, dotted-leader/header cleanup — see
`scripts/ingest.ts`). That handles the bulk of a rulebook (flowing body text,
2-column skill/lore pages) well, but **dense 3-zone pages** — a center stat block
or sidebar sharing horizontal bands with the body column — defeat whole-page
gutter detection and still extract as interleaved text. Tables/stat blocks are the
weak spot.

Vision-LLM ingestion is the way to nail those: render each page to an image, ask
Claude to return clean markdown (reading order, tables as markdown tables), and
store that instead of the heuristic text extraction. Runtime stays 100% local —
this is an **ingest-time, one-time** cost; the result lives in `data/rag.db`
forever.

## When to reach for it

Only if, after re-ingesting with the heuristic pass, the genuinely hard pages
(stat blocks, multi-column roll/skill tables) still retrieve badly. The heuristic
pass is free and already covers the common case. Don't pay for vision until a
spot-check shows it's needed.

## Cost estimate (one-time)

Target book: **Cyberpunk Red**, 458 pages, clean text PDF (no OCR/scan — but we'd
rasterize anyway to let the model see layout).

Per page:
- **Input:** page image ~1,600 tok (standard res, ~1568px long edge) + ~300 tok
  prompt ≈ **~1,900 tok**. High-res (2,576px long edge, Opus 4.7+) ~4,800 tok —
  only worth it for the densest tables.
- **Output:** dense CP Red page ≈ 600–900 words ≈ **~1,300 tok** markdown.

458 pages ≈ **0.87 Mtok in / 0.6 Mtok out** (standard res).

| Model | $/Mtok (in / out) | Standard res | High res |
|-------|-------------------|--------------|----------|
| Haiku 4.5  | 1 / 5  | ~$4  | ~$5  |
| Sonnet 4.6 | 3 / 15 | ~$12 | ~$16 |
| Opus 4.8   | 5 / 25 | ~$19 | ~$27 |

**Use the [Batches API](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
— 50% off, async, and a one-time ingest doesn't care about latency.** That halves
every figure above:

- **Haiku ~$2 · Sonnet ~$6 · Opus ~$10** (standard res, batched).

**Recommendation:** Sonnet 4.6 via Batches, standard res ≈ **$6 one-time**. Plenty
for layout/table → markdown; Opus is overkill for OCR. Haiku (~$2) is cheapest but
fumbles the gnarliest multi-column stat tables more often.

## Sketch of the implementation

Ingest-only (never shipped to the runtime bundle, like pdfjs today):

1. **Rasterize** each PDF page to PNG (e.g. `pdfjs-dist` + a canvas, or
   `pdftoppm` if a poppler dep is acceptable at ingest time only). ~150 DPI gives
   a ~1250×1600 image — standard-res tier.
2. **Batch request** one entry per page (`custom_id` = page number) to
   `/v1/messages/batches`. Prompt: "Transcribe this rulebook page to clean
   markdown. Preserve reading order across columns; render tables as markdown
   tables; ignore running headers/page numbers." Image as a base64 `image` block.
3. **Poll** the batch to completion (most finish < 1h), pull results, keep the
   page-number ↔ markdown mapping (citations still work — feed the markdown
   through the existing chunker, which keeps the page number).
4. **Chunk + embed** the markdown exactly as now (`chunkPage` → `embedPassages`
   → `replaceDataset`). Only the *extraction* step changes; embedding/storage are
   unchanged.

Gate it behind a `--vision` flag on `pnpm ingest` so the heuristic path stays the
default. Model id default `claude-sonnet-4-6`; allow override.

See `ai-docs/`-adjacent: the RAG architecture lives in `CLAUDE.md` →
"Knowledge bases (RAG)". Pricing/model facts above were sourced from the
`claude-api` skill (cached 2026-05) — re-check before spending.
