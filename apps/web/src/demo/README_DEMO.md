# Assistants demo base (28.10)

The real Uno Work web client (`apps/web`) with every computer answered inside the
page: the assistant screens are the real ones (sidebar, `AssistantProfileSimple`,
the chat, Inbox, Settings → Connectors), only the daemons and the Uno account are
fake (msw + the in-page RPC harness). Build flag `VITE_DEMO=assist`
(`?demo=assist` on the dev server). The 16.10 mock (`VITE_DEMO=w0138`) still builds.

## Where things are

| What                                                                                           | File                                                                        |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| The account's state (worlds, address params)                                                   | `assist/world.ts`                                                           |
| Projects, chats, Inbox per world; `DEMO_PERSONAS`                                              | `assist/fixtures.ts`                                                        |
| Fake daemon routes (`/api/manager/assistant*`, connectors, Telegram) + account (`/_account/*`) | `assist/daemon.ts`                                                          |
| Scripted assistant replies: triggers, scenes, greeting                                         | `assist/engine.ts`                                                          |
| **The variant's hook** (personas, own scripts/scenes)                                          | `assist/variant.ts`                                                         |
| The "what to look at" card                                                                     | `assist/AssistPanel.tsx`                                                    |
| Wiring into the computers' models / RPC                                                        | `demoBoot.ts` (search `DEMO_ASSIST`)                                        |
| Real assistant components                                                                      | `../components/assistants/*`, `../components/sidebar/SidebarAssistants.tsx` |
| Playwright flows                                                                               | `../../demo-e2e/`                                                           |

## Worlds

Address params (any subset; saved in the browser until changed from the card):
`world=live|new`, `tier=plus|free`, `mac=online|asleep`, `tg=on|off`,
`mode=itself|asks-first`, `platform=cloud|desktop`, `gmail|drive|notion|github=on|off|expired`,
`speed=N` (scripts N× faster), `panel=closed`.

Live: uno-work (Plus, the page's own computer) + MacBook (online/asleep) + Free
cloud computer (asleep, listed by the account only). New: one computer, no chats,
Uno greets first.

## The engine

A script is a list of steps: `say`, `work` (a line while still running), `ask`
(quiz card; `connect` gives the real Connect button), `act` (outward action —
"Autonomous" runs it, "Cautious" shows the real Allow card + an Inbox card,
"also sent to Telegram" when linked, waits without refusing), `elsewhere` (a chat
on another computer with steps, result back + Inbox), `fail`, `inbox`, `run`.
Triggers match the person's words per persona (or any); scenes are things that
happen without typing (morning summary, Telegram message, 16:00 reminder with
Work closed, task on another computer, error).

## Add a variant (in its own branch from `demo/assistants-base-1028`)

1. In `assist/variant.ts` set `VARIANT` and push personas into `DEMO_PERSONAS`
   (any number, any computer); add `addTrigger`/`addScene`/`setGreeting` for its story.
2. Change the real components for the variant's UI (assistants, sidebar, Inbox);
   keep data coming through the daemon routes — add a route in `daemon.ts` if the
   real code needs a new one, not a demo-only store.
3. Flows: copy `demo-e2e/flows/base.flow.mjs` to `demo-e2e/flows/<variant>.flow.mjs`
   (`openDemo(page, url, {world params})`, `scene`, `openMainChat`, `send`, `seeText`, `shot`).
   `demo-e2e/build-demo.sh && node demo-e2e/run.mjs [name]` → `demo-e2e/shots/` + `report.json`.
4. Publish: `demo-e2e/publish-demo.sh <variant>` → `https://misha-assistants-<variant>-1028.uno4.me`
   under the password `duet-four-ways-1027` (zip → console deploy API; `site_publish` times out on 28 MB).

Browser for flows: Chrome for Testing from `PLAYWRIGHT_BROWSERS_PATH` if whole,
else the system Chrome. Typecheck: `cd apps/web && tsc --noEmit`.

## Known gaps (base, 28.10)

- "Token expired" is not a state in the real connectors list: the demo lists it as
  connected and the assistant says so in chat + an Inbox card.
- An asleep MacBook is offline by not answering; there's no wake-up scene yet,
  and the Free computer is only in the account's list (never connected).
- Onboarding (first run) is skipped in both worlds (`onboardingCompleted: true`).
- Avatars/pictures, Slack, the assistant's own mail are stubs (empty answers).

## Variant D (branch `demo/assistants-d-1028`)

One Uno per account on the cloud computer + persona channels (Mia · Secretary,
Bolt · Developer) next to it. Story: `assist/variant.ts` (personas, first run,
one summary with a line per persona, Mia's decision, Bolt's tasks on the
MacBook, Free catch-up). UI: `components/assistants/PersonaCreator.tsx`
(Grok-style gallery → "Make it yours"), `PersonaMode.tsx` (the two modes as a
chip in the chat and a switch on the page, Free plaque, who/where in the
Inbox), `personaChannels.ts` (gallery, character line, where a project limit
is a real lock). Extra address params: `personas=N`, `facegen=fail`.
Flows: `demo-e2e/flows/d.flow.mjs` (`node demo-e2e/run.mjs d-`).

## Automations (28.10, branch `feat/automations-web-1028`)

What assistants do by themselves — on a schedule or when something happens
(a GitHub pull request, after a call; Gmail "Soon"). Contract:
`reports/day_2026-10-28/automations/CONTRACT.md`.

| What                                                                                        | File                                                                      |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| The daemon's `/api/manager/automations*` (kept per computer), runs, scenes, the chat phrase | `assist/automations.ts` (routes spread into `daemon.ts`)                  |
| Client + react-query hooks                                                                  | `../lib/automationsApi.ts`, `../components/automations/useAutomations.ts` |
| Words, the dialog's draft ↔ trigger, grouping (pure, tested)                                | `../components/automations/automations.logic.ts`                          |
| Card · dialog · section on the assistant's page · `/automations` screen · chat card         | `../components/automations/*`                                             |

Extra address params: `automations=none|some` (live has 3: Uno "Sum up my day",
Bolt "Review PRs in getuno/web", Mia "Follow-up after calls"), `gh=ok|norepo|noperm|off`
(the Uno GitHub app sees the repos / doesn't see getuno/web / lacks "Pull requests:
write" / isn't installed), `macassistant=on` (Kit lives on the MacBook — its page
says "Automations run on a cloud computer"). Both are rows in the "what to look at" card.

Scenes (Bolt's chat in the live account): `auto-pr-opened` (PR #12 → the turn →
a "Review PR #12" chat on uno-work → "Asks first": the Allow card "Comment on PR #12
in getuno/web" + Needs you; "Does it itself": commented at once), `auto-pr-twice`
(two pushes: the first `superseded`, one run), `auto-asleep` (the run waits —
"Waiting — uno-work is asleep…" — ~15 s at speed 1, then runs). The phrase "every
time a PR comes to owner/x, review it" (or «каждый раз, когда приходит PR …») in an
assistant's chat makes one: the "Automation created · When … · Open" card comes
from the `automation_create` tool call's result (`MessagesTimeline` → `AutomationCreatedCard`).

Flows: `demo-e2e/flows/automations.flow.mjs` (`node demo-e2e/run.mjs auto-`; one at 390 px).

Known gaps: the demo doesn't fake "Join my calls", so "After a call" always shows
the hint to turn it on; Gmail is "Soon" only; a run's "Open chat" goes to the
assistant's main chat (the daemon's "Automations" thread for personas isn't faked).

## Multi-computer base (branch `demo/multi-computer-1028`)

Misha 28.10: "the interface is tied to one computer while the sidebar piles
every computer's chats together; computers keep falling off". The base for
the variants (A spaces, B computers on Home, C computers top-right, D all +
focus), each in `demo/multi-computer-<x>-1028`:

- World params: `mac=online|asleep|flaky|offline` (flaky: the MacBook's socket
  drops ~8 s every ~45 s, first ~20 s after start), `load=normal|busy`
  (uno-work CPU ~90 %, disk 151/160 GB).
- `assist/links.ts`: the link per computer — `window.__mcDemo.drop("mac", 10)`,
  `__mcDemo.wake("product")` (the asleep Free computer turns "running" in the
  account), `__mcDemo.up(key)`. The real reconnect logic of the page reacts.
- `assist/metrics.ts`: each computer's live load (`uno.computer.localMetrics`), moving.
- `assist/fixtures.ts`: a chat at work on uno-work ("Add refunds…") and on the
  MacBook ("Rename screenshots…").
- `assist/mcVariant.ts`: the variant's id/title/hint for the "what to look at" card.
- Heavy jobs one at a time: `/tmp/mc-heavy.sh <cmd>` (vite build, tsc).
