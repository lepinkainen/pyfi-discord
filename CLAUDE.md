# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Discord bot bridging Discord slash commands to pyfibot AWS Lambda functions. TypeScript, Discord.js v14, guild-scoped slash commands. Package manager is **pnpm** (`packageManager: pnpm@10.32.1`) — do not use npm/yarn despite the legacy `Procfile`.

## Development Commands

- `pnpm build` - Compile TypeScript to `dist/` (`tsc --build`)
- `pnpm dev` - Build then run
- `pnpm start` - Run compiled `dist/app.js`
- `pnpm lint` - ESLint over `src/`
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

**Tool calling (proactive only):** `generateProactiveReply()` is a manual agentic loop (max 5 iterations). `buildProactiveTools()` offers Claude: `web_search` (Anthropic server-side, only when `PROACTIVE_WEB_SEARCH` is set), `pyfibot` (custom tool → `callLambda()`, only when `LAMBDA_URL`/`LAMBDA_APIKEY` are set), and always `fetch_history` + `lookup_user` (Discord context). The loop handles `pause_turn` (server tool ran → re-send) and `tool_use` (run custom tool via `runProactiveTool()` → feed `tool_result` back). `callLambda()` shares the POST shape with `pyfiCommand()` but is decoupled from any interaction; `pyfiCommand()` itself is unchanged.

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
