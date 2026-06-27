# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Discord bot bridging Discord slash commands to pyfibot AWS Lambda functions. TypeScript, Discord.js v14, guild-scoped slash commands. Package manager is **pnpm** (`packageManager: pnpm@10.32.1`) — do not use npm/yarn despite the legacy `Procfile`.

## Development Commands

- `pnpm build` - Compile TypeScript to `dist/` (`tsc --build`)
- `pnpm dev` - Build then run
- `pnpm start` - Run compiled `dist/app.js`
- `pnpm lint` - ESLint over `src/`
- `pnpm ingest <dataset> [--pdf <file>]` - Build the RAG index for a knowledge base (see below). Runs via `tsx`, not compiled into `dist/`.
- `task build` / `task deploy` - Taskfile equivalents (deploy = full pipeline)

There is no test suite (`pnpm test` is a no-op stub).

## Architecture

Singleton bot. `src/app.ts` calls `DiscordBot.getInstance().connect()`. Everything lives in `src/DiscordBot.ts`.

### Command routing (the key design)

`connect()` validates env, registers guild slash commands via REST, then logs in. Commands are registered in **two independent places** that must be kept in sync when adding a command:

1. `registerSlashCommands()` - the `SlashCommandBuilder` definitions sent to Discord's REST API (what users see).
2. `registerCommandHandlers()` - the local `commands` Collection mapping name → handler (the fallback/internal implementation).

`setInteractionHandler()` dispatch logic:
- If command name is in the `externalCommands` Set (currently `weather`), call `pyfiCommand()` first.
- `pyfiCommand()` POSTs `{command, args, user}` to `LAMBDA_URL` with `x-api-key`. Returns `true` if it handled the interaction (including errors) — so an external command that's wired up short-circuits the internal handler.
- If Lambda env vars are missing, `pyfiCommand()` returns `false` and dispatch falls through to the internal handler. This is why `weather` has both an external path and an internal "backend not configured" stub.

`pyfiCommand()` special-cases `weather`: it regex-parses the Lambda's plaintext weather string into a Discord embed. Other commands echo `res.data.result` verbatim.

Note: external args are currently hardcoded to the `location` string option — generalizing to other external commands requires changing how args are extracted in `setInteractionHandler()`.

### Environment

Required: `DISCORD_KEY`, `CLIENT_ID`, `GUILD_ID` (validated at startup).
Optional (enable external commands): `LAMBDA_URL`, `LAMBDA_APIKEY`.
Optional (enable proactive replies): `ANTHROPIC_API_KEY` + `PROACTIVE_CHANNELS` (comma-separated channel IDs). Tuning: `PROACTIVE_MODEL` (default `claude-sonnet-4-6`), `PROACTIVE_COOLDOWN_MS` (default `30000`), `PROACTIVE_DEBUG` (set to log gate/tool decisions), `PROACTIVE_WEB_SEARCH` (set to offer Claude the web-search tool — bills per search).
Loaded from `.env` via dotenv.

### Proactive replies

Beyond slash commands, `setMessageHandler()` listens to `messageCreate` and lets the bot decide on its own whether to weigh in on chat. Requires the **Message Content** privileged intent (enabled in the Discord Developer Portal *and* added to the client's `intents`). Two-stage hybrid gate: `shouldConsiderMessage()` is a cheap local pre-filter (ignores bots — prevents self-reply loops — plus channel whitelist, min length, command prefixes, per-channel cooldown); `generateProactiveReply()` then runs a bounded Claude agentic loop that both decides and writes the reply, returning the sentinel `[[PASS]]` to stay silent. The unprompted proactive path is disabled unless `ANTHROPIC_API_KEY` and `PROACTIVE_CHANNELS` are both set.

**Direct @mention:** `isDirectMention()` detects when the bot user is tagged. A direct mention bypasses *all* limiters (whitelist, min length, prefix, cooldown — only `ANTHROPIC_API_KEY` and the bot-author guard still apply) and forces an answer: `generateProactiveReply(message, directed=true)` uses a "you were directly addressed, always answer" system prompt and skips the `[[PASS]]` silence path. So `@pyfibot what's the weather in helsinki` works in any channel the bot can see, even without `PROACTIVE_CHANNELS` configured.

**Tool calling (proactive only):** `generateProactiveReply()` is a manual agentic loop (max 5 iterations). `buildProactiveTools(dataset?)` offers Claude: `web_search` (Anthropic server-side, only when `PROACTIVE_WEB_SEARCH` is set), `pyfibot` (custom tool → `callLambda()`, only when `LAMBDA_URL`/`LAMBDA_APIKEY` are set), `search_rules` (knowledge-base retrieval — only when the channel is linked to an indexed dataset; see below), and always `fetch_history` + `lookup_user` (Discord context). The loop handles `pause_turn` (server tool ran → re-send) and `tool_use` (run custom tool via `runProactiveTool()` → feed `tool_result` back). `callLambda()` shares the POST shape with `pyfiCommand()` but is decoupled from any interaction; `pyfiCommand()` itself is unchanged.

### Knowledge bases (RAG)

Per-channel retrieval over local document sets ("datasets"), e.g. a TTRPG rulebook linked to its channel. Fully local: embeddings run on-host via transformers.js (`bge-small-en-v1.5`, 384-dim) — no embedding API key. Aligns with the project's local-LLM endgame.

- **Storage** (`src/rag/store.ts`): one `data/rag.db` file via **`node:sqlite`** (built-in, no native build; needs Node ≥22.5) + the **sqlite-vec** loadable extension (prebuilt per-platform binary, fetched by npm — no compile). One `vec0` virtual table; `dataset` is a **partition key** so each channel only searches its own game. Cosine distance.
- **Embeddings** (`src/rag/embeddings.ts`): `@xenova/transformers` v2 (CommonJS — v3 is ESM-only). Asymmetric bge: passages raw, queries get an instruction prefix; outputs normalized so dot product = cosine. Model cached under `data/.models/` (downloaded on first ingest/run).
- **Datasets ↔ channels** (`src/rag/datasets.ts` + `data/datasets.json`): `{ "pirate-borg": { "channels": ["<id>", ...] } }`. `datasetForChannel(channelId, parentId?)` reverse-maps a message's channel to a dataset; the optional `parentId` is the thread's parent channel, so a message in a **thread** (which carries the thread's own id) still resolves to the parent's dataset. A dataset's source PDFs live in `data/<dataset>/` (gitignored — copyrighted). `datasets.json` itself is gitignored (holds env-specific channel IDs); copy `data/datasets.example.json` to start. A malformed `datasets.json` is logged (vs. a missing file, which is the silent "feature off" case). **Channel IDs must be quoted strings** — Discord snowflakes exceed JS safe-integer range, so an unquoted number is silently corrupted by `JSON.parse` and never matches the string `channelId` from discord.js.
- **Ingest** (`scripts/ingest.ts`, `pnpm ingest <dataset>`): extracts PDF text **per page** (pdfjs-dist, ingest-only — runtime never imports it), chunks with overlap **keeping the page number and source** (the PDF basename), embeds locally, and writes under the dataset partition (replacing prior rows). Source + page flow through so answers cite "(Book, p.27)" — unambiguous across multi-PDF datasets. The `vec0` row stores `source` and `text` as auxiliary (`+`) columns; **changing this schema means re-ingesting** (`CREATE TABLE IF NOT EXISTS` won't migrate an existing `rag.db`).
- **Wiring**: `generateProactiveReply()` resolves the dataset (thread-aware, only if `datasetReady()`), passes it to `buildProactiveTools()` and `runProactiveTool()`, and appends a hardened KB hint to the system prompt (rulebook is the sole authority; cite source+page; say so if uncovered). For a **directed** mention in a KB channel, the first model turn is forced to `search_rules` (`tool_choice`) so it can't answer rules questions from priors. `search_rules` → `embedQuery()` → `search()` returns top-8, filtered to score ≥ `RAG_MIN_SCORE` (0.3), tagged `[<source> p.N score=…]`, and packed whole-hit up to a `RAG_RESULT_BUDGET` char cap (no mid-hit truncation).

Native binaries (`sharp`, `onnxruntime-node`, `esbuild`) are listed in `pnpm-workspace.yaml` `onlyBuiltDependencies` so the server install builds/fetches them. `task deploy` rsyncs `data/` (config, `rag.db`, model cache) but excludes `*.pdf`. **No env vars required** — the feature activates purely from `datasets.json` + an indexed dataset. Optional overrides: `RAG_DB_PATH`, `RAG_DATASETS_PATH`.

### Build

`tsc --build`, CommonJS, target es6, strict. Output `dist/`. Webpack config exists but is unused.

## Deployment

`task deploy` (build → `deploy:files` → `deploy:install` → `deploy:restart`):
- rsync `dist`, `package.json`, pnpm lockfile + workspace, `deploy.sh`, `ecosystem.config.js`, `.env` to the server.
- `pnpm install --prod --frozen-lockfile` on the server.
- `deploy.sh` runs `pm2 startOrReload ecosystem.config.js` (zero-downtime reload of the `discord-bot` app).

Deploy env vars: `DEPLOY_SERVER_USER`, `DEPLOY_SERVER_HOST`, `DEPLOY_PATH`.

## Other

- `llm-shared/` is a git submodule (github.com/lepinkainen/llm-shared) — not application code.
