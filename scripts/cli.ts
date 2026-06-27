/**
 * Local RAG chat — exercises the knowledge base without Discord or the gateway.
 * Same retrieval path the bot uses (embeddings.ts + store.ts) wrapped in a small
 * Claude agentic loop with just the `search_rules` tool.
 *
 *   pnpm cli                              # interactive REPL (default)
 *   pnpm cli "what test do we roll for ranged?"   # one-shot: answer + exit
 *   pnpm cli --dataset cyberpunk-red "how does netrunning work?"
 *   pnpm cli --retrieval-only "ranged attacks"    # raw chunks, no Claude (no API key)
 *
 * Needs ANTHROPIC_API_KEY (from .env) unless --retrieval-only. Tool calls are
 * logged to stderr so stdout stays clean for tests/piping.
 */
import "dotenv/config";
import * as readline from "readline";
import Anthropic from "@anthropic-ai/sdk";
import { embedQuery } from "../src/rag/embeddings";
import { datasetReady, listDatasets, search } from "../src/rag/store";

const MAX_ITERS = 5;
const TOP_K = 5;

function err(msg: string): void {
  process.stderr.write(msg + "\n");
}

/** Retrieve top-k chunks, formatted with page tags — the search_rules payload. */
async function retrieve(dataset: string, query: string): Promise<string> {
  const vec = await embedQuery(query);
  const hits = search(dataset, vec, TOP_K);
  if (hits.length === 0) return `No matching passages in the ${dataset} knowledge base.`;
  return hits
    .map((h) => `[${h.source} p.${h.page} score=${h.score.toFixed(2)}] ${h.text}`)
    .join("\n\n---\n\n");
}

const TOOL: Anthropic.Tool = {
  name: "search_rules",
  description:
    "Search the rulebook/knowledge base for relevant passages. Returns excerpts " +
    "tagged with their source page like [p.27]. Cite the page number(s) in your answer.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look up." },
    },
    required: ["query"],
  },
};

async function answer(
  client: Anthropic,
  dataset: string,
  question: string
): Promise<string> {
  const model = process.env.PROACTIVE_MODEL ?? "claude-sonnet-4-6";
  const system =
    `You answer questions about the "${dataset}" tabletop RPG using its rulebook. ` +
    "You MUST call search_rules and base your answer solely on what it returns — " +
    "never on prior knowledge. Cite the source and page for every claim, like " +
    '"(Core Rulebook, p.27)". If the rules don\'t cover it, say so.';

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: question },
  ];

  for (let i = 0; i < MAX_ITERS; i++) {
    const res = await client.messages.create({
      model,
      max_tokens: 1024,
      system,
      tools: [TOOL],
      messages,
    });

    if (res.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: res.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type !== "tool_use") continue;
        const query = String((block.input as { query?: unknown }).query ?? "");
        err(`  🔍 search_rules("${query}")`);
        const out = await retrieve(dataset, query);
        results.push({ type: "tool_result", tool_use_id: block.id, content: out });
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }
  return "(gave up after too many tool calls)";
}

/** Minimal arrow-key single-select, rendered to stderr (stdout stays clean). */
function selectDataset(options: string[]): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let idx = 0;
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();

    const render = (first = false): void => {
      if (!first) process.stderr.write(`\x1b[${options.length + 1}A`); // back to header
      process.stderr.write("Select dataset (↑/↓, Enter):\x1b[K\n");
      options.forEach((o, i) => {
        const sel = i === idx;
        process.stderr.write(`${sel ? "\x1b[36m❯ " : "  "}${o}${sel ? "\x1b[0m" : ""}\x1b[K\n`);
      });
    };

    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.removeListener("keypress", onKey);
      stdin.pause();
      process.stderr.write("\n");
    };

    const onKey = (_: string, key: readline.Key): void => {
      if (!key) return;
      if (key.name === "up") (idx = (idx - 1 + options.length) % options.length), render();
      else if (key.name === "down") (idx = (idx + 1) % options.length), render();
      else if (key.name === "return") cleanup(), resolve(options[idx]);
      else if (key.name === "c" && key.ctrl) (cleanup(), process.exit(130));
    };

    render(true);
    stdin.on("keypress", onKey);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  let dataset: string | undefined;
  let retrievalOnly = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dataset") dataset = argv[++i];
    else if (argv[i] === "--retrieval-only") retrievalOnly = true;
    else rest.push(argv[i]);
  }
  const oneShot = rest.join(" ").trim();

  // Resolve which dataset to use: explicit flag > single indexed > interactive pick.
  if (!dataset) {
    const available = listDatasets();
    if (available.length === 0) {
      err("No datasets indexed. Run: pnpm ingest <dataset>");
      process.exit(1);
    } else if (available.length === 1) {
      dataset = available[0];
    } else if (process.stdin.isTTY) {
      dataset = await selectDataset(available);
    } else {
      err(`Multiple datasets — pass --dataset <name>: ${available.join(", ")}`);
      process.exit(1);
    }
  }

  if (!datasetReady(dataset)) {
    err(`Dataset "${dataset}" is not indexed. Run: pnpm ingest ${dataset}`);
    process.exit(1);
  }

  let client: Anthropic | undefined;
  if (!retrievalOnly) {
    if (!process.env.ANTHROPIC_API_KEY) {
      err("ANTHROPIC_API_KEY not set. Use --retrieval-only to test search without Claude.");
      process.exit(1);
    }
    client = new Anthropic();
  }

  const respond = async (q: string): Promise<string> =>
    retrievalOnly ? retrieve(dataset, q) : answer(client!, dataset, q);

  // One-shot mode.
  if (oneShot) {
    process.stdout.write((await respond(oneShot)) + "\n");
    return;
  }

  // Interactive REPL.
  err(`RAG chat — dataset "${dataset}"${retrievalOnly ? " (retrieval-only)" : ""}. Ctrl-D or "exit" to quit.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const prompt = (): void => {
    rl.setPrompt("\n> ");
    rl.prompt();
  };
  prompt();

  for await (const line of rl) {
    const q = line.trim();
    if (!q) {
      prompt();
      continue;
    }
    if (q === "exit" || q === "quit") break;
    try {
      process.stdout.write((await respond(q)) + "\n");
    } catch (e) {
      err(`error: ${(e as Error).message}`);
    }
    prompt();
  }
  rl.close();
}

main().catch((e) => {
  err(String(e));
  process.exit(1);
});
