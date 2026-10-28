/**
 * The assistants base (28.10): what each computer's daemon answers for the
 * real assistant screens (`/api/manager/assistant*`, connectors, Telegram)
 * and what the Uno account answers (`/_account/*`: who's signed in, the
 * computers, the plan) — kept in memory, in the wire shapes of
 * `@t3tools/contracts`, so the real code runs as against a real computer.
 *
 * Asleep computers (the MacBook when `mac=asleep`, the Free cloud computer)
 * don't answer at all: the page sees them offline as it would.
 */
import {
  ASSISTANT_PROJECT_ID,
  type AssistantPreset,
  DEFAULT_CONNECTOR_ADDRESSING,
  type ManagerAssistantSummary,
  type ManagerAssistantTeam,
  type ManagerScope,
  type ProjectId,
} from "@t3tools/contracts";
import { presetTokenAccess } from "@t3tools/shared/assistantPreset";
import { HttpResponse, http, type HttpHandler } from "msw";

import { MACHINES, PROJECTS, type DemoMachine, type MachineKey } from "../heavyFixtures";
import { type DemoPersona, assistantsOn } from "./fixtures";
import {
  type AssistWorld,
  CONNECTOR_PROVIDERS,
  type ConnectorProvider,
  type ConnectorState,
  macOnline,
  thirdOnline,
} from "./world";

// ── Per assistant: what its daemon keeps ─────────────────────────────────

interface AssistantRecord {
  persona: DemoPersona;
  preset: AssistantPreset;
  projects: "all" | ReadonlyArray<string>;
  telegram: boolean;
  team: ManagerAssistantTeam;
  apps: Record<string, "none" | "read" | "write">;
  revokedAt: string | null;
  createdAt: string;
  /** Its picture (base64 + type), set from the face picker / the builder. */
  avatar: { base64: string; type: string } | null;
  /** Variant A: the computers it may use as its hands (keys); null = every one. */
  hands: ReadonlyArray<MachineKey> | null;
}

const records = new Map<string, AssistantRecord>();
const recordKey = (machine: MachineKey, projectId: string) => `${machine}:${projectId}`;
let world: AssistWorld;

function teamOf(persona: DemoPersona, createdAt: string): ManagerAssistantTeam {
  return {
    name: persona.projectId === ASSISTANT_PROJECT_ID ? null : persona.name,
    tone: persona.tone,
    roles: [...persona.roles],
    character: persona.character,
    skills: [],
    channel: null,
    createdBy: null,
    createdAt,
    setup: {
      state: persona.setUp ? "done" : "not-started",
      answered: [],
      skipped: [],
      threadId: null,
      updatedAt: persona.setUp ? createdAt : null,
    },
    firstTask: null,
    duties: [...persona.duties],
    mail: { enabled: false, recipients: "owner", allow: [], dailyLimit: 20 },
    worksOnWish: null,
    revokedAt: null,
    pausedAt: null,
    activity: [],
  };
}

function addRecord(machine: MachineKey, persona: DemoPersona) {
  const createdAt = new Date(
    Date.now() - 86_400_000 * (world.account === "live" ? 30 : 0),
  ).toISOString();
  records.set(recordKey(machine, persona.projectId), {
    persona,
    preset: world.mode === "asks-first" ? "helper" : "full",
    projects: "all",
    // Uno on uno-work is the one Telegram talks to.
    telegram:
      world.telegram === "on" && persona.projectId === ASSISTANT_PROJECT_ID && machine === "work",
    team: teamOf(persona, createdAt),
    apps: {},
    revokedAt: null,
    createdAt,
    avatar: null,
    hands: null,
  });
}

function recordOf(machine: MachineKey, projectId: string): AssistantRecord | null {
  return records.get(recordKey(machine, projectId)) ?? null;
}

/** Removed / brought back: its token and its team record say so. */
function setRevoked(record: AssistantRecord, revoked: boolean) {
  record.revokedAt = revoked ? new Date().toISOString() : null;
  record.team = { ...record.team, revokedAt: record.revokedAt };
}

function summaryOf(machine: DemoMachine, record: AssistantRecord): ManagerAssistantSummary {
  const access = presetTokenAccess(
    record.preset,
    record.projects as never,
    record.persona.projectId,
  );
  const project = PROJECTS[machine.key].find((item) => item.id === record.persona.projectId);
  return {
    projectId: record.persona.projectId as ProjectId,
    title: project?.title ?? record.persona.name,
    workspaceRoot:
      project?.root ?? `${machine.home}/UnoWork/Assistants/${record.persona.projectId}`,
    token: {
      tokenId: `tok-${machine.key}-${record.persona.projectId}` as never,
      label: `${record.persona.name} (assistant)`,
      scopes: access.scopes as ReadonlyArray<ManagerScope>,
      projectAllowlist: access.projectAllowlist,
      budget: null,
      autoApprove: access.autoApprove,
      createdAt: record.createdAt,
      revokedAt: record.revokedAt,
    },
    telegram: {
      configured: record.telegram,
      enabled: record.telegram,
      allowedChatIds: record.telegram ? ["100200300"] : [],
      botUsername: record.telegram ? "uno_team_bot" : null,
      lastError: null,
      health: record.telegram
        ? { status: "ok", lastOkAt: new Date().toISOString(), lastError: null, lastErrorAt: null }
        : null,
      defaultModelSelection: null,
      addressing: DEFAULT_CONNECTOR_ADDRESSING,
      shared: true,
    },
    slack: {
      configured: false,
      enabled: false,
      allowedChannelIds: [],
      botUserId: null,
      botUserName: null,
      lastError: null,
      defaultModelSelection: null,
      addressing: DEFAULT_CONNECTOR_ADDRESSING,
      shared: false,
    },
    skills: [],
    profile: {
      emoji: record.persona.emoji,
      template: null,
      createdAt: record.createdAt,
      avatar: record.avatar ? `v${record.avatar.base64.length}` : null,
    },
    team: {
      team: record.team,
      apps: { permissions: record.apps, restricted: Object.keys(record.apps).length > 0 },
    },
  } as ManagerAssistantSummary;
}

// ── Connectors (the account's, same on every computer) ───────────────────

const connectorStates = new Map<ConnectorProvider, ConnectorState>();
const connectingSince = new Map<ConnectorProvider, number>();

export function connectorState(provider: ConnectorProvider): ConnectorState {
  const started = connectingSince.get(provider);
  // The person finished Google's page ~2 s after Connect (demo-oauth).
  if (started !== undefined && Date.now() - started > 1_800) {
    connectorStates.set(provider, "on");
    connectingSince.delete(provider);
  }
  return connectorStates.get(provider) ?? "off";
}

const CONNECTOR_META: Record<
  ConnectorProvider,
  { name: string; description: string; account: string }
> = {
  gmail: {
    name: "Gmail & Calendar",
    description: "Reads, drafts and sends mail, can move it to Trash; reads your calendar.",
    account: "misha@example.com",
  },
  "google-drive": {
    name: "Google Drive",
    description: "Only files Uno created or you picked for it — not your whole Drive.",
    account: "misha@example.com",
  },
  notion: {
    name: "Notion",
    description: "Only the pages you shared with Uno; reads and edits them.",
    account: "Misha's workspace",
  },
  github: {
    name: "GitHub",
    description: "Reads and pushes to all your repos, private ones too; issues and PRs.",
    account: "misha-demo",
  },
};

function connectorsList() {
  return {
    available: true,
    reason: null,
    connectors: CONNECTOR_PROVIDERS.map((provider) => {
      const state = connectorState(provider);
      // "expired" is listed as connected: the console learns it on the next call.
      const connected = state !== "off";
      return {
        provider,
        ...CONNECTOR_META[provider],
        available: true,
        connected,
        account: connected ? CONNECTOR_META[provider].account : null,
        connectedAt: connected ? new Date(Date.now() - 86_400_000 * 12).toISOString() : null,
        toolCount: connected ? 12 : 0,
        // Variant A: the list says the sign-in ended (the console would learn it on a failed call).
        ...(state === "expired" ? { needsReconnect: true } : {}),
      };
    }),
  };
}

// ── Public: what the engine and the boot need ────────────────────────────

export function startDaemons(input: { readonly world: AssistWorld }) {
  world = input.world;
  records.clear();
  for (const provider of CONNECTOR_PROVIDERS)
    connectorStates.set(provider, world.connectors[provider]);
  for (const key of Object.keys(MACHINES) as MachineKey[]) {
    for (const persona of assistantsOn(key, world)) addRecord(key, persona);
  }
}

export function personaOf(machine: MachineKey, projectId: string): DemoPersona | null {
  return recordOf(machine, projectId)?.persona ?? null;
}

/** Its preset (Full = "Does it itself", Helper/Observer = "Asks first"); null: not an assistant. */
export function presetOf(machine: MachineKey, projectId: string): AssistantPreset | null {
  return recordOf(machine, projectId)?.preset ?? null;
}

export function asksFirst(machine: MachineKey, projectId: string): boolean {
  const record = recordOf(machine, projectId);
  return record !== null && record.preset !== "full";
}

/** Variant A: its mode from a card in its chat. */
export function setPresetOf(machine: MachineKey, projectId: string, preset: AssistantPreset) {
  const record = recordOf(machine, projectId);
  if (record) record.preset = preset;
}

export function telegramLinked(machine: MachineKey, projectId: string): boolean {
  return recordOf(machine, projectId)?.telegram === true;
}

export function setTelegram(machine: MachineKey, projectId: string, linked: boolean) {
  const record = recordOf(machine, projectId);
  if (record) record.telegram = linked;
}

/** Is that computer reachable from the page (asleep ones aren't). */
export function machineAwake(key: MachineKey): boolean {
  if (key === "work") return true;
  if (key === "mac") return macOnline(world);
  return thirdOnline(world);
}

/** Variant A: may that assistant use that computer as its hands. */
export function handAllowed(projectId: string, key: MachineKey): boolean {
  const record = recordOf("work", projectId);
  return record?.hands == null || record.hands.includes(key);
}

/** Revoked (removed) — its running work stops. */
export function isGone(machine: MachineKey, projectId: string): boolean {
  const record = recordOf(machine, projectId);
  return record === null || record.revokedAt !== null;
}

// ── Its memory files (NOTES.md, AGENTS.md…) ─────────────────────────────

const files = new Map<string, string>();
function defaultFile(projectId: string, name: string | null): string {
  if (projectId !== ASSISTANT_PROJECT_ID || world.account !== "live") return "";
  if (name === "AGENTS.md") {
    return "You are Misha's personal assistant. Take tasks only from Misha.\nRun work in chats on his computers; write to him only when he is needed.";
  }
  if (name === "NOTES.md" || name === null) {
    return "- Acme pays late; a gentle reminder after 5 days\n- Morning summary goes to Telegram at 08:00\n- The pitch deck lives on the MacBook";
  }
  return "";
}

// ── Portraits (made up, for the face picker) ─────────────────────────────

const PORTRAIT_FACES: Record<string, ReadonlyArray<string>> = {
  human: ["🧑‍💼", "👩‍💻", "🧑‍🎨", "👨‍🔬", "👩‍🏫"],
  animal: ["🦊", "🦉", "🐼", "🐯", "🐨"],
  robot: ["🤖", "🦾", "👾", "🛰️", "⚙️"],
  alien: ["👽", "🛸", "🪐", "🌌", "✨"],
};
const PORTRAIT_SKIES: ReadonlyArray<readonly [string, string]> = [
  ["#fde68a", "#f59e0b"],
  ["#bfdbfe", "#6366f1"],
  ["#bbf7d0", "#14b8a6"],
  ["#fbcfe8", "#ec4899"],
  ["#e9d5ff", "#8b5cf6"],
];

/** A soft round portrait: a gradient and a character — as a data: URL (SVG). */
function portrait(persona: string, seed: number): string {
  const faces = PORTRAIT_FACES[persona] ?? PORTRAIT_FACES.human!;
  const face = faces[Math.abs(seed) % faces.length]!;
  const [from, to] = PORTRAIT_SKIES[Math.abs(seed + persona.length) % PORTRAIT_SKIES.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="256" height="256" fill="url(#g)"/><circle cx="128" cy="300" r="150" fill="rgba(255,255,255,.35)"/><text x="128" y="160" font-size="128" text-anchor="middle">${face}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

// ── The handlers ─────────────────────────────────────────────────────────

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "assistant";

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  return ((await request.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
}

export interface DaemonHooks {
  readonly machineForHost: (host: string) => DemoMachine;
  /** The assistant's folder appears on that computer (project.create). */
  readonly addProject: (
    machine: DemoMachine,
    project: { id: string; title: string; workspaceRoot: string },
  ) => void;
  /** Its main chat: found, or made now (the engine greets in a new one). */
  readonly ensureChat: (
    machine: DemoMachine,
    projectId: string,
  ) => { threadId: string; created: boolean };
  /** A new conversation in its folder (the engine greets). */
  readonly newConversation: (machine: DemoMachine, projectId: string, title: string) => string;
  /** The setup chat of a new assistant. */
  readonly setupChat: (machine: DemoMachine, projectId: string) => string;
  /** Variant A: it was removed — its running chats stop. */
  readonly onRevoked: (machine: DemoMachine, projectId: string) => void;
  /** Variant A: its mode changed — its chats switch to it. */
  readonly onPreset: (machine: DemoMachine, projectId: string) => void;
}

export function daemonHandlers(hooks: DaemonHooks): HttpHandler[] {
  const machineOf = (request: Request) => hooks.machineForHost(new URL(request.url).host);
  const projectParam = (request: Request) =>
    new URL(request.url).searchParams.get("projectId") ?? ASSISTANT_PROJECT_ID;
  const asleepHosts = (Object.keys(MACHINES) as MachineKey[])
    .filter((key) => !machineAwake(key))
    .map((key) => MACHINES[key].host)
    .filter((host) => host !== "");
  const json = HttpResponse.json;
  const summary = (machine: DemoMachine, projectId: string) => {
    const record = recordOf(machine.key, projectId);
    return record
      ? json(summaryOf(machine, record))
      : json({ error: "not found" }, { status: 404 });
  };
  return [
    // An asleep computer: no answer at all (the page shows it offline).
    http.all(
      ({ request }) => asleepHosts.includes(new URL(request.url).host),
      () => HttpResponse.error(),
    ),
    http.get("*/api/manager/assistants", ({ request }) => {
      const machine = machineOf(request);
      // Removed ones stay listed as revoked (the page hides them; "Bring back" works).
      const list = [...records.values()]
        .filter((record) => record.persona.machine === machine.key)
        .map((record) => summaryOf(machine, record));
      return json({ assistants: list, assistantSandbox: true, assistantsEnabled: true });
    }),
    http.get("*/api/manager/assistants/deleted", () => json({ deleted: [] })),
    http.post("*/api/manager/assistants/:projectId/setup-chat", ({ request, params }) =>
      json({ threadId: hooks.setupChat(machineOf(request), String(params.projectId)) }),
    ),
    http.post("*/api/manager/assistants", async ({ request }) => {
      const machine = machineOf(request);
      const body = await bodyOf(request);
      const name =
        typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Assistant";
      let projectId = `assistant-${slugOf(name)}`;
      for (let n = 2; recordOf(machine.key, projectId); n += 1)
        projectId = `assistant-${slugOf(name)}-${n}`;
      const access = body.access as { preset?: AssistantPreset } | undefined;
      const persona: DemoPersona = {
        projectId,
        machine: machine.key,
        name,
        emoji: typeof body.emoji === "string" ? body.emoji : "🙂",
        tone: "teal",
        roles: [],
        character: "",
        duties: [],
        setUp: false,
        chats: [],
      };
      addRecord(machine.key, persona);
      const record = recordOf(machine.key, projectId)!;
      record.createdAt = new Date().toISOString();
      if (access?.preset) record.preset = access.preset;
      else record.preset = world.mode === "asks-first" ? "helper" : "full";
      hooks.addProject(machine, {
        id: projectId,
        title: name,
        workspaceRoot: `${machine.home}/UnoWork/Assistants/${slugOf(name)}`,
      });
      return json({ projectId });
    }),
    http.delete("*/api/manager/assistants", ({ request }) => {
      const machine = machineOf(request);
      const record = recordOf(machine.key, projectParam(request));
      if (record) {
        setRevoked(record, true);
        hooks.onRevoked(machine, record.persona.projectId);
      }
      return json({ ok: true });
    }),
    http.get("*/api/manager/assistant", ({ request }) =>
      summary(machineOf(request), projectParam(request)),
    ),
    http.post("*/api/manager/assistant/chat", async ({ request }) => {
      const body = await bodyOf(request);
      const projectId = typeof body.projectId === "string" ? body.projectId : ASSISTANT_PROJECT_ID;
      const result = hooks.ensureChat(machineOf(request), projectId);
      return json({ threadId: result.threadId, outcome: result.created ? "created" : "existing" });
    }),
    http.post("*/api/manager/assistant/conversations", async ({ request }) => {
      const body = await bodyOf(request);
      const title = typeof body.title === "string" ? body.title : "New chat";
      return json({
        threadId: hooks.newConversation(machineOf(request), ASSISTANT_PROJECT_ID, title),
      });
    }),
    http.post("*/api/manager/assistant/team", async ({ request }) => {
      const machine = machineOf(request);
      const body = await bodyOf(request);
      const record = recordOf(machine.key, String(body.projectId ?? ""));
      if (!record) return json({ error: "not found" }, { status: 404 });
      const team = record.team as {
        -readonly [K in keyof ManagerAssistantTeam]: ManagerAssistantTeam[K];
      };
      for (const field of ["name", "tone", "character"] as const) {
        if (typeof body[field] === "string") (team as Record<string, unknown>)[field] = body[field];
      }
      if (Array.isArray(body.roles)) team.roles = body.roles as string[];
      if (Array.isArray(body.duties)) team.duties = body.duties as string[];
      if (body.setup === "done")
        team.setup = { ...team.setup, state: "done", updatedAt: new Date().toISOString() };
      if (body.setup === "again")
        team.setup = { ...team.setup, state: "in-progress", answered: [], skipped: [] };
      if (typeof body.emoji === "string") record.persona = { ...record.persona, emoji: body.emoji };
      if (typeof body.name === "string") record.persona = { ...record.persona, name: body.name };
      if (typeof body.tone === "string") record.persona = { ...record.persona, tone: body.tone };
      if (typeof body.character === "string")
        record.persona = { ...record.persona, character: body.character };
      if (Array.isArray(body.roles))
        record.persona = { ...record.persona, roles: body.roles as string[] };
      return json({ team: record.team });
    }),
    http.post("*/api/manager/assistant/preset", async ({ request }) => {
      const machine = machineOf(request);
      const body = await bodyOf(request);
      const record = recordOf(machine.key, String(body.projectId ?? ""));
      if (!record) return json({ error: "not found" }, { status: 404 });
      if (typeof body.preset === "string") record.preset = body.preset as AssistantPreset;
      if (body.projects === "all" || Array.isArray(body.projects))
        record.projects = body.projects as never;
      hooks.onPreset(machine, record.persona.projectId);
      return json({ token: summaryOf(machine, record).token, losses: [] });
    }),
    http.post("*/api/manager/assistant/access", async ({ request }) => {
      const machine = machineOf(request);
      const body = await bodyOf(request);
      const record = recordOf(machine.key, String(body.projectId ?? ""));
      if (!record) return json({ error: "not found" }, { status: 404 });
      if (body.projectAllowlist === "all" || Array.isArray(body.projectAllowlist)) {
        record.projects = body.projectAllowlist as never;
      }
      return json({ token: summaryOf(machine, record).token });
    }),
    http.get("*/api/manager/assistant/apps", ({ request }) => {
      const record = recordOf(machineOf(request).key, projectParam(request));
      const permissions = record?.apps ?? {};
      return json({
        permissions,
        restricted: Object.keys(permissions).length > 0,
        enforcedBy: "computer",
      });
    }),
    http.post("*/api/manager/assistant/apps", async ({ request }) => {
      const body = await bodyOf(request);
      const record = recordOf(machineOf(request).key, String(body.projectId ?? ""));
      if (record && body.permissions && typeof body.permissions === "object") {
        record.apps = { ...(body.permissions as Record<string, "none" | "read" | "write">) };
      }
      const permissions = record?.apps ?? {};
      return json({
        permissions,
        restricted: Object.keys(permissions).length > 0,
        enforcedBy: "computer",
        losses: [],
      });
    }),
    http.post("*/api/manager/assistant/revoke", async ({ request }) => {
      const machine = machineOf(request);
      const body = await bodyOf(request);
      const record = recordOf(machine.key, String(body.projectId ?? ""));
      if (record) {
        setRevoked(record, body.revoked !== false);
        if (record.revokedAt) hooks.onRevoked(machine, record.persona.projectId);
      }
      return json({ affected: record ? [record.persona.projectId] : [] });
    }),
    // Variant A: the computers an assistant may use as its hands (new for the daemon).
    http.get("*/api/manager/assistant/computers", ({ request }) => {
      const record = recordOf(machineOf(request).key, projectParam(request));
      return json({
        computers: (Object.keys(MACHINES) as MachineKey[]).map((key) => ({
          key,
          environmentId: MACHINES[key].environmentId,
          label: MACHINES[key].label,
          kind: MACHINES[key].machineKind === "uno_box" ? "cloud" : "computer",
          home: key === record?.persona.machine,
          awake: machineAwake(key),
          allowed: record?.hands == null || record.hands.includes(key),
        })),
      });
    }),
    http.post("*/api/manager/assistant/computers", async ({ request }) => {
      const body = await bodyOf(request);
      const record = recordOf(machineOf(request).key, String(body.projectId ?? ""));
      if (!record) return json({ error: "not found" }, { status: 404 });
      const asked = Array.isArray(body.computers) ? (body.computers as string[]) : [];
      record.hands = (Object.keys(MACHINES) as MachineKey[]).filter(
        (key) =>
          key === record.persona.machine ||
          asked.includes(MACHINES[key].environmentId) ||
          asked.includes(key),
      );
      return json({ ok: true });
    }),
    http.post("*/api/manager/assistant/telegram/pair", async ({ request }) => {
      const machine = machineOf(request);
      const body = await bodyOf(request);
      const projectId = String(body.projectId ?? ASSISTANT_PROJECT_ID);
      const code = `demo${Date.now().toString(36).slice(-4)}`;
      // The person presses Start in the bot a few seconds later.
      setTimeout(() => setTelegram(machine.key, projectId, true), 3_000);
      return json({
        code,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        botUsername: "uno_team_bot",
        link: `https://t.me/uno_team_bot?start=${code}`,
      });
    }),
    http.post("*/api/manager/assistant/telegram", async ({ request }) => {
      const machine = machineOf(request);
      const body = await bodyOf(request);
      const projectId = String(body.projectId ?? ASSISTANT_PROJECT_ID);
      setTelegram(machine.key, projectId, body.enabled !== false);
      const record = recordOf(machine.key, projectId);
      return json({ telegram: record ? summaryOf(machine, record).telegram : null });
    }),
    http.post("*/api/manager/assistant/telegram/test", () =>
      json({ results: [{ chatId: "100200300", ok: true, error: null }] }),
    ),
    http.get("*/api/manager/assistant/mail", () =>
      json({
        address: null,
        enabled: false,
        policy: { enabled: false, recipients: "owner", allow: [], dailyLimit: 20 },
        sentToday: 0,
        letters: [],
      }),
    ),
    http.get("*/api/manager/assistant/file", ({ request }) => {
      const url = new URL(request.url);
      const key = `${machineOf(request).key}:${projectParam(request)}:${url.searchParams.get("name") ?? "NOTES.md"}`;
      return json({
        content: files.get(key) ?? defaultFile(projectParam(request), url.searchParams.get("name")),
      });
    }),
    http.post("*/api/manager/assistant/file", async ({ request }) => {
      const body = await bodyOf(request);
      files.set(
        `${machineOf(request).key}:${String(body.projectId)}:${String(body.name)}`,
        String(body.content ?? ""),
      );
      return json({ ok: true });
    }),
    http.get("*/api/manager/assistant/avatar", ({ request }) => {
      const record = recordOf(machineOf(request).key, projectParam(request));
      if (!record?.avatar) return new HttpResponse(null, { status: 404 });
      const bytes = Uint8Array.from(atob(record.avatar.base64), (char) => char.charCodeAt(0));
      return new HttpResponse(bytes, { headers: { "content-type": record.avatar.type } });
    }),
    http.post("*/api/manager/assistant/avatar", async ({ request }) => {
      const body = await bodyOf(request);
      const record = recordOf(machineOf(request).key, String(body.projectId ?? ""));
      if (!record) return json({ error: "not found" }, { status: 404 });
      record.avatar =
        typeof body.image === "string" && body.image
          ? { base64: body.image, type: body.image.startsWith("UklG") ? "image/webp" : "image/png" }
          : null;
      return json({ avatar: record.avatar ? `v${record.avatar.base64.length}` : null });
    }),
    // A persona portrait "drawn by Uno AI": a made-up picture, or a failure (`face=fail`).
    http.post("*/api/manager/assistant/avatar/generate", async ({ request }) => {
      const body = await bodyOf(request);
      await new Promise((resolve) => setTimeout(resolve, 900));
      if (world.face === "fail") {
        return json({ error: "Uno AI is busy drawing for others right now." }, { status: 503 });
      }
      return json({ image: portrait(String(body.persona ?? "human"), Number(body.seed ?? 0)) });
    }),
    http.get("*/api/manager/assistant/instructions", () => json({ state: "current", content: "" })),
    http.get("*/api/manager/assistant/chats", () => json({ chats: [] })),
    http.get("*/api/manager/connector-bindings", () => json({ bindings: [] })),
    http.get("*/api/manager/connectors", () => json(connectorsList())),
    http.post("*/api/manager/connectors/:provider/start", ({ params }) => {
      const provider = String(params.provider) as ConnectorProvider;
      connectingSince.set(provider, Date.now());
      return json({
        authorizeUrl: `${location.origin}${import.meta.env.BASE_URL}demo-oauth/?provider=${provider}`,
      });
    }),
    http.delete("*/api/manager/connectors/:provider", ({ params }) => {
      const provider = String(params.provider) as ConnectorProvider;
      connectorStates.set(provider, "off");
      connectingSince.delete(provider);
      return json({ ok: true });
    }),
  ];
}

/** The Uno account: who's signed in, its computers, its plan. */
export function accountHandlers(): HttpHandler[] {
  const live = () => world.account === "live";
  const boxes = () => {
    const wire = (id: number, name: string, status: string, plan: string) => ({
      id,
      name,
      status,
      os: "Ubuntu 24.04",
      ram_mb: plan === "plus" ? 16_384 : 4_096,
      vcpu: plan === "plus" ? 8 : 2,
      disk_gb: plan === "plus" ? 160 : 20,
      created_at: new Date(Date.now() - 86_400_000 * 30).toISOString(),
      hostname: `${name}.app.uno4.dev`,
      url: `https://${name}.app.uno4.dev`,
      work_machine: true,
      plan,
    });
    const list = [wire(MACHINES.work.boxId!, MACHINES.work.label, "running", world.tier)];
    if (live())
      list.push(
        wire(
          MACHINES.product.boxId!,
          MACHINES.product.label,
          thirdOnline(world) ? "running" : "sleeping",
          "free",
        ),
      );
    return list;
  };
  return [
    http.get("*/_account/auth/me", () =>
      HttpResponse.json({
        id: 1001,
        username: "misha",
        email: "misha@example.com",
        balance: world.tier === "plus" ? 24.5 : 0,
        llm_balance: 0,
        one_wallet: true,
        role: "user",
        features: ["assistants_mvp"],
      }),
    ),
    http.get("*/_account/api/v1/boxes", () => HttpResponse.json({ boxes: boxes() })),
    http.get("*/_account/api/v1/boxes/:id", ({ params }) => {
      const found = boxes().find((item) => String(item.id) === String(params.id));
      return found ? HttpResponse.json(found) : HttpResponse.json({}, { status: 404 });
    }),
    http.get("*/_account/api/v1/box-subscription", () =>
      HttpResponse.json(
        world.tier === "plus"
          ? {
              plan: "plus",
              status: "active",
              price_usd: 20,
              renews_at: new Date(Date.now() + 86_400_000 * 12).toISOString(),
            }
          : { plan: "free", status: "active", price_usd: 0 },
      ),
    ),
  ];
}
