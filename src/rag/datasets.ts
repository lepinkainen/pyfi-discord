/**
 * Channel <-> dataset wiring. A "dataset" is one knowledge base (e.g. a single
 * TTRPG rulebook) that lives in data/<dataset>/ and is indexed under its name in
 * the vector store. Each dataset links to one or more Discord channel IDs, so a
 * message in the Pirate Borg channel only ever searches the Pirate Borg rules.
 *
 * Config file (data/datasets.json):
 *   { "pirate-borg": { "channels": ["123...", "456..."] } }
 */
import fs from "fs";
import path from "path";

export interface DatasetConfig {
  channels: string[];
}

const CONFIG_PATH =
  process.env.RAG_DATASETS_PATH ??
  path.resolve(process.cwd(), "data/datasets.json");

let cache: Record<string, DatasetConfig> | undefined;

export function loadDatasets(): Record<string, DatasetConfig> {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Record<
      string,
      DatasetConfig
    >;
  } catch (err) {
    // ENOENT (no config) is the normal "feature off" case; anything else
    // (malformed JSON, bad permissions) is a misconfiguration worth surfacing
    // rather than silently behaving like there's no config at all.
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") {
      console.error(`Failed to load datasets config at ${CONFIG_PATH}:`, e.message);
    }
    cache = {};
  }
  return cache;
}

/**
 * The dataset linked to a channel, or undefined if none. First match wins.
 * Pass `parentId` (a thread's parent channel) to fall back to it — messages in
 * a Discord thread carry the thread's own id, but datasets are mapped to the
 * parent channel, so a thread would otherwise never match.
 */
export function datasetForChannel(
  channelId: string,
  parentId?: string | null
): string | undefined {
  const datasets = loadDatasets();
  for (const [name, cfg] of Object.entries(datasets)) {
    if (cfg.channels?.includes(channelId)) return name;
    if (parentId && cfg.channels?.includes(parentId)) return name;
  }
  return undefined;
}
