# Development VM

## Workspace and tools

The checkout is `/home/exedev/workspace/pyfi-discord`; files under the home
directory persist across reboots. This is disk persistence, not an off-VM
backup: push source changes and back up irreplaceable local data separately.

Installed/configured for this VM:

- Node 24, npm, and the repository's pinned pnpm 10.32.1.
- Helix (`hx`) with TypeScript/JavaScript LSP and bundled grammars.
- TypeScript language server, JSON/HTML/CSS language servers, Bash LSP, Pyright,
  and Prettier. Helix auto-format is disabled for JS/TS to avoid formatting churn.
- Codex CLI using the attached exe.dev LLM integration.
- Git, GitHub CLI, Go Task, Python 3/venv/pip, uv, and Go.
- Build tools, SQLite/dev headers, OpenSSL headers, ripgrep, fd, fzf, jq,
  tmux, shellcheck, zip/unzip; Docker is also available.

Shell configuration is in `~/.config/devbox.sh`, sourced by `.bashrc` and
`.profile`. `EDITOR` and `VISUAL` are `hx`; `WORKSPACE` is `~/workspace`;
`cproj` changes to this checkout. No automatic directory change is imposed.

```sh
cd ~/workspace/pyfi-discord
hx src/DiscordBot.ts
pnpm lint
pnpm build
pnpm typecheck
codex
```

`AGENTS.md` documents conventions, installation, running, and validation.
No Discord credentials were provisioned and the live bot was not started.

## GitHub integration

Origin uses the attached `lepinkainen-pyfi-discord` integration:

```sh
git remote -v
# https://github.int.exe.xyz/lepinkainen/pyfi-discord.git
git fetch origin
git push -u origin HEAD
GH_HOST=github.int.exe.xyz gh repo view lepinkainen/pyfi-discord
```

No GitHub token needs to be copied onto the VM. The shell exports
`GH_HOST=github.int.exe.xyz` for `gh`; override it when working with other
GitHub hosts. Only this repository was attached during setup.
The public `llm-shared` submodule was initialized at its recorded commit,
without changing its remote or revision.

## Codex

The existing Codex CLI is configured in `~/.codex/config.toml` with:

- Provider base URL `https://llm.int.exe.xyz/v1`, Responses API.
- Default model `gpt-6.1-sol`, verified with a real read-only completion.
- Workspace-write sandbox and on-request approval for interactive sessions.

No API key is stored in this configuration. The attached integration manages
access; requests may incur usage charges. Available model IDs can be inspected
with `curl -fsS https://llm.int.exe.xyz/v1/models | jq`.
Provider availability is not guaranteed for every listed model.

## Optional persistent bot service

An administrator-managed `pyfi-discord.service` is installed but **disabled**
and stopped. It runs as `exedev`, with this checkout as its working directory,
and logs to the journal. The application reads `.env` using dotenv.
Use a development bot/guild because startup registers slash commands.

After filling out `.env` and building:

```sh
chmod 600 .env
pnpm build
sudo systemctl enable --now pyfi-discord.service
sudo systemctl status pyfi-discord.service
journalctl -u pyfi-discord.service -f
```

After source changes, rebuild and `sudo systemctl restart pyfi-discord.service`.
To stop and disable autostart:

```sh
sudo systemctl disable --now pyfi-discord.service
```

Do not run a foreground bot and the service simultaneously with the same token.
The service does not run `task deploy` or contact any deployment server.
No inbound port is needed. Use tmux for temporary watch processes, not as a
replacement for systemd when a process must survive reboot.
