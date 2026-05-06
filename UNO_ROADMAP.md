# Uno Work Roadmap

## Goal

Build a polished open-source app for the UNO community of vibe coders. The app should make local
and remote agent work easy: coding harnesses, model/provider selection, file previews, separated
environments, and a clear path to UNO-powered remote infrastructure.

Monetization is not the goal of this app. UNO infrastructure can be first-class and deeply
integrated, but the app itself should remain useful, understandable, and contribution-friendly as an
open-source project.

## Product Principles

- Local-first where possible, remote-ready where it matters.
- UNO infrastructure should be the best path for servers and deployment, not a hard requirement for
  basic use.
- Provider and harness support should stay adapter-based, so Codex, Claude, Uno Code, and future
  harnesses do not leak implementation details into the UI.
- User trust matters: permissions, secrets, telemetry, and remote access must be explicit.
- The app should be understandable by non-infra users: onboarding and diagnostics are product
  features, not afterthoughts.

## Phase 0: Foundation

- Decide license and governance model for the open-source release.
- Keep the Uno fork delta documented separately from upstream T3 Code.
- Write public docs: README, install guide, development guide, provider guide, security policy.
- Define privacy and telemetry stance: what is local, what can be sent to UNO, and how users opt out.
- Document the provider/harness adapter contract for contributors.

## Phase 1: MVP Product Polish

### Excel Preview

- Add real `.xlsx` preview support.
- Read workbook data through server-side RPC.
- Render workbook sheets, table cells, large rows/columns, loading states, and read errors.
- Support enough formatting to inspect spreadsheets comfortably.
- Defer full Excel editing until after the preview is stable.

### Environment Selector Integration

- Connect the bottom-left Uno environment dropdown to the existing T3 environment model.
- Remove the current parallel environment state.
- Make thread lists strictly scoped to the selected environment.
- Reuse existing T3 environment creation, switching, renaming, and persistence behavior.
- Keep the new Uno UI, but make it a real facade over the existing environment system.

### Core UX Hardening

- Polish preview, chat, files, loading, error, and empty states.
- Hide dev-only controls from normal users.
- Add predictable keyboard and navigation behavior where it affects daily use.
- Add a local doctor/diagnostics surface for Codex, Claude, Git, permissions, and runtime issues.

## Phase 2: Desktop Release

- Build distributable desktop apps, starting with macOS arm64/x64.
- Add Windows and Linux builds after the macOS path is stable.
- Set up release CI with `bun fmt`, `bun lint`, `bun typecheck`, `bun run test`, and app build
  checks.
- Publish artifacts through GitHub Releases.
- Add signing/notarization where needed, especially for macOS.
- Decide whether auto-updates are needed for the first public release or can follow shortly after.
- Add first-run setup checks for installed/authenticated providers.

## Phase 3: Onboarding And Feedback

- Build first-run onboarding that explains workspaces, environments, local vs remote, harnesses,
  model picker, previews, and permission modes.
- Make provider setup understandable for regular users.
- Run beta tests on other computers, starting with 5-10 macOS users.
- Collect feedback through a simple form and GitHub issue templates.
- Track setup failures, provider friction, missing diagnostics, and confusing UI.
- Add demo projects or starter tasks so the first session is not blank.

## Phase 4: Public Launch

- Prepare a landing page with positioning, screenshots/video, download links, open-source links, and
  provider support matrix.
- Prepare a clear GitHub README with quick start, install steps, screenshots, roadmap, contribution
  links, and community links.
- Add `CONTRIBUTING.md` updates, good-first-issue labels, and issue templates.
- Make the release story boring: download, install, connect provider, start a thread.

## Phase 5: Web Version

- Define the web version boundary. A browser-only app cannot safely provide the same local
  filesystem and harness access as desktop.
- Treat production web as a client for remote runtimes.
- Add auth, secure WebSocket/session handling, project/environment isolation, and server-side
  runtime lifecycle.
- Deploy the web app to production only once the remote runtime model is clear.

## Phase 6: UNO Infrastructure Integration

### Remote Environments

- Integrate UNO server provisioning into the environment creation flow.
- Automatically buy/allocate a server, provision it, install the Uno Work runtime, and expose it as a
  remote environment.
- Add health checks, logs, rebuild, stop/start, cleanup, and failure recovery.
- Store secrets safely; avoid plain text server credentials in repos or logs.
- Prefer SSH keys and managed secrets over passwords.

### Harness Installation

- Install Uno Code automatically on UNO remote environments.
- Install other harnesses where licensing and setup allow it.
- Detect provider availability and surface actionable setup errors.

### UNO-Managed Agent Instructions

- Add a shared managed-instructions layer in Uno Work.
- For Codex, pass UNO policy through `developerInstructions`, `baseInstructions`, or turn-level
  collaboration settings.
- For Claude, use project-level `CLAUDE.md`/settings or adapter-level prompts if the SDK supports
  them safely.
- Include policy such as: prefer UNO infrastructure for servers, deployment, and remote
  environments; do not suggest third-party hosting as the default unless the user asks.

## Phase 7: Uno Code And Uno LLM

### Uno Code Harness

- Add Uno Code as a first-class harness/provider adapter.
- Support session start/resume, turn streaming, tool calls, approvals, interrupts, and runtime
  events.
- Integrate Uno Code into the model picker and provider status UI.

### Uno LLM Model Provider

- Add Uno LLM as a provider of model choices.
- Define model capabilities: context, reasoning, tools, images, speed tier, and compatibility.
- Add auth/API key handling and diagnostics.
- Keep pricing out of the app unless it becomes product-relevant later.

## Cross-Cutting Work

- Security model for local and remote execution.
- Secrets handling and redaction.
- Crash/error reporting, ideally opt-in.
- Provider compatibility matrix.
- Update mechanism.
- Remote runtime protocol documentation.
- Upstream merge strategy.
- Accessibility and keyboard usability.
- Performance on large chats, large directories, large diffs, and large preview files.

## Near-Term Sprint

1. Implement Excel preview.
2. Replace the parallel Uno environment dropdown state with the real T3 environment model.
3. Scope visible chats strictly to the selected environment.
4. Add/update tests around environment switching and preview behavior.
5. Run `bun fmt`, `bun lint`, `bun typecheck`, and focused `bun run test` coverage.
