# AGENTS.md

> **Uno fork.** This repo is forked into **Uno Work**. Fork-specific customizations (branding, dev mode, preview pane, etc.) live in [`UNO_FORK.md`](./UNO_FORK.md). Read it before touching `apps/web/src/components/{ChatHeader,ChatView,preview/}`, `apps/desktop/src/appBranding*`, or `packages/contracts/src/{filesystem,ipc,rpc}.ts`.

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Desktop Dev Startup

- Use `bun dev:desktop` from the repo root for the full Uno Work app. `bun dev`/`bun dev:web` is not a desktop-app smoke test.
- If the user needs the app to stay running after the agent replies, do not leave it attached to an interactive tool PTY. Start it as a user launchd job, for example from the repo root:
  `launchctl submit -l xyz.unowork.dev -o /tmp/uno-work-dev.log -e /tmp/uno-work-dev.err -- /bin/zsh -lc "cd '$PWD' && exec $(command -v bun) dev:desktop"`.
  Stop that persistent dev job with `launchctl remove xyz.unowork.dev`.
- Do not report the app as running just because Vite responds. Confirm both endpoints:
  - Web: `curl -I http://127.0.0.1:5733/`
  - Desktop backend: `curl http://127.0.0.1:13773/.well-known/t3/environment`
- If the Electron window is blank/white, restart the whole `bun dev:desktop` process. Do not rely on the desktop hot-restart watcher after `apps/desktop/src/main.ts` changes.
- When diagnosing a desktop blank screen, inspect Electron/backend logs and process state for `dev-electron`, `--t3code-dev-root`, and `apps/server/dist/bin.mjs`; checking `http://127.0.0.1:5733/` in a browser is not enough.
- A successful desktop renderer smoke should include a `[desktop] renderer snapshot` log with `content-ready` and `rootTextLength > 0`.
- In desktop dev, Playwright can connect to the running Electron app at `http://127.0.0.1:9223` via CDP. Use this for Uno Work/browser-pane automation before launching a separate browser. Override/disable with `UNO_WORK_ELECTRON_REMOTE_DEBUGGING_PORT`.
- Avoid running the installed `Uno Work.app` and the dev Electron window interchangeably. They are separate processes and usually use different backend ports.

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Codex App Server (Important)

T3 Code is currently Codex-first. The server starts `codex app-server` (JSON-RPC over stdio) per provider session, then streams structured events to the browser through WebSocket push messages.

How we use it in this codebase:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent` (provider runtime activity is projected into orchestration events server-side).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
