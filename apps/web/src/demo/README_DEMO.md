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
"Does it itself" runs it, "Asks first" shows the real Allow card + an Inbox card,
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
