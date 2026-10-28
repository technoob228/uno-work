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
  avatar?: string | null;
}

const records = new Map<string, AssistantRecord>();
/** Pictures set on an assistant (base64), by computer:folder. */
const avatars = new Map<string, { data: string; type: string }>();

/** A friendly flat portrait, drawn here instead of by Uno AI (SVG, as a `data:` URL). */
function drawFace(persona: string, seed: number): string {
  const hues = [210, 25, 160, 280, 340, 45, 190];
  const hue = hues[Math.abs(seed) % hues.length]!;
  const skin = ["#f2c9a0", "#d9a27a", "#a8724f", "#f5d6b8"][Math.abs(seed) % 4]!;
  const face =
    persona === "robot"
      ? `<rect x="58" y="62" width="140" height="120" rx="28" fill="#cfd8e3"/><circle cx="100" cy="118" r="14" fill="#1e293b"/><circle cx="156" cy="118" r="14" fill="#1e293b"/><rect x="104" y="150" width="48" height="8" rx="4" fill="#1e293b"/><rect x="122" y="36" width="12" height="28" fill="#94a3b8"/><circle cx="128" cy="34" r="9" fill="hsl(${hue} 80% 60%)"/>`
      : persona === "alien"
        ? `<ellipse cx="128" cy="124" rx="70" ry="84" fill="#9be3a8"/><ellipse cx="100" cy="120" rx="18" ry="26" fill="#0f172a"/><ellipse cx="156" cy="120" rx="18" ry="26" fill="#0f172a"/><path d="M110 170 q18 12 36 0" stroke="#0f172a" stroke-width="5" fill="none" stroke-linecap="round"/>`
        : persona === "animal"
          ? `<circle cx="78" cy="70" r="26" fill="#c08457"/><circle cx="178" cy="70" r="26" fill="#c08457"/><circle cx="128" cy="128" r="76" fill="#d79b6b"/><ellipse cx="128" cy="150" rx="34" ry="26" fill="#f4dcc3"/><circle cx="102" cy="116" r="8" fill="#1f2937"/><circle cx="154" cy="116" r="8" fill="#1f2937"/><ellipse cx="128" cy="140" rx="10" ry="7" fill="#1f2937"/>`
          : `<circle cx="128" cy="128" r="70" fill="${skin}"/><path d="M58 118 q4 -70 70 -70 q66 0 70 70 q-30 -34 -70 -34 q-40 0 -70 34z" fill="hsl(${hue} 35% 25%)"/><circle cx="104" cy="132" r="7" fill="#1f2937"/><circle cx="152" cy="132" r="7" fill="#1f2937"/><path d="M108 164 q20 14 40 0" stroke="#1f2937" stroke-width="5" fill="none" stroke-linecap="round"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="hsl(${hue} 70% 88%)"/>${face}</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** The portrait as a PNG (what the real route returns and the avatar route keeps). */
async function drawFacePng(persona: string, seed: number): Promise<string> {
  const image = new Image();
  image.src = drawFace(persona, seed);
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  canvas.getContext("2d")!.drawImage(image, 0, 0);
  return canvas.toDataURL("image/png");
}
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
    // Variant B: one bot for all assistants (@uno_team_bot) — linked once, each signs its messages.
    telegram: world.telegram === "on",
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
      avatar: record.avatar ?? null,
    },
    team: {
      team: { ...record.team, revokedAt: record.revokedAt },
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
        // The real list's "Reconnect" state (Google ended the sign-in).
        needsReconnect: state === "expired",
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

export function telegramLinked(machine: MachineKey, projectId: string): boolean {
  return recordOf(machine, projectId)?.telegram === true;
}

/** Variant B: the bot is shared — linking (or unlinking) it is for every assistant at once. */
export function setTelegram(_machine: MachineKey, _projectId: string, linked: boolean) {
  for (const record of records.values()) record.telegram = linked;
}

/** "Does it itself" (full) / "Asks first" (helper) — from a chat card or its page. */
export function setPreset(machine: MachineKey, projectId: string, preset: AssistantPreset) {
  const record = recordOf(machine, projectId);
  if (record) record.preset = preset;
}

export function isRevoked(machine: MachineKey, projectId: string): boolean {
  return recordOf(machine, projectId)?.revokedAt != null;
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
    http.get("*/api/manager/assistants", ({ request }) => {
      const machine = machineOf(request);
      const list = [...records.values()]
        // Revoked ones stay listed (their token says so), as a real daemon lists them.
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
      const record = recordOf(machineOf(request).key, projectParam(request));
      if (record) record.revokedAt = new Date().toISOString();
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
      if (Array.isArray(body.roles))
        record.persona = { ...record.persona, roles: body.roles as string[] };
      if (typeof body.character === "string")
        record.persona = { ...record.persona, character: body.character };
      if (typeof body.tone === "string") record.persona = { ...record.persona, tone: body.tone };
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
      const body = await bodyOf(request);
      const record = recordOf(machineOf(request).key, String(body.projectId ?? ""));
      if (record) record.revokedAt = body.revoked === false ? null : new Date().toISOString();
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
      const image = avatars.get(`${machineOf(request).key}:${projectParam(request)}`);
      if (!image) return new HttpResponse(null, { status: 404 });
      return new HttpResponse(
        Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0)),
        {
          headers: { "content-type": image.type },
        },
      );
    }),
    http.post("*/api/manager/assistant/avatar/generate", async ({ request }) => {
      const body = await bodyOf(request);
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      // Uno AI can't draw right now (the edge flow "face generation failed").
      if (world.face === "fail") {
        return json({ error: "Uno AI couldn't draw right now. Try again later." }, { status: 503 });
      }
      const seed = Number(body.seed ?? 0);
      return json({ image: await drawFacePng(String(body.persona ?? "human"), seed) });
    }),
    http.post("*/api/manager/assistant/avatar", async ({ request }) => {
      const body = await bodyOf(request);
      const key = `${machineOf(request).key}:${String(body.projectId)}`;
      if (typeof body.image === "string" && body.image) {
        avatars.set(key, { data: body.image, type: "image/png" });
        const record = recordOf(machineOf(request).key, String(body.projectId));
        if (record) record.avatar = new Date().toISOString();
        return json({ avatar: record?.avatar ?? null });
      }
      avatars.delete(key);
      const record = recordOf(machineOf(request).key, String(body.projectId));
      if (record) record.avatar = null;
      return json({ avatar: null });
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
