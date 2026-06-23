# Uno Work

AI workspace where agents do real work on real files — and you see the result without leaving the app.

Uno Work is not an IDE. It's a desktop app that connects to AI coding agents (harnesses) you already have installed — Claude Code, Codex CLI, Cursor, OpenCode — and adds a visual layer on top: file preview, diff review, project management, and remote environments.

## Download

Install the latest desktop app from [GitHub Releases](https://github.com/technoob228/uno-work/releases).

| Platform              | File                 |
| --------------------- | -------------------- |
| macOS (Apple Silicon) | `Uno-Work-arm64.dmg` |
| macOS (Intel)         | `Uno-Work-x64.dmg`   |
| Windows               | `Uno-Work.exe`       |
| Linux                 | `Uno-Work.AppImage`  |

## Features

- **Multi-harness support** — use Claude Code, Codex CLI, OpenCode, or Cursor through one interface. Switch between them from the chat header.
- **Uno Code (bundled)** — a built-in AI coding agent, auto-installed on first launch. Works out of the box with Uno LLM — no API keys required.
- **Uno LLM** — built-in model access via Uno's LLM Gateway. Bring your own Uno API key and skip third-party subscriptions.
- **File preview** — view PDF, Excel, Word, HTML, images, JSON, CSV, and SVG inline without leaving the chat.
- **Dev mode** — toggle to unlock Git/GitHub integration, diff review, project scripts, and terminal access. Hidden by default to keep the UI clean for non-coders.
- **Remote environments** — connect to remote servers via SSH and work on files as if they were local.
- **Onboarding wizard** — guided setup on first launch that detects installed harnesses and walks through configuration.

## Supported harnesses

| Harness     | Auto-detected            | Auth                  |
| ----------- | ------------------------ | --------------------- |
| Uno Code    | Bundled (auto-installed) | Uno API key           |
| Claude Code | Yes (if on PATH)         | `claude auth login`   |
| Codex CLI   | Yes (if on PATH)         | `codex login`         |
| OpenCode    | Yes (if on PATH)         | `opencode auth login` |
| Cursor      | Yes (if on PATH)         | Cursor account        |

## Development

```bash
bun install
bun dev:desktop    # Electron + web + server (full app)
bun dev:web        # web + server only (opens in browser)
bun typecheck      # type-check all packages
```

## Architecture

Monorepo with Bun + Turborepo:

- `apps/desktop` — Electron shell
- `apps/server` — backend (provider orchestration, workspace, Git, SSH)
- `apps/web` — React frontend (TanStack Router, Tailwind, shadcn/ui)
- `packages/contracts` — shared types and schemas (Effect Schema)

Based on [T3 Code](https://github.com/pingdotgg/t3code) by Ping.gg.

## Contact

- Website: [getuno.xyz](https://getuno.xyz)
- Support: [hello@getuno.xyz](mailto:hello@getuno.xyz)
- Telegram: [@get_uno_support](https://t.me/get_uno_support)
