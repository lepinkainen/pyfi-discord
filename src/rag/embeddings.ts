/**
 * Local text embeddings via transformers.js (@xenova/transformers v2, CommonJS).
 * No API key, no cloud call — runs the ONNX model on the host. Aligns with the
 * project's local-LLM endgame; the only native dep is onnxruntime-node, which
 * ships prebuilt per-platform (no compile-from-source).
 *
 * Model: bge-small-en-v1.5 (384-dim). Asymmetric: passages are embedded raw,
 * queries get a task-instruction prefix. Outputs are mean-pooled + L2-normalized
 * so a dot product equals cosine similarity.
 */
import path from "path";
import { env, pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

export const EMBED_MODEL = "Xenova/bge-small-en-v1.5";
export const EMBED_DIM = 384;

// bge retrieval instruction — prepended to queries only, never to passages.
const QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

// Cache the model under the project so it can be predownloaded/inspected; the
// server downloads it once on first run (needs outbound network).
env.cacheDir = path.resolve(process.cwd(), "data/.models");

let pipePromise: Promise<FeatureExtractionPipeline> | undefined;

function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipePromise) {
    pipePromise = pipeline("feature-extraction", EMBED_MODEL);
  }
  return pipePromise;
}

async function embed(texts: string[]): Promise<number[][]> {
  const pipe = await getPipeline();
  const out = await pipe(texts, { pooling: "mean", normalize: true });
  // Tensor -> number[][]; tolist() yields one row per input.
  return out.tolist() as number[][];
}

/** Embed document/passage chunks (no prefix). */
export function embedPassages(texts: string[]): Promise<number[][]> {
  return embed(texts);
}

/** Embed a single search query (with the bge instruction prefix). */
export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await embed([QUERY_PREFIX + text]);
  return vec;
}
