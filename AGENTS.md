# Project conventions

Read `CLAUDE.md` for the detailed architecture and RAG design. This file applies
to the entire repository; read any deeper guidance before editing a subdirectory.

## Stack and layout

- TypeScript, CommonJS, strict compilation; Discord.js v14.
- Use Node **24 LTS** on the devbox (`.node-version`); CI covers Node 22 and 24.
- Use **pnpm 10.32.1**, pinned in `package.json`. npm is installed as a general
  tool, not the package manager for this project. Do not create npm/yarn lockfiles.
- `src/app.ts` loads dotenv and starts the singleton in `src/DiscordBot.ts`.
- `src/rag/` implements local embeddings, dataset routing, and SQLite retrieval.
- `scripts/` contains the TypeScript ingest and CLI entrypoints.
- `dist/` is generated; never edit or commit it.
- `llm-shared/` is a pinned Git submodule, not application code. Do not modify or
  advance it as part of unrelated changes.

## Install, build, run

```sh
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
chmod 600 .env
# Edit .env with a DEVELOPMENT bot's real credentials.
pnpm start
```

`pnpm dev` builds then starts once; it is **not** a watch mode.
`task build` is an equivalent build entrypoint.
There is no HTTP server to expose: this bot makes outbound Discord connections.

Required credentials: `DISCORD_KEY`, `CLIENT_ID`, `GUILD_ID`. Startup replaces
guild slash-command registrations before logging in, so use a dedicated test bot
and guild, not production credentials. The client requests the Message Content
intent; enable it in the Discord Developer Portal.

Optional integrations:
- Lambda: `LAMBDA_URL`, `LAMBDA_APIKEY`.
- Proactive LLM replies: `ANTHROPIC_API_KEY`, `PROACTIVE_CHANNELS`; see `CLAUDE.md`
  for mention behavior and tuning. These can incur API costs.
- RAG: copy `data/datasets.example.json` to `data/datasets.json`, keep channel IDs
  as quoted strings, place PDFs under `data/<dataset>/`, then run
  `pnpm ingest <dataset>`. First embedding use downloads a model.
- `pnpm cli` opens the offline RAG CLI after datasets have been indexed.
  `pnpm ingest` without a dataset prints ingest usage and exits nonzero.

## Verification

Run before committing:

```sh
pnpm lint
pnpm build
pnpm typecheck
git diff --check
```

There is **no automated test suite**. The existing `pnpm test` script contains
the literal text `We don't do testing here`; it is not a passing test command
and must not be reported as a test run. Lint/build/typecheck do not prove live
Discord behavior. With explicitly supplied test credentials, manually check
`/help`, `/weather`, and any changed message/RAG path in the development guild.
Do not start a live bot merely to verify compilation.

## Editing and security

- Follow surrounding TypeScript style; avoid broad formatting-only changes.
- Keep slash-command definitions and command-handler registration in sync.
- Preserve the bot-author guard, channel allowlist, cooldowns, and directed
  mention behavior when changing proactive replies.
- Keep dataset isolation, source/page citations, and retrieval budget guards.
  Changes to the vector schema may require re-ingesting existing datasets.
- Respect `pnpm-workspace.yaml` native-build allowlisting. Investigate rather
  than blanket-approve install scripts.
- Never commit `.env`, tokens, channel maps, PDFs, databases, or model caches.
  `.env.example` must contain placeholders only.
- Deployment (`task deploy`) rsyncs files and restarts a remote production bot.
  Never run it as part of environment setup or routine verification.
- Use focused commits on a topic branch. Keep the lockfile unchanged unless
  intentionally updating dependencies.

## exe.dev devbox

Persistent checkout: `/home/exedev/workspace/pyfi-discord`.
See `docs/devbox.md` for tools, GitHub integration, Codex, and the optional
systemd service. Credentials are not provisioned by this checkout.
