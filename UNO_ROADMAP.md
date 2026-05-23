# Uno Work Roadmap

> Status legend: ✅ done · 🟡 in progress · ⏳ not started · ⏭ deferred

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

- ⏳ Decide license and governance model for the open-source release.
- ✅ Keep the Uno fork delta documented separately from upstream T3 Code (`UNO_FORK.md`).
- 🟡 Write public docs: README, install guide, development guide, provider guide, security policy. _(README inherited from upstream; Uno-specific install/dev/security docs not yet written.)_
- ⏳ Define privacy and telemetry stance: what is local, what can be sent to UNO, and how users opt out.
- ⏳ Document the provider/harness adapter contract for contributors.

## Phase 1: MVP Product Polish

### Excel Preview ✅

- ✅ Real `.xlsx` preview via `xlsx@0.18` (`SpreadsheetBody` renders parsed workbooks).
- ✅ Workbook data read through server-side RPC (`WorkspaceFileSystem`).
- ✅ Sheet rendering with table cells, loading and error states.
- ⏭ Full Excel editing — deferred per plan.

### Preview Pane Coverage Beyond Spec

- ✅ `svg` (sandboxed iframe — blocks JS-in-SVG XSS).
- ✅ `docx` (lazy `mammoth.browser` `convertToHtml`).
- ✅ `text/plain` (`.txt` mapped to text on client and server, MIME table updated).
- ✅ `csv` with stable keyed entries (no index-as-key warnings on duplicate header rows).
- ✅ `PathBar` with full path + horizontal scroll, per-segment navigation, project-root folder icon.
- ✅ Tabs row "+" button — opens file browser at current chat's project cwd.
- ✅ Mutual exclusion: Diff panel ↔ Preview pane (only one open at a time).

### Environment Selector Integration ✅

- ✅ Bottom-left Uno environment dropdown rewired to real T3 `EnvironmentId`/`ConnectionState`.
- ✅ Reconnect handler + runtime store + thread-route navigation in `SidebarEnvSwitcher`.
- ✅ `AddEnvModal` drives real environment creation.
- ✅ Sidebar threads strictly scoped via `selectSidebarThreadsForEnvironment`.
- ✅ `NoActiveThreadState` filters projects by selected env (hybrid 0/1/many picker).
- ✅ `useReconnectEnvironment` hook + `onHeartbeatTimeout` → `connectionState: "error"` so dropdown stops showing green for silently-dropped remote envs.

### Core UX Hardening

- 🟡 Polish preview, chat, files, loading, error, and empty states. _(Preview polished; chat/files/loading/error states still inherited from upstream — pending an audit pass.)_
- ✅ Hide dev-only controls from normal users (`devMode` toggle gates ProjectScripts, OpenInPicker, GitActions, Terminal, Diff, BranchToolbar, "No Git" badge).
- ⏳ Predictable keyboard and navigation behavior where it affects daily use.
- ⏳ Local doctor/diagnostics surface for Codex, Claude, Git, permissions, and runtime issues.

### Tests

- ✅ `selectSidebarThreadsForEnvironment` env-scoped sidebar test.
- ✅ `detectFileKind` unit tests for every kind (incl. docx/svg recategorisation).
- ✅ `PreviewPaneContext` tests.
- 🟡 Env switching/reconnect integration coverage — partial; expand alongside Phase 2 CI.

## Phase 2: Desktop Release

> Inherited from upstream T3: `apps/desktop` (Electron 40 + electron-updater), `scripts/build-desktop-artifact.ts`, `.github/workflows/release.yml` (stable + nightly schedules + smoke tests). Brand already swapped to "Work" / "Work (Nightly)".

- ⏳ Verify desktop build works on this fork end-to-end (`bun dev:desktop`, then `scripts/build-desktop-artifact.ts` for macOS arm64/x64).
- ⏳ Add Windows and Linux builds after the macOS path is stable.
- 🟡 Release CI with `bun fmt`, `bun lint`, `bun typecheck`, `bun run test`, and app build checks. _(Workflows inherited; need to re-point release targets to Uno fork repo and re-run on our branch.)_
- ⏳ Publish artifacts through GitHub Releases of the fork (currently inherits T3 release config).
- ⏳ Signing/notarization for macOS — requires Apple Developer account + signing identity in CI secrets.
- ⏳ Decide whether auto-updates are needed for the first public release or can follow shortly after. _(`electron-updater` already wired in upstream — just needs an update-server URL we control.)_
- ⏳ Add first-run setup checks for installed/authenticated providers.

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

### Claude Billing Profiles And Fallback

- ⏳ Add explicit Claude billing profiles for the Claude harness: subscription/interactive,
  Agent SDK credits, Anthropic API, Bedrock, Vertex, and Uno Gateway where protocol-compatible.
- ⏳ Support safe Claude runtime restart + resume when switching billing backend. Model switches can
  stay in-session, but auth/backend changes must restart the Claude Agent SDK query with a new env.
- ⏳ Preserve the same Uno Work thread during a Claude billing-profile switch: reuse cwd, runtime
  mode, model selection, and Claude resume cursor when the selected profiles share compatible
  Claude home/session state.
- ⏳ Add a visible "Continue with ..." recovery action for cases such as subscription limits,
  exhausted Agent SDK credits, missing API credits, or Bedrock/Vertex auth errors.
- ⏳ Add a Claude subscription terminal mode for users who specifically want to consume normal
  interactive Claude Code subscription limits. Treat it as an embedded terminal workflow, not as a
  fully managed Agent SDK session, unless Anthropic provides an approved integration path.
- ⏳ Document the product boundary: fully managed Uno Work sessions use Agent SDK/API-style billing;
  ordinary Claude subscription limits are available through real interactive Claude Code or an
  approved Anthropic integration.

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

> Phase 1 sprint completed (commits `205a76c2`, `5f1cbb88`, plus uncommitted UX polish).

1. ✅ Implement Excel preview.
2. ✅ Replace the parallel Uno environment dropdown state with the real T3 environment model.
3. ✅ Scope visible chats strictly to the selected environment.
4. 🟡 Add/update tests around environment switching and preview behavior. _(Sidebar selector + preview kinds covered; reconnect/heartbeat integration tests still pending.)_
5. ✅ Run `bun fmt`, `bun lint`, `bun typecheck`, and focused `bun run test` coverage. _(Per-change validation; keep running before each commit.)_

### Next Sprint — toward Phase 2 cut

1. Commit pending UX polish (`ChatView`, `NoActiveThreadState`, `Sidebar`, `SidebarEnvSwitcher`, `ChatHeader`, `PreviewPane`, `PreviewPaneContext`, `service.ts`, `useReconnectEnvironment.ts`, desktop branding tweak).
2. Run full `bun run test` baseline; document any pre-existing failures vs. ours.
3. Smoke-test `bun dev:desktop` (full Electron flow) and `scripts/build-desktop-artifact.ts` locally for macOS.
4. Decide signing/notarization story (Apple Developer account + CI secrets) before tagging a public macOS build.
5. Decide auto-update channel (own update server vs. GitHub Releases via electron-updater) for the fork.
