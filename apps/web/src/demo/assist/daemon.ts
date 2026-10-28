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
import { automationHandlers, resetAutomations } from "./automations";
import { type DemoPersona, assistantsOn } from "./fixtures";
import { startedByOn } from "./startedBy";
import {
  type AssistWorld,
  CONNECTOR_PROVIDERS,
  type ConnectorProvider,
  type ConnectorState,
  macOnline,
} from "./world";

// ── Per assistant: what its daemon keeps ─────────────────────────────────

interface AssistantRecord {
  persona: DemoPersona;
  /** Its picture (base64 WebP/PNG), or its emoji. */
  avatar: string | null;
  preset: AssistantPreset;
  projects: "all" | ReadonlyArray<string>;
  telegram: boolean;
  team: ManagerAssistantTeam;
  apps: Record<string, "none" | "read" | "write">;
  revokedAt: string | null;
  createdAt: string;
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
  // A second apart, in the order they were added (the sidebar sorts by it).
  const createdAt = new Date(
    Date.now() - 86_400_000 * (world.account === "live" ? 30 : 0) - (1000 - records.size) * 1000,
  ).toISOString();
  records.set(recordKey(machine, persona.projectId), {
    persona,
    avatar: null,
    preset: world.mode === "asks-first" ? "helper" : "full",
    projects: "all",
    // Uno on uno-work is the one Telegram talks to.
    telegram:
      world.telegram === "on" && persona.projectId === ASSISTANT_PROJECT_ID && machine === "work",
    team: teamOf(persona, createdAt),
    apps: {},
    revokedAt: null,
    createdAt,
  });
}

function recordOf(machine: MachineKey, projectId: string): AssistantRecord | null {
  return records.get(recordKey(machine, projectId)) ?? null;
}

function summaryOf(machine: DemoMachine, record: AssistantRecord): ManagerAssistantSummary {
  // Variant D: one Telegram bot for the account — Uno's; the personas write there under their names.
  const linked = telegramLinked(machine.key, record.persona.projectId);
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
      configured: linked,
      enabled: linked,
      allowedChatIds: linked ? ["100200300"] : [],
      botUsername: linked ? "uno_team_bot" : null,
      lastError: null,
      health: linked
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
      avatar: record.avatar ? `avatar-${record.avatar.length}-${record.avatar.slice(-8)}` : null,
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
        // The console marks a connection whose sign-in Google ended (variant D: the real list shows it).
        needsReconnect: state === "expired",
        account: connected ? CONNECTOR_META[provider].account : null,
        connectedAt: connected ? new Date(Date.now() - 86_400_000 * 12).toISOString() : null,
        toolCount: connected ? 12 : 0,
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
  resetAutomations({ world });
}

export function personaOf(machine: MachineKey, projectId: string): DemoPersona | null {
  return recordOf(machine, projectId)?.persona ?? null;
}

/** Its preset (Full = "Autonomous", Helper/Observer = "Cautious"); null: not an assistant. */
/** Assistants the person set up on the setup screen (`setup: "done"` from the page). */
const setUpByPerson = new Set<string>();

/** The person finished its setup screen (Uno's first click). */
export function setupDone(machine: MachineKey, projectId: string): boolean {
  return setUpByPerson.has(recordKey(machine, projectId));
}

export function presetOf(machine: MachineKey, projectId: string): AssistantPreset | null {
  return recordOf(machine, projectId)?.preset ?? null;
}

export function asksFirst(machine: MachineKey, projectId: string): boolean {
  const record = recordOf(machine, projectId);
  return record !== null && record.preset !== "full";
}

/** The account's one Telegram link: Uno's on uno-work (variant D — personas share it). */
function telegramRecord(machine: MachineKey, projectId: string): AssistantRecord | null {
  if (projectId !== ASSISTANT_PROJECT_ID) return recordOf("work", ASSISTANT_PROJECT_ID);
  return recordOf(machine, projectId);
}

export function telegramLinked(machine: MachineKey, projectId: string): boolean {
  return telegramRecord(machine, projectId)?.telegram === true;
}

export function setTelegram(machine: MachineKey, projectId: string, linked: boolean) {
  const record = telegramRecord(machine, projectId);
  if (record) record.telegram = linked;
}

/** Its mode from a chat card: "Autonomous" = Full, "Cautious" = Helper. */
export function setMode(machine: MachineKey, projectId: string, mode: "itself" | "asks-first") {
  const record = recordOf(machine, projectId);
  if (record) record.preset = mode === "asks-first" ? "helper" : "full";
}

/** What the person removed (the engine stops its scripts), or brought back. */
let onRevoked: (machine: MachineKey, projectId: string, revoked: boolean) => void = () => {};
export function onAssistantRevoked(
  listener: (machine: MachineKey, projectId: string, revoked: boolean) => void,
) {
  onRevoked = listener;
}

/** Its mode changed from the page or the chat chip: its chats follow (demoBoot). */
let onModeChanged: (machine: MachineKey, projectId: string) => void = () => {};
export function onAssistantModeChanged(listener: (machine: MachineKey, projectId: string) => void) {
  onModeChanged = listener;
}

/** A drawn portrait failing (variant D's edge flow: `?facegen=fail`). */
let portraitsFail = false;
export function setPortraitsFail(fail: boolean) {
  portraitsFail = fail;
}

const PORTRAIT_SKIN = ["#f6d3b3", "#e0ac83", "#c68642", "#8d5524", "#f1c27d"];
const PORTRAIT_BG = [
  ["#fde68a", "#f59e0b"],
  ["#bfdbfe", "#3b82f6"],
  ["#bbf7d0", "#10b981"],
  ["#fbcfe8", "#ec4899"],
  ["#ddd6fe", "#8b5cf6"],
];

/** A friendly portrait (made-up "Uno AI" drawing): a face in one flat style, per kind and seed. */
export function drawPortrait(persona: string, seed: number): string {
  const bg = PORTRAIT_BG[seed % PORTRAIT_BG.length]!;
  const skin =
    persona === "robot"
      ? "#cbd5e1"
      : persona === "alien"
        ? "#86efac"
        : persona === "animal"
          ? ["#f59e0b", "#a16207", "#d6d3d1", "#fb923c"][seed % 4]!
          : PORTRAIT_SKIN[seed % PORTRAIT_SKIN.length]!;
  const ears =
    persona === "animal"
      ? `<path d="M70 70 L88 30 L104 74 Z" fill="${skin}"/><path d="M186 70 L168 30 L152 74 Z" fill="${skin}"/>`
      : persona === "robot"
        ? `<rect x="122" y="28" width="12" height="30" fill="#64748b"/><circle cx="128" cy="26" r="9" fill="#ef4444"/>`
        : persona === "alien"
          ? `<circle cx="84" cy="44" r="10" fill="${skin}"/><circle cx="172" cy="44" r="10" fill="${skin}"/>`
          : `<path d="M62 112 Q64 40 128 38 Q192 40 194 112 Q170 70 128 72 Q86 70 62 112 Z" fill="${["#3f2a1d", "#111827", "#b45309", "#7c2d12", "#6b7280"][seed % 5]}"/>`;
  const face =
    persona === "robot"
      ? `<rect x="66" y="66" width="124" height="120" rx="22" fill="${skin}"/><rect x="88" y="104" width="26" height="18" rx="4" fill="#0ea5e9"/><rect x="142" y="104" width="26" height="18" rx="4" fill="#0ea5e9"/><rect x="100" y="148" width="56" height="8" rx="4" fill="#475569"/>`
      : `<ellipse cx="128" cy="128" rx="64" ry="${persona === "alien" ? 70 : 62}" fill="${skin}"/><ellipse cx="104" cy="122" rx="${persona === "alien" ? 14 : 7}" ry="${persona === "alien" ? 10 : 8}" fill="#1f2937"/><ellipse cx="152" cy="122" rx="${persona === "alien" ? 14 : 7}" ry="${persona === "alien" ? 10 : 8}" fill="#1f2937"/><path d="M104 152 Q128 ${168 + (seed % 3) * 3} 152 152" stroke="#1f2937" stroke-width="6" fill="none" stroke-linecap="round"/><circle cx="92" cy="146" r="8" fill="#f87171" opacity=".35"/><circle cx="164" cy="146" r="8" fill="#f87171" opacity=".35"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg[0]}"/><stop offset="1" stop-color="${bg[1]}"/></linearGradient></defs><rect width="256" height="256" fill="url(#g)"/>${persona === "human" ? "" : ears}${face}${persona === "human" ? ears : ""}<rect x="78" y="196" width="100" height="70" rx="40" fill="#ffffff" opacity=".8"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** Is that computer reachable from the page (asleep ones aren't). */
export function machineAwake(key: MachineKey): boolean {
  if (key === "work") return true;
  if (key === "mac") return macOnline(world);
  return false;
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
    // Automations (28.10): kept per computer in assist/automations.ts.
    ...automationHandlers({
      machineOf,
      nameOf: (machine, projectId) => recordOf(machine, projectId)?.persona.name ?? null,
    }),
    http.get("*/api/manager/assistants", ({ request }) => {
      const machine = machineOf(request);
      const list = [...records.values()]
        .filter((record) => record.persona.machine === machine.key)
        .map((record) => summaryOf(machine, record));
      return json({ assistants: list, assistantSandbox: true, assistantsEnabled: true });
    }),
    http.get("*/api/manager/assistants/deleted", () => json({ deleted: [] })),
    http.get("*/api/manager/started-by", ({ request }) =>
      json({ items: startedByOn(machineOf(request).key) }),
    ),
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
        tone: typeof body.tone === "string" ? body.tone : "teal",
        roles: [],
        character: "",
        duties: [],
        // Variant D: made in the gallery, it is set up already and writes first in its chat.
        setUp: true,
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
        record.revokedAt = new Date().toISOString();
        onRevoked(machine.key, record.persona.projectId, true);
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
      if (body.setup === "done") {
        team.setup = { ...team.setup, state: "done", updatedAt: new Date().toISOString() };
        setUpByPerson.add(recordKey(machine.key, record.persona.projectId));
      }
      if (body.setup === "again")
        team.setup = { ...team.setup, state: "in-progress", answered: [], skipped: [] };
      if (typeof body.emoji === "string") record.persona = { ...record.persona, emoji: body.emoji };
      if (typeof body.tone === "string") record.persona = { ...record.persona, tone: body.tone };
      if (Array.isArray(body.roles))
        record.persona = { ...record.persona, roles: body.roles as string[] };
      if (typeof body.character === "string")
        record.persona = { ...record.persona, character: body.character };
      if (typeof body.name === "string") record.persona = { ...record.persona, name: body.name };
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
      onModeChanged(machine.key, record.persona.projectId);
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
      const revoked = body.revoked !== false;
      if (record) {
        record.revokedAt = revoked ? new Date().toISOString() : null;
        record.team = { ...record.team, revokedAt: record.revokedAt };
        onRevoked(machine.key, record.persona.projectId, revoked);
      }
      return json({ affected: record ? [record.persona.projectId] : [] });
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
      const bytes = Uint8Array.from(atob(record.avatar), (char) => char.charCodeAt(0));
      return new HttpResponse(bytes, { headers: { "content-type": "image/webp" } });
    }),
    http.post("*/api/manager/assistant/avatar/generate", async ({ request }) => {
      const body = await bodyOf(request);
      await new Promise((resolve) => setTimeout(resolve, 900));
      if (portraitsFail) {
        return json({ error: "Uno AI is busy drawing for others" }, { status: 503 });
      }
      return json({
        image: drawPortrait(String(body.persona ?? "human"), Number(body.seed ?? 0)),
      });
    }),
    http.post("*/api/manager/assistant/avatar", async ({ request }) => {
      const body = await bodyOf(request);
      const record = recordOf(machineOf(request).key, String(body.projectId ?? ""));
      if (!record) return json({ error: "not found" }, { status: 404 });
      record.avatar = typeof body.image === "string" ? body.image : null;
      return json({ avatar: summaryOf(machineOf(request), record).profile?.avatar ?? null });
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
    // An assistant's own MCP servers (AssistantMcpForm): kept per machine + assistant.
    http.post("*/api/manager/mcp/probe", () =>
      json({ ok: true, toolCount: 6, toolNames: [], needsAuth: false, error: null }),
    ),
    http.get("*/api/manager/assistant/mcp", ({ request }) =>
      json({
        servers: assistantMcp.get(`${machineOf(request).key}:${projectParam(request)}`) ?? [],
      }),
    ),
    http.post("*/api/manager/assistant/mcp", async ({ request }) => {
      const body = await bodyOf(request);
      const key = `${machineOf(request).key}:${String(body.projectId ?? "")}`;
      const servers = assistantMcp.get(key) ?? [];
      let host = "";
      try {
        host = new URL(String(body.url ?? "")).host;
      } catch {
        return json(
          { error: "Paste the server’s https:// address.", code: "invalid_url" },
          { status: 400 },
        );
      }
      if (servers.some((server) => server.host === host)) {
        return json(
          { error: "This server is already added for this assistant.", code: "duplicate" },
          { status: 400 },
        );
      }
      const name =
        host
          .split(".")
          .filter((part) => part !== "mcp")
          .at(-2) ?? "tool";
      const next = [...servers, { name, host, enabled: true }];
      assistantMcp.set(key, next);
      return json({ name, servers: next });
    }),
    http.delete("*/api/manager/assistant/mcp", ({ request }) => {
      const key = `${machineOf(request).key}:${projectParam(request)}`;
      const name = new URL(request.url).searchParams.get("name");
      const next = (assistantMcp.get(key) ?? []).filter((server) => server.name !== name);
      assistantMcp.set(key, next);
      return json({ servers: next });
    }),
  ];
}

/** Demo: servers given to one assistant, by `<machine>:<projectId>`. */
const assistantMcp = new Map<
  string,
  ReadonlyArray<{ readonly name: string; readonly host: string; readonly enabled: boolean }>
>();

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
      list.push(wire(MACHINES.product.boxId!, MACHINES.product.label, "sleeping", "free"));
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

/** The assistants on uno-work that are not removed (the morning summary's lines, variant D). */
export function activeAssistants(machine: MachineKey = "work"): ReadonlyArray<DemoPersona> {
  return [...records.values()]
    .filter((record) => record.persona.machine === machine && record.revokedAt === null)
    .map((record) => record.persona);
}
