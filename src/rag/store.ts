/**
 * Vector store backed by node:sqlite (built-in, no native build) + the
 * sqlite-vec loadable extension (prebuilt per-platform binary, fetched by npm).
 *
 * Single DB file holds every dataset; `dataset` is a vec0 partition key so a
 * channel's search only ever sees its own game's rules. Embeddings are stored
 * as JSON text — sqlite-vec parses that into the vector on the way in.
 */
import path from "path";
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { EMBED_DIM } from "./embeddings";

export const DB_PATH =
  process.env.RAG_DB_PATH ?? path.resolve(process.cwd(), "data/rag.db");

export interface ChunkRow {
  page: number;
  text: string;
  embedding: number[];
}

export interface SearchHit {
  page: number;
  text: string;
  score: number; // cosine similarity in [0,1]; higher is closer
}

function open(readonly: boolean): DatabaseSync {
  const db = new DatabaseSync(DB_PATH, { allowExtension: true, readOnly: readonly });
  db.loadExtension(sqliteVec.getLoadablePath());
  return db;
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      embedding float[${EMBED_DIM}] distance_metric=cosine,
      dataset TEXT partition key,
      page INTEGER,
      +text TEXT
    );
  `);
}

// ---- Runtime (read) -------------------------------------------------------

let readDb: DatabaseSync | undefined;

function getReadDb(): DatabaseSync {
  if (!readDb) {
    readDb = open(true);
  }
  return readDb;
}

/** Distinct dataset names that currently have indexed rows. */
export function listDatasets(): string[] {
  try {
    const db = getReadDb();
    const rows = db
      .prepare("SELECT DISTINCT dataset FROM vec_chunks ORDER BY dataset")
      .all() as Array<{ dataset: string }>;
    return rows.map((r) => r.dataset);
  } catch {
    return [];
  }
}

/** Returns true if the DB file exists and holds rows for the given dataset. */
export function datasetReady(dataset: string): boolean {
  try {
    const db = getReadDb();
    const row = db
      .prepare("SELECT count(*) AS n FROM vec_chunks WHERE dataset = ?")
      .get(dataset) as { n: number } | undefined;
    return !!row && row.n > 0;
  } catch {
    return false;
  }
}

/** k-nearest chunks for a query embedding, scoped to one dataset. */
export function search(
  dataset: string,
  queryEmbedding: number[],
  k: number
): SearchHit[] {
  const db = getReadDb();
  const rows = db
    .prepare(
      `SELECT page, text, distance
         FROM vec_chunks
        WHERE embedding MATCH ? AND k = ? AND dataset = ?
        ORDER BY distance`
    )
    .all(JSON.stringify(queryEmbedding), k, dataset) as Array<{
    page: number;
    text: string;
    distance: number;
  }>;
  // cosine distance -> similarity
  return rows.map((r) => ({ page: r.page, text: r.text, score: 1 - r.distance }));
}

// ---- Ingest (write) -------------------------------------------------------

/** Wipe and rewrite all rows for a dataset. Used by the ingest CLI. */
export function replaceDataset(dataset: string, rows: ChunkRow[]): void {
  const db = open(false);
  try {
    ensureSchema(db);
    db.exec("BEGIN");
    db.prepare("DELETE FROM vec_chunks WHERE dataset = ?").run(dataset);
    const ins = db.prepare(
      "INSERT INTO vec_chunks(embedding, dataset, page, text) VALUES (?, ?, ?, ?)"
    );
    for (const r of rows) {
      // sqlite-vec's INTEGER metadata column is strict; node:sqlite binds plain
      // JS numbers as REAL, so coerce the page to a BigInt (-> INTEGER).
      ins.run(JSON.stringify(r.embedding), dataset, BigInt(Math.trunc(r.page)), r.text);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}
