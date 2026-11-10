/**
 * Workspace vision (10.11): the account's `/api/v1/workspace` answered in the
 * page — Misha's made-up workspace as one "liquid computer": uno-work (cloud,
 * always on), the MacBook (local), free-cloud (asleep), later a Raspberry Pi
 * that joins; Spark functions, data, Drive, git and addresses; four apps and
 * the three assistants with their hands. The real screens (src/workspace/*)
 * read it through the same account client as everything else.
 *
 * `window.__wsDemo`: `join()` — a Raspberry Pi joins; `sleep(id)`, `offline(id)`,
 * `wake(id)`, `state()` — for the "what to look at" card and Playwright.
 */
import { HttpResponse, http, type HttpHandler } from "msw";

import { MACHINES } from "../heavyFixtures";
import type { ComputerState, Workspace, WsAssistant, WsComputer } from "../../workspace/model";
import { addScene } from "./engine";
import { wakeComputer } from "./links";
import { WORLD } from "./world";

const WAKE_MS = 2200;

function macState(): ComputerState {
  if (WORLD.account !== "live") return "offline";
  return WORLD.mac === "asleep" ? "asleep" : WORLD.mac === "offline" ? "offline" : "running";
}

const computers: WsComputer[] = [
  {
    id: "uno-work",
    name: "uno-work",
    kind: "cloud",
    state: "running",
    detail: "Plus · 16 GB",
    place: "Amsterdam",
    environmentId: MACHINES.work.environmentId,
  },
  {
    id: "macbook",
    name: "MacBook",
    kind: "local",
    state: macState(),
    detail: "MacBook Air · your desk",
    place: "Your desk",
    environmentId: MACHINES.mac.environmentId,
  },
  {
    id: "free-cloud",
    name: "free-cloud",
    kind: "cloud",
    state: "asleep",
    detail: "Free · 4 GB · sleeps when idle",
    place: "Amsterdam",
    environmentId: MACHINES.product.environmentId,
  },
];

const parts: Workspace["parts"] = [
  {
    id: "fn-orders-hook",
    kind: "spark",
    name: "orders-webhook",
    detail: "JavaScript · 41k calls this month",
    on: null,
  },
  {
    id: "fn-signup",
    kind: "spark",
    name: "signup-form",
    detail: "JavaScript · 312 calls",
    on: null,
  },
  {
    id: "fn-digest",
    kind: "spark",
    name: "daily-digest",
    detail: "Python · every day 08:00",
    on: null,
  },
  {
    id: "db-orders",
    kind: "database",
    name: "orders",
    detail: "Postgres · 1.2 GB",
    on: "uno-work",
  },
  { id: "kv-sessions", kind: "kv", name: "sessions", detail: "Uno KV · 8k keys", on: null },
  { id: "db-stats", kind: "database", name: "stats", detail: "SQLite · 40 MB", on: "free-cloud" },
  { id: "drive", kind: "drive", name: "Uno Drive", detail: "12.4 GB of 100 GB", on: null },
  {
    id: "git-landing",
    kind: "git",
    name: "landing",
    detail: "github.com/misha-demo/landing",
    on: null,
  },
  {
    id: "git-bot",
    kind: "git",
    name: "orders-bot",
    detail: "github.com/misha-demo/orders-bot",
    on: null,
  },
  {
    id: "git-deck",
    kind: "git",
    name: "pitch-deck",
    detail: "github.com/misha-demo/pitch-deck",
    on: null,
  },
  { id: "ip-de", kind: "address", name: "82.38.220.7", detail: "Clean IP · Germany", on: null },
  { id: "dom-orders", kind: "address", name: "orders.uno4.me", detail: "Address", on: null },
  {
    id: "dom-landing",
    kind: "address",
    name: "landing-misha.uno4.me",
    detail: "Address",
    on: null,
  },
];

const apps: Workspace["apps"] = [
  {
    id: "orders",
    name: "Orders dashboard",
    icon: "📦",
    url: "https://orders.uno4.me",
    uses: [
      { ref: "uno-work", role: "runs", detail: "node server.js · :3000" },
      { ref: "fn-orders-hook", role: "calls" },
      { ref: "db-orders", role: "stores" },
      { ref: "drive", role: "files", detail: "/exports" },
      { ref: "dom-orders", role: "answers" },
    ],
  },
  {
    id: "landing",
    name: "Landing",
    icon: "🌐",
    url: "https://landing-misha.uno4.me",
    uses: [
      { ref: "fn-signup", role: "calls" },
      { ref: "kv-sessions", role: "stores" },
      { ref: "dom-landing", role: "answers" },
    ],
  },
  {
    id: "stats",
    name: "Stats board",
    icon: "📊",
    url: "https://stats-misha.uno4.me",
    uses: [
      { ref: "free-cloud", role: "runs", detail: "python app.py · :8080" },
      { ref: "db-stats", role: "stores" },
      { ref: "ip-de", role: "answers", detail: "goes out via Germany" },
    ],
  },
  {
    id: "deck",
    name: "Deck preview",
    icon: "🖼️",
    url: "http://macbook.local:5173",
    uses: [
      { ref: "macbook", role: "runs", detail: "npm run dev · :5173" },
      { ref: "git-deck", role: "files" },
    ],
  },
];

const assistants: WsAssistant[] = [
  {
    id: "uno",
    name: "Uno",
    hands: ["uno-work", "macbook"],
    wakes: true,
    telegram: WORLD.telegram === "on",
  },
  { id: "mia", name: "Mia", hands: ["uno-work"], wakes: true, telegram: false },
  { id: "bolt", name: "Bolt", hands: ["uno-work", "macbook"], wakes: false, telegram: false },
];

/** Where each chat's next turn runs, by thread id (absent: its own computer). */
const chatPicks = new Map<string, string | null>();

function setState(id: string, state: ComputerState) {
  const at = computers.findIndex((computer) => computer.id === id);
  if (at >= 0) computers[at] = { ...computers[at]!, state };
}

function wake(id: string): boolean {
  const computer = computers.find((item) => item.id === id);
  if (!computer || computer.kind !== "cloud" || computer.state !== "asleep") return false;
  setState(id, "waking");
  // free-cloud's daemon answers the page too once it's up (the account sees it running).
  if (id === "free-cloud") wakeComputer("product", WAKE_MS / 1000);
  setTimeout(() => setState(id, "running"), WAKE_MS);
  return true;
}

function join() {
  if (computers.some((computer) => computer.id === "raspberry-pi")) return;
  computers.push({
    id: "raspberry-pi",
    name: "raspberry-pi",
    kind: "local",
    state: "running",
    detail: "Raspberry Pi 5 · 8 GB",
    place: "Home shelf",
    environmentId: null,
    isNew: true,
  });
}

function snapshot(): Workspace {
  return {
    id: "ws-misha",
    name: "Misha",
    cloud: { region: "EU · Amsterdam" },
    computers: computers.map((computer) => ({ ...computer })),
    parts,
    apps,
    assistants: assistants.map((assistant) => ({ ...assistant })),
  };
}

export function workspaceHandlers(): HttpHandler[] {
  return [
    http.get("*/_account/api/v1/workspace", () => HttpResponse.json(snapshot())),
    http.post("*/_account/api/v1/workspace/computers/:id/wake", ({ params }) =>
      wake(String(params.id))
        ? HttpResponse.json({ state: "waking" })
        : HttpResponse.json({ error: "not asleep" }, { status: 409 }),
    ),
    http.post("*/_account/api/v1/workspace/computers/:id/welcome", async ({ params, request }) => {
      const body = (await request.json()) as { assistants?: string[] };
      const id = String(params.id);
      const at = computers.findIndex((computer) => computer.id === id);
      if (at < 0) return HttpResponse.json({}, { status: 404 });
      computers[at] = { ...computers[at]!, isNew: false };
      assistants.forEach((assistant, index) => {
        if (body.assistants?.includes(assistant.id) && !assistant.hands.includes(id))
          assistants[index] = { ...assistant, hands: [...assistant.hands, id] };
      });
      return HttpResponse.json(snapshot());
    }),
    http.put("*/_account/api/v1/workspace/assistants/:id", async ({ params, request }) => {
      const body = (await request.json()) as { hands: string[]; wakes: boolean };
      const at = assistants.findIndex((assistant) => assistant.id === String(params.id));
      if (at < 0) return HttpResponse.json({}, { status: 404 });
      assistants[at] = { ...assistants[at]!, hands: body.hands, wakes: body.wakes };
      return HttpResponse.json(assistants[at]);
    }),
    http.post("*/_account/api/v1/workspace/apps/:id/open", ({ params }) => {
      const app = apps.find((item) => item.id === String(params.id));
      if (!app) return HttpResponse.json({}, { status: 404 });
      for (const use of app.uses) {
        const host =
          computers.find((computer) => computer.id === use.ref) ??
          computers.find(
            (computer) => computer.id === parts.find((part) => part.id === use.ref)?.on,
          );
        if (host) wake(host.id);
      }
      // In the demo the apps' pages are served by the build itself.
      const page =
        app.id === "landing" ? "/demo-site/index.html" : `/demo-site/apps/${app.id}.html`;
      return HttpResponse.json({ url: new URL(page, location.origin).toString() });
    }),
    http.post("*/_account/api/v1/workspace/apps/:id/move", () =>
      HttpResponse.json({ started: true }),
    ),
    http.get("*/_account/api/v1/workspace/chats/:threadId", ({ params }) =>
      HttpResponse.json({ computer: chatPicks.get(String(params.threadId)) ?? null }),
    ),
    http.put("*/_account/api/v1/workspace/chats/:threadId", async ({ params, request }) => {
      const body = (await request.json()) as { computer: string | null };
      chatPicks.set(String(params.threadId), body.computer);
      return HttpResponse.json({ computer: body.computer });
    }),
  ];
}

/** Hooks for the panel and Playwright. */
export function startWorkspaceDemo() {
  const api = {
    join,
    wake,
    sleep: (id: string) => setState(id, "asleep"),
    offline: (id: string) => setState(id, "offline"),
    up: (id: string) => setState(id, "running"),
    state: snapshot,
  };
  (window as unknown as { __wsDemo: typeof api }).__wsDemo = api;
  addWorkspaceScenes();
}

// ── Scenes for the "what to look at" card and the flows ──────────────────

/** Registered at start (after variant.ts has picked its scenes). */
function addWorkspaceScenes() {
  addScene({
    id: "ws-tg-asleep",
    title: "Workspace: Telegram, когда все компьютеры спят",
    hint: "Все компьютеры спят. Uno отвечает в Telegram сразу — голова в workspace; для сборки сам будит uno-work.",
    run: ({ ops, target, play }) => {
      for (const computer of computers)
        if (computer.state === "running")
          setState(computer.id, computer.kind === "cloud" ? "asleep" : "offline");
      ops.userSays(target.machine, target.threadId, "📱 Telegram: what's on today?");
      void play([
        {
          say: "Two calls: Acme at 11:00 and Brightline at 15:30. Acme's invoice is 5 days late. (Every computer is asleep — I answered from your workspace.)",
        },
        {
          run: (ctx) =>
            ctx.ops.userSays(
              ctx.machine,
              ctx.threadId,
              "📱 Telegram: rebuild the landing and send me the link",
            ),
          delay: 1500,
        },
        { run: () => void wake("uno-work") },
        { work: "Waking uno-work — about 2 seconds…" },
        { work: "Building landing on uno-work…", delay: 2400 },
        {
          say: "Done: landing-misha.uno4.me is updated. uno-work goes back to sleep when it's idle.",
        },
      ]);
    },
  });

  addScene({
    id: "ws-join",
    title: "Workspace: Raspberry Pi подключился",
    hint: "Новый компьютер входит в workspace: в «Железе» один вопрос — дать ли Uno им пользоваться.",
    run: () => join(),
  });

  addScene({
    id: "ws-mac-away",
    title: "Workspace: MacBook закрыли",
    hint: "MacBook уходит офлайн: Deck preview честно «ждёт MacBook», Uno работает на uno-work.",
    run: () => setState("macbook", "offline"),
  });
}
