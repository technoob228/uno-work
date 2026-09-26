/**
 * "This computer" — control-plane reads and actions for the Uno Work desktop.
 *
 * The daemon proxies, on behalf of the machine it runs on, the console routes
 * behind the computer screen:
 *
 *   GET  /api/v1/boxes/{id}            status, size, address, ssh
 *   GET  /api/v1/boxes/{id}/ports      forwarded ports ("For engineers")
 *   GET  /api/v1/boxes/{id}/metrics    live CPU/RAM/disk     (feat/box-observability)
 *   GET  /api/v1/boxes/{id}/applogs    "what it's doing"     (feat/box-observability)
 *   GET  /api/v1/apps/templates        app catalog           (feat/app-templates)
 *   POST /api/v1/boxes/{id}/apps       install an app        (feat/app-templates)
 *   GET  /api/v1/deployments/{id}/logs install progress (long-poll JSON, not SSE)
 *   GET  /api/v1/git/services          installed apps (services bound to the box)
 *   GET  /api/v1/boxes/{id}/apps       sign-in, removable, web port, AI key per app
 *   DELETE /api/v1/boxes/{id}/apps/{d} remove an App Store app (?delete_data=)
 *   PATCH  /api/v1/boxes/{id}/apps/{d} the spending limit of the app's AI key
 *
 * Several of these ship after this client, so a route the control plane does
 * not have yet (404/405/501) folds into `availability: "unavailable"` — the UI
 * says "coming soon" rather than showing an error.
 *
 * Kept free of Effect, like `unoCloudParse.ts`: the functions take the account
 * key and a fetcher, so tests drive them with recorded payloads.
 */
import type {
  UnoAppAiUse,
  UnoAppMobile,
  UnoComputerActivity,
  UnoComputerAppAccess,
  UnoComputerAppAiKey,
  UnoComputerAppCredential,
  UnoComputerAppCategory,
  UnoComputerAppTemplate,
  UnoComputerApps,
  UnoComputerAvailability,
  UnoComputerBox,
  UnoComputerCandidate,
  UnoComputerInstallAppResult,
  UnoComputerInstallStatus,
  UnoComputerInstalledApp,
  UnoComputerInstalledAppState,
  UnoComputerMetrics,
  UnoComputerMetricsPoint,
  UnoComputerOpenAppResult,
  UnoComputerPort,
  UnoComputerRemoveAppResult,
  UnoComputerState,
} from "@t3tools/contracts";

import {
  asNullableString,
  asNumber,
  asString,
  controlPlaneBaseUrl,
  controlPlaneErrorStatus,
  fetchControlPlaneJson,
} from "./unoCloudParse.ts";
import { parseComputerBoost } from "./unoComputerBoost.ts";
import { parseComputerEconomy } from "./unoComputerEconomy.ts";

export const NOT_LINKED_MESSAGE = "Connect your Uno account first.";
export const NO_COMPUTER_MESSAGE = "This machine isn't an Uno computer.";

/** One control-plane request with the account key already bound. */
export type ControlPlaneFetch = (path: string, init?: RequestInit) => Promise<unknown>;

export interface UnoComputerClientContext {
  readonly apiKey: string;
  /** Defaults to the real control plane; tests pass a fake. */
  readonly fetchJson?:
    | ((apiKey: string, path: string, init?: RequestInit) => Promise<unknown>)
    | undefined;
}

export class UnoComputerActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnoComputerActionError";
  }
}

/** Ключ ИИ шлюза (`unoGatewayKey.ts`). Консоль его не принимает — это не ключ аккаунта. */
const GATEWAY_KEY_PREFIX = "unollm_";

export interface UnoComputerCredentials {
  /** `uno.apiKey`: ключ аккаунта на ноутбуке, ключ ИИ `unollm_` на Work-машине. */
  readonly accountKey: string;
  /** `uno.boxToken`: узкий токен на свой бокс, его пишет консоль. */
  readonly boxToken: string;
  /** Бокс, на котором живёт демон. */
  readonly ownBoxId: number | null;
}

/**
 * Каким ключом идти в control plane за экраном этого бокса.
 *
 * Свой бокс — токеном машины, если он есть: он узкий и именно для этого выдан.
 * Иначе — ключом аккаунта, если в `uno.apiKey` лежит он, а не ключ ИИ: с
 * `unollm_` консоль отвечает 401, и честнее сказать «не привязано», чем
 * показать человеку «401». Пустая строка = идти не с чем.
 */
export function computerKeyFor(creds: UnoComputerCredentials, targetBoxId: number | null): string {
  const boxToken = creds.boxToken.trim();
  if (boxToken.length > 0 && targetBoxId !== null && targetBoxId === creds.ownBoxId) {
    return boxToken;
  }
  const account = creds.accountKey.trim();
  return account.length > 0 && !account.startsWith(GATEWAY_KEY_PREFIX) ? account : "";
}

function bind(ctx: UnoComputerClientContext): ControlPlaneFetch | null {
  const apiKey = ctx.apiKey.trim();
  if (apiKey.length === 0) return null;
  const fetchJson = ctx.fetchJson ?? fetchControlPlaneJson;
  return (path, init) => fetchJson(apiKey, path, init);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * What a person sees when the control plane fails. Never the raw body: behind
 * Cloudflare a 502 arrives as a whole HTML error page, and that used to land
 * on the screen verbatim ("502: <!DOCTYPE html>…").
 */
export function humanizeControlPlaneError(cause: unknown): string {
  const status = controlPlaneErrorStatus(cause);
  if (status !== null) {
    if (status === 401 || status === 403) return "Uno refused this machine's key.";
    if (status === 404) return "Uno doesn't know this computer — it may have been deleted.";
    if (status === 429) return "Uno is busy. Try again in a moment.";
    if (status >= 500) return "Uno isn't answering right now. It usually comes back in a minute.";
    return `Uno answered with an error (HTTP ${status}).`;
  }
  const raw = cause instanceof Error ? cause.message : String(cause);
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|timed? ?out|abort/i.test(raw)) {
    return "Can't reach Uno right now. It will try again by itself.";
  }
  return /<[a-z!/]/i.test(raw) ? "Uno answered with an error." : raw.slice(0, 200);
}

function errorMessage(cause: unknown): string {
  return humanizeControlPlaneError(cause);
}

/** A route the control plane does not serve (yet). */
export function isRouteMissing(cause: unknown): boolean {
  const status = controlPlaneErrorStatus(cause);
  return status === 404 || status === 405 || status === 501;
}

export function classifyFailure(cause: unknown): {
  readonly availability: UnoComputerAvailability;
  readonly message: string | null;
} {
  if (isRouteMissing(cause)) return { availability: "unavailable", message: null };
  const status = controlPlaneErrorStatus(cause);
  if (status === 502 || status === 503 || status === 504) {
    return {
      availability: "error",
      message: "The computer isn't answering right now. It usually comes back in a minute.",
    };
  }
  return { availability: "error", message: humanizeControlPlaneError(cause) };
}

/* ------------------------------------------------------------------ *
 * The computer itself
 * ------------------------------------------------------------------ */

export function parseComputerPorts(raw: unknown): ReadonlyArray<UnoComputerPort> {
  const list = Array.isArray(raw) ? raw : (asRecord(raw)?.["ports"] ?? []);
  if (!Array.isArray(list)) return [];
  const ports: UnoComputerPort[] = [];
  for (const item of list) {
    const record = asRecord(item);
    if (!record) continue;
    const port = asNullableNumber(record["internal_port"]) ?? asNullableNumber(record["port"]);
    if (port === null) continue;
    ports.push({
      port,
      externalPort:
        asNullableNumber(record["external_port"]) ?? asNullableNumber(record["public_port"]),
      protocol: asString(record["protocol"]) || "tcp",
    });
  }
  return ports.toSorted((a, b) => a.port - b.port);
}

/**
 * The computer's web address. The control plane's own `hostname` wins; without
 * it, the forwarded web port on the public IP is still a real address.
 */
export function computerAddress(
  record: Record<string, unknown>,
  ports: ReadonlyArray<UnoComputerPort>,
): string | null {
  const hostname = asNullableString(record["hostname"]);
  if (hostname) return /^https?:\/\//.test(hostname) ? hostname : `https://${hostname}`;
  const publicIp =
    asNullableString(record["network_public_ip"]) ?? asNullableString(record["public_ip"]);
  const web = ports.find((p) => p.port === 80 || p.port === 443);
  if (publicIp && web?.externalPort) return `http://${publicIp}:${web.externalPort}`;
  return null;
}

export function parseComputerBox(
  raw: unknown,
  ports: ReadonlyArray<UnoComputerPort>,
): UnoComputerBox | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asNumber(record["id"], -1);
  if (id < 0) return null;
  const boost = parseComputerBoost(record["boost"]);
  const economy = parseComputerEconomy(record["economy"]);
  return {
    id,
    name: asString(record["name"]) || `computer-${id}`,
    status: asString(record["status"]) || "unknown",
    os: asString(record["os"]),
    ramMb: asNumber(record["ram_mb"]),
    vcpu: asNumber(record["vcpu"]),
    diskGb: asNumber(record["disk_gb"]),
    startedAt: asNullableString(record["started_at"]),
    address: computerAddress(record, ports),
    ssh: asNullableString(record["ssh_command"]) ?? asNullableString(record["ssh"]),
    ports,
    ...(boost ? { boost } : {}),
    ...(economy ? { economy } : {}),
  };
}

function parseCandidates(raw: unknown): ReadonlyArray<UnoComputerCandidate> {
  const list = Array.isArray(raw) ? raw : (asRecord(raw)?.["boxes"] ?? []);
  if (!Array.isArray(list)) return [];
  const out: UnoComputerCandidate[] = [];
  for (const item of list) {
    const record = asRecord(item);
    const id = asNumber(record?.["id"], -1);
    if (!record || id < 0) continue;
    out.push({
      id,
      name: asString(record["name"]) || `computer-${id}`,
      status: asString(record["status"]) || "unknown",
    });
  }
  return out;
}

export async function readComputerState(
  ctx: UnoComputerClientContext & {
    readonly ownBoxId: number | null;
    readonly requestedBoxId?: number | undefined;
  },
): Promise<UnoComputerState> {
  const fetchedAt = new Date().toISOString();
  const request = bind(ctx);
  const base = { own: false, box: null, candidates: [], fetchedAt } as const;
  if (!request) return { ...base, linked: false, error: null };

  const boxId = ctx.requestedBoxId ?? ctx.ownBoxId;
  if (boxId === null) {
    // Not on an Uno computer (a laptop): offer the account's computers instead.
    try {
      const candidates = parseCandidates(await request("/api/v1/boxes"));
      return { ...base, linked: true, candidates, error: null };
    } catch (cause) {
      return { ...base, linked: true, error: errorMessage(cause) };
    }
  }

  // Ports are an optional garnish: without them the header just has no
  // port-derived address, which is not worth failing the whole screen over.
  const [boxResult, portsResult] = await Promise.allSettled([
    request(`/api/v1/boxes/${boxId}`),
    request(`/api/v1/boxes/${boxId}/ports`),
  ]);
  if (boxResult.status === "rejected") {
    return { ...base, linked: true, error: errorMessage(boxResult.reason) };
  }
  const ports = portsResult.status === "fulfilled" ? parseComputerPorts(portsResult.value) : [];
  const box = parseComputerBox(boxResult.value, ports);
  return {
    ...base,
    linked: true,
    own: box !== null && box.id === ctx.ownBoxId,
    box,
    error: box === null ? "The control plane answered without a computer." : null,
  };
}

/* ------------------------------------------------------------------ *
 * Monitor
 * ------------------------------------------------------------------ */

const EMPTY_METRICS = {
  sampledAt: null,
  uptimeS: null,
  cpuPct: null,
  vcpu: null,
  memUsedMb: null,
  memLimitMb: null,
  diskUsedGb: null,
  diskTotalGb: null,
  history: [],
} as const;

function emptyMetrics(
  availability: UnoComputerAvailability,
  message: string | null,
): UnoComputerMetrics {
  return { availability, message, ...EMPTY_METRICS };
}

/** `GET /boxes/{id}/metrics` — the contract fixed in feat/box-observability. */
export function parseComputerMetrics(raw: unknown): UnoComputerMetrics {
  const record = asRecord(raw);
  if (!record) return emptyMetrics("error", "The monitor answered with something unreadable.");
  if (record["ok"] === false) {
    return emptyMetrics("error", asNullableString(record["error"]));
  }
  if (record["live"] === false) return emptyMetrics("offline", null);
  const cpu = asRecord(record["cpu"]);
  const mem = asRecord(record["mem"]);
  const disk = asRecord(record["disk"]);
  const history: UnoComputerMetricsPoint[] = [];
  for (const item of Array.isArray(record["history"]) ? record["history"] : []) {
    const point = asRecord(item);
    const t = asNullableString(point?.["t"]);
    if (!point || !t) continue;
    history.push({ t, cpuPct: asNumber(point["cpu_pct"]), memMb: asNumber(point["mem_mb"]) });
  }
  return {
    availability: "ok",
    message: null,
    sampledAt: asNullableString(record["sampled_at"]),
    uptimeS: asNullableNumber(record["uptime_s"]),
    cpuPct: asNullableNumber(cpu?.["usage_pct"]),
    vcpu: asNullableNumber(cpu?.["vcpu"]),
    memUsedMb: asNullableNumber(mem?.["used_mb"]),
    memLimitMb: asNullableNumber(mem?.["limit_mb"]),
    diskUsedGb: asNullableNumber(disk?.["used_gb"]),
    diskTotalGb: asNullableNumber(disk?.["total_gb"]),
    history,
  };
}

export async function readComputerMetrics(
  ctx: UnoComputerClientContext & { readonly boxId: number | null },
): Promise<UnoComputerMetrics> {
  const request = bind(ctx);
  if (!request) return emptyMetrics("error", NOT_LINKED_MESSAGE);
  if (ctx.boxId === null) return emptyMetrics("error", NO_COMPUTER_MESSAGE);
  try {
    return parseComputerMetrics(await request(`/api/v1/boxes/${ctx.boxId}/metrics`));
  } catch (cause) {
    const failure = classifyFailure(cause);
    return emptyMetrics(failure.availability, failure.message);
  }
}

/* ------------------------------------------------------------------ *
 * What it's doing
 * ------------------------------------------------------------------ */

export function parseComputerActivity(raw: unknown): UnoComputerActivity {
  const record = asRecord(raw);
  if (!record) {
    return { availability: "error", message: "Unreadable answer.", source: null, lines: [] };
  }
  if (record["ok"] === false) {
    // The guest agent is not there to ask — the computer is asleep or off.
    return {
      availability: "offline",
      message: asNullableString(record["error"]),
      source: null,
      lines: [],
    };
  }
  const lines: string[] = [];
  for (const item of Array.isArray(record["lines"]) ? record["lines"] : []) {
    const text = typeof item === "string" ? item : asString(asRecord(item)?.["line"]);
    if (text.length > 0) lines.push(text);
  }
  return {
    availability: "ok",
    message: null,
    source: asNullableString(record["source"]),
    lines,
  };
}

function emptyActivity(
  availability: UnoComputerAvailability,
  message: string | null,
): UnoComputerActivity {
  return { availability, message, source: null, lines: [] };
}

export async function readComputerActivity(
  ctx: UnoComputerClientContext & { readonly boxId: number | null; readonly tail: number },
): Promise<UnoComputerActivity> {
  const request = bind(ctx);
  const empty = emptyActivity;
  if (!request) return empty("error", NOT_LINKED_MESSAGE);
  if (ctx.boxId === null) return empty("error", NO_COMPUTER_MESSAGE);
  try {
    return parseComputerActivity(
      await request(`/api/v1/boxes/${ctx.boxId}/applogs?source=auto&tail=${ctx.tail}`),
    );
  } catch (cause) {
    const failure = classifyFailure(cause);
    return empty(failure.availability, failure.message);
  }
}

/* ------------------------------------------------------------------ *
 * Apps
 * ------------------------------------------------------------------ */

/**
 * The catalog's `ai` (the app's manifest `"ai"`): `true` = answers only;
 * `{chat, tasks, limit_usd | limitUsd}`. Anything else = the app uses no AI.
 */
export function parseTemplateAi(raw: unknown): UnoAppAiUse | null {
  if (raw === true) return { chat: true, tasks: false, limitUsd: null };
  const record = asRecord(raw);
  if (!record) return null;
  const chat = record["chat"] === true;
  const tasks = record["tasks"] === true;
  if (!chat && !tasks) return null;
  const limit = record["limit_usd"] ?? record["limitUsd"];
  return {
    chat,
    tasks,
    limitUsd: typeof limit === "number" && Number.isFinite(limit) && limit >= 0 ? limit : null,
  };
}

const IOS_STORE_URL = /^https:\/\/apps\.apple\.com\/[a-z0-9/._-]*id[0-9]+$/;
const ANDROID_STORE_URL = /^https:\/\/play\.google\.com\/store\/apps\/details\?id=[A-Za-z0-9._]+$/;

/**
 * The catalog's `mobile`: official phone apps. Only App Store / Google Play
 * links become buttons — the catalog can't point a person anywhere else.
 * Null when neither link is usable.
 */
export function parseTemplateMobile(raw: unknown): UnoAppMobile | null {
  const record = asRecord(raw);
  if (!record) return null;
  const ios = asString(record["ios"]);
  const android = asString(record["android"]);
  const out: UnoAppMobile = {
    ios: IOS_STORE_URL.test(ios) ? ios : null,
    android: ANDROID_STORE_URL.test(android) ? android : null,
    appName: asString(record["app_name"]) || null,
    note: asString(record["note_en"]) || asString(record["note_ru"]) || null,
  };
  return out.ios || out.android ? out : null;
}

export function parseAppTemplates(raw: unknown): ReadonlyArray<UnoComputerAppTemplate> {
  const list = Array.isArray(raw) ? raw : (asRecord(raw)?.["templates"] ?? []);
  if (!Array.isArray(list)) return [];
  const out: UnoComputerAppTemplate[] = [];
  for (const item of list) {
    const record = asRecord(item);
    const id = asString(record?.["id"]);
    if (!record || id.length === 0) continue;
    const settings = (Array.isArray(record["env"]) ? record["env"] : [])
      .map(asRecord)
      .filter((env): env is Record<string, unknown> => env !== null && asString(env["name"]) !== "")
      .map((env) => ({
        name: asString(env["name"]),
        // The interface is English: a Russian-only description is not shown
        // (it read like a stray line in the middle of the form).
        description:
          asString(env["description_en"]) ||
          asString(env["description"]) ||
          (env["secret"] === true ? "Password" : asString(env["name"])),
        secret: env["secret"] === true,
        defaultValue: asNullableString(env["default"]),
        required: env["required"] === true,
        options: parseSettingOptions(env["options"]),
        showIf: parseShowIf(env["show_if"]),
      }));
    out.push({
      id,
      name: asString(record["name"]) || id,
      // Work speaks English; the catalog's Russian copy is the fallback.
      description: asString(record["description_en"]) || asString(record["description_ru"]),
      category: asString(record["category"]),
      icon: asString(record["icon"]),
      minRamMb: asNumber(record["min_ram_mb"]),
      minDiskGb: asNumber(record["min_disk_gb"]),
      settings,
      notes: asString(record["notes_en"]) || asString(record["notes_ru"]) || null,
      rank: asNumber(record["rank"]),
      featured: record["featured"] === true,
      madeByUno: record["made_by_uno"] === true || record["publisher"] === "uno",
      publisher:
        record["made_by_uno"] === true || record["publisher"] === "uno"
          ? "uno"
          : record["publisher"] === "community"
            ? "community"
            : null,
      mobile: parseTemplateMobile(record["mobile"]),
      tagline: asString(record["tagline_en"]) || asString(record["tagline_ru"]) || null,
      keywords: Array.isArray(record["keywords"])
        ? record["keywords"].filter((k): k is string => typeof k === "string" && k.length > 0)
        : [],
      iconUrl: catalogIconUrl(record["icon_url"]),
      sso: parseSsoMode(record["sso"]),
      ai: parseTemplateAi(record["ai"]),
    });
  }
  return out;
}

/**
 * The console serves the brand logos itself (`/api/v1/apps/icons/<file>`);
 * only that path (or an https URL on the console) becomes an <img> source —
 * never an address the catalog could point anywhere.
 */
export function catalogIconUrl(raw: unknown, base: string = controlPlaneBaseUrl()): string | null {
  const text = asString(raw);
  if (!/^\/api\/v1\/apps\/icons\/[a-z0-9-]+\.(svg|png)$/.test(text)) return null;
  return `${base}${text}`;
}

function parseSsoMode(raw: unknown): "oidc" | "edge" | null {
  const mode = asString(asRecord(raw)?.["mode"]);
  return mode === "oidc" || mode === "edge" ? mode : null;
}

/** Store sections, in tab order; `name` is English (Work speaks English). */
export function parseAppCategories(raw: unknown): ReadonlyArray<UnoComputerAppCategory> {
  const list = asRecord(raw)?.["categories"];
  if (!Array.isArray(list)) return [];
  return list
    .map(asRecord)
    .filter((c): c is Record<string, unknown> => c !== null && asString(c["id"]) !== "")
    .map((c) => ({
      id: asString(c["id"]),
      name: asString(c["name_en"]) || asString(c["name_ru"]) || asString(c["id"]),
      technical: c["technical"] === true,
    }));
}

function parseSettingOptions(raw: unknown): ReadonlyArray<{ value: string; label: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(asRecord)
    .filter((o): o is Record<string, unknown> => o !== null && asString(o["value"]) !== "")
    .map((o) => ({
      value: asString(o["value"]),
      label: asString(o["label_en"]) || asString(o["label_ru"]) || asString(o["value"]),
    }));
}

/** "STORAGE=s3" → { name: "STORAGE", value: "s3" }. */
function parseShowIf(raw: unknown): { name: string; value: string } | null {
  const text = asString(raw);
  const at = text.indexOf("=");
  if (at <= 0) return null;
  return { name: text.slice(0, at), value: text.slice(at + 1) };
}

/** One row of `GET /api/v1/boxes/{id}/apps`, as the card needs it. */
export interface AppCard {
  readonly templateId: string | null;
  readonly notes: string | null;
  readonly credentials: ReadonlyArray<UnoComputerAppCredential>;
  /** null when the console does not say (an older console). */
  readonly removable: boolean | null;
  readonly webPort: number | null;
  readonly composeProject: string | null;
  readonly aiKey: UnoComputerAppAiKey | null;
  /** Sign in with Uno: "oidc" / "edge"; null — the app's own sign-in only. */
  readonly sso: "oidc" | "edge" | null;
  readonly sharedWith: number | null;
}

export function parseAiKey(raw: unknown): UnoComputerAppAiKey | null {
  const record = asRecord(raw);
  if (!record) return null;
  const limit = asNullableNumber(record["limit_usd"]);
  return {
    limitUsd: limit !== null && limit >= 0 ? limit : null,
    spentUsd: Math.max(0, asNullableNumber(record["spent_usd"]) ?? 0),
  };
}

/**
 * `GET /api/v1/boxes/{id}/apps` (console 2026-09-23+): how to sign in to each
 * installed app — login, the password Uno generated, an invite link — plus the
 * template's after-install note; since 0.0.72 also whether it can be removed,
 * its web port and compose project (so the desktop shows it once) and its own
 * AI key. Keyed by deployment id. An older console answers 404, or leaves the
 * newer fields out: they read as null.
 */
export function parseAppCards(raw: unknown): Map<number, AppCard> {
  const out = new Map<number, AppCard>();
  const list = asRecord(raw)?.["apps"];
  for (const item of Array.isArray(list) ? list : []) {
    const record = asRecord(item);
    const deploymentId = asNullableNumber(record?.["deployment_id"]);
    if (!record || deploymentId === null) continue;
    const credentials = (Array.isArray(record["credentials"]) ? record["credentials"] : [])
      .map(asRecord)
      .filter((c): c is Record<string, unknown> => c !== null && asString(c["value"]) !== "")
      .map((c) => ({
        label: asString(c["label_en"]) || asString(c["label_ru"]) || "Sign-in",
        value: asString(c["value"]),
        secret: c["secret"] === true,
        link: c["link"] === true,
      }));
    const webPort = asNullableNumber(record["web_port"]);
    out.set(deploymentId, {
      templateId: asNullableString(record["template_id"]),
      notes: asString(record["notes_en"]) || asString(record["notes_ru"]) || null,
      credentials,
      removable: typeof record["removable"] === "boolean" ? record["removable"] : null,
      webPort: webPort !== null && webPort > 0 ? webPort : null,
      composeProject: asNullableString(record["compose_project"]),
      aiKey: parseAiKey(record["ai_key"]),
      sso: parseSso(record["sso"]),
      sharedWith: asNullableNumber(record["shared_with"]),
    });
  }
  return out;
}

/** "oidc" / "edge" from the console's `sso`; anything else — the app's own sign-in only. */
function parseSso(raw: unknown): "oidc" | "edge" | null {
  return raw === "oidc" || raw === "edge" ? raw : null;
}

/** Catalog apps run as compose project `uno-<template_id>` when the console doesn't say. */
export function composeProjectFor(templateId: string | null): string | null {
  return templateId ? `uno-${templateId}` : null;
}

function serviceState(status: string): UnoComputerInstalledAppState {
  switch (status) {
    case "success":
      return "running";
    case "failed":
    case "cancelled":
      return "failed";
    case "queued":
    case "cloning":
    case "building":
    case "deploying":
      return "installing";
    default:
      return "unknown";
  }
}

/** Deployments the daemon itself started, so it can name them before the service list catches up. */
export interface KnownInstall {
  readonly deploymentId: number;
  readonly boxId: number;
  readonly templateId: string;
  state: "installing" | "running" | "failed";
  url: string | null;
}

/**
 * Installed apps = git-deploy services bound to this computer (an app install
 * is a deployment of the template's repo). Named after the catalog when the
 * repo matches a template, otherwise after the repo.
 */
export function parseInstalledApps(
  raw: unknown,
  boxId: number,
  templates: ReadonlyArray<UnoComputerAppTemplate>,
  known: ReadonlyArray<KnownInstall>,
  cards: ReadonlyMap<number, AppCard> = new Map(),
): ReadonlyArray<UnoComputerInstalledApp> {
  const list = Array.isArray(raw) ? raw : (asRecord(raw)?.["services"] ?? []);
  const byTemplate = new Map(templates.map((t) => [t.id, t]));
  // A console that knows about removal says so on every row; with an older
  // one, any App Store app is offered for removal and the console answers.
  const consoleSaysRemovable = [...cards.values()].some((c) => c.removable !== null);
  const extras = (
    deploymentId: number | null,
    templateId: string | null,
  ): Pick<
    UnoComputerInstalledApp,
    | "notes"
    | "credentials"
    | "removable"
    | "webPort"
    | "composeProject"
    | "aiKey"
    | "sso"
    | "sharedWith"
  > => {
    const card = deploymentId !== null ? cards.get(deploymentId) : undefined;
    const template = templateId !== null ? byTemplate.get(templateId) : undefined;
    return {
      notes: card?.notes ?? template?.notes ?? null,
      credentials: card?.credentials ?? [],
      removable:
        deploymentId !== null &&
        (card?.removable ?? (!consoleSaysRemovable && templateId !== null)),
      webPort: card?.webPort ?? null,
      composeProject: card?.composeProject ?? composeProjectFor(card?.templateId ?? templateId),
      aiKey: card?.aiKey ?? null,
      sso: card?.sso ?? null,
      sharedWith: card?.sharedWith ?? null,
    };
  };
  const knownByDeployment = new Map(known.map((k) => [k.deploymentId, k]));
  const apps: UnoComputerInstalledApp[] = [];
  const seenDeployments = new Set<number>();
  for (const item of Array.isArray(list) ? list : []) {
    const record = asRecord(item);
    if (!record || asNullableNumber(record["box_id"]) !== boxId) continue;
    const repo = asString(record["repo_full_name"]) || asString(record["repo"]);
    const slug = repo.split("/").pop() ?? repo;
    const deploymentId = asNullableNumber(record["last_deployment_id"]);
    if (deploymentId !== null) seenDeployments.add(deploymentId);
    const knownInstall = deploymentId !== null ? knownByDeployment.get(deploymentId) : undefined;
    const template = byTemplate.get(knownInstall?.templateId ?? slug);
    apps.push({
      key: `service:${asNumber(record["id"])}`,
      name: template?.name ?? (slug || `App ${asNumber(record["id"])}`),
      templateId: template?.id ?? null,
      icon: template?.icon ?? null,
      iconUrl: template?.iconUrl ?? null,
      state: serviceState(asString(record["last_status"])),
      url: asNullableString(record["url"]) ?? knownInstall?.url ?? null,
      deploymentId,
      ...extras(deploymentId, template?.id ?? null),
    });
  }
  // Installs this daemon started that the service list does not show yet.
  for (const install of known) {
    if (install.boxId !== boxId || seenDeployments.has(install.deploymentId)) continue;
    if (install.state === "failed") continue;
    const template = byTemplate.get(install.templateId);
    apps.push({
      key: `install:${install.deploymentId}`,
      name: template?.name ?? install.templateId,
      templateId: install.templateId,
      icon: template?.icon ?? null,
      iconUrl: template?.iconUrl ?? null,
      state: install.state,
      url: install.url,
      deploymentId: install.deploymentId,
      ...extras(install.deploymentId, install.templateId),
    });
  }
  return apps;
}

function failedApps(
  availability: UnoComputerAvailability,
  message: string | null,
): UnoComputerApps {
  return {
    catalog: { availability, message, templates: [] },
    installed: { availability, message, apps: [] },
  };
}

export async function readComputerApps(
  ctx: UnoComputerClientContext & {
    readonly boxId: number | null;
    readonly known: ReadonlyArray<KnownInstall>;
  },
): Promise<UnoComputerApps> {
  const request = bind(ctx);
  const fail = failedApps;
  if (!request) return fail("error", NOT_LINKED_MESSAGE);
  if (ctx.boxId === null) return fail("error", NO_COMPUTER_MESSAGE);
  const boxId = ctx.boxId;

  const [catalogResult, servicesResult, cardsResult] = await Promise.allSettled([
    request("/api/v1/apps/templates"),
    request("/api/v1/git/services"),
    request(`/api/v1/boxes/${boxId}/apps`),
  ]);
  // The sign-in cards are extra: an older console (404) or a hiccup just
  // leaves them out — the app list itself does not depend on them.
  const cards = cardsResult.status === "fulfilled" ? parseAppCards(cardsResult.value) : new Map();
  const templates =
    catalogResult.status === "fulfilled" ? parseAppTemplates(catalogResult.value) : [];
  const catalogFailure =
    catalogResult.status === "rejected" ? classifyFailure(catalogResult.reason) : null;
  const servicesFailure =
    servicesResult.status === "rejected" ? classifyFailure(servicesResult.reason) : null;
  return {
    catalog: {
      availability: catalogFailure?.availability ?? "ok",
      message: catalogFailure?.message ?? null,
      templates,
      categories:
        catalogResult.status === "fulfilled" ? parseAppCategories(catalogResult.value) : [],
    },
    installed: {
      availability: servicesFailure?.availability ?? "ok",
      message: servicesFailure?.message ?? null,
      apps: parseInstalledApps(
        servicesResult.status === "fulfilled" ? servicesResult.value : [],
        boxId,
        templates,
        ctx.known,
        cards,
      ),
    },
  };
}

export async function installComputerApp(
  ctx: UnoComputerClientContext & {
    readonly boxId: number | null;
    readonly templateId: string;
    readonly settings: Readonly<Record<string, string>> | undefined;
    readonly allowLowMemory?: boolean | undefined;
  },
): Promise<UnoComputerInstallAppResult> {
  const request = bind(ctx);
  if (!request) throw new UnoComputerActionError(NOT_LINKED_MESSAGE);
  if (ctx.boxId === null) throw new UnoComputerActionError(NO_COMPUTER_MESSAGE);
  let raw: unknown;
  try {
    raw = await request(`/api/v1/boxes/${ctx.boxId}/apps`, {
      method: "POST",
      body: JSON.stringify({
        template_id: ctx.templateId,
        env: ctx.settings ?? {},
        ...(ctx.allowLowMemory ? { allow_low_memory: true } : {}),
      }),
    });
  } catch (cause) {
    // Raw text to recognise the error code; errorMessage() for anything shown.
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("TEMPLATE_NOT_FOUND")) {
      throw new UnoComputerActionError("That app isn't in the catalog anymore.");
    }
    // Pre-flight refusals come as 501 (a console workaround for 0.0.69, which
    // could only say "coming soon" on 501) — recognise them by code first.
    if (message.includes("APP_NEEDS_MORE_MEMORY")) {
      return {
        deploymentId: null,
        confirm: {
          kind: "low_memory",
          message:
            "This app needs more memory than this computer has. It may be slow or stop. " +
            "You can give the computer more memory, or install it anyway.",
        },
      };
    }
    if (message.includes("APP_NEEDS_DOCKER")) {
      throw new UnoComputerActionError(
        "This app needs docker, and this computer doesn't have it. Pick another app, or create a new computer.",
      );
    }
    if (message.includes("APP_INSTALL_UNAVAILABLE")) {
      throw new UnoComputerActionError(
        "This computer can't install apps yet — restart it from Uno once, or create a new computer.",
      );
    }
    if (message.includes("APP_PORT_UNAVAILABLE")) {
      throw new UnoComputerActionError(
        "Uno couldn't open a network port this app needs. Try again in a minute.",
      );
    }
    if (isRouteMissing(cause)) {
      throw new UnoComputerActionError("Installing apps is coming soon to this computer.");
    }
    if (controlPlaneErrorStatus(cause) === 400) {
      throw new UnoComputerActionError(
        `The app didn't accept its settings: ${/<[a-z!/]/i.test(message) ? "HTTP 400" : message.slice(0, 200)}`,
      );
    }
    throw new UnoComputerActionError(errorMessage(cause));
  }
  const deploymentId = asNullableNumber(asRecord(raw)?.["deployment_id"]);
  if (deploymentId === null) {
    throw new UnoComputerActionError("The install started without a progress handle.");
  }
  return { deploymentId, confirm: null };
}

const TERMINAL_OK = new Set(["success"]);
const TERMINAL_FAIL = new Set(["failed", "cancelled", "canceled"]);

/**
 * One poll of an install. The long-poll JSON form of
 * `/deployments/{id}/logs` answers `{ status, done, logs: [{seq, line}] }`;
 * once it is done and succeeded, the app's address is looked up in the
 * service list (the deployment itself does not carry one).
 */
export async function readInstallStatus(
  ctx: UnoComputerClientContext & {
    readonly deploymentId: number;
    readonly afterSeq: number;
    readonly boxId: number | null;
  },
): Promise<UnoComputerInstallStatus> {
  const request = bind(ctx);
  if (!request) throw new UnoComputerActionError(NOT_LINKED_MESSAGE);
  let raw: unknown;
  try {
    raw = await request(
      `/api/v1/deployments/${ctx.deploymentId}/logs?after_seq=${Math.max(0, ctx.afterSeq)}`,
    );
  } catch (cause) {
    throw new UnoComputerActionError(errorMessage(cause));
  }
  const record = asRecord(raw) ?? {};
  const status = asString(record["status"]) || "queued";
  const done = record["done"] === true || TERMINAL_OK.has(status) || TERMINAL_FAIL.has(status);
  const lines: { seq: number; text: string }[] = [];
  let nextSeq = ctx.afterSeq;
  const rawLines = Array.isArray(record["logs"])
    ? record["logs"]
    : Array.isArray(record["lines"])
      ? record["lines"]
      : [];
  for (const item of rawLines) {
    const line = asRecord(item);
    const seq = asNumber(line?.["seq"], -1);
    if (!line || seq <= ctx.afterSeq) continue;
    const text = asString(line["line"]) || asString(line["text"]);
    if (text.length > 0) lines.push({ seq, text });
    nextSeq = Math.max(nextSeq, seq);
  }

  const state: UnoComputerInstallStatus["state"] = !done
    ? "installing"
    : TERMINAL_FAIL.has(status)
      ? "failed"
      : "running";

  let url: string | null = null;
  if (state === "running" && ctx.boxId !== null) {
    try {
      const services = await request("/api/v1/git/services");
      const list = asRecord(services)?.["services"];
      const match = (Array.isArray(list) ? list : [])
        .map(asRecord)
        .find((s) => s !== null && asNullableNumber(s["last_deployment_id"]) === ctx.deploymentId);
      url = asNullableString(match?.["url"]);
    } catch {
      // No address yet is fine: the app list picks it up on its next read.
    }
  }

  return { deploymentId: ctx.deploymentId, state, status, lines, nextSeq, url };
}

/* ------------------------------------------------------------------ *
 * Remove an app, and its AI spending limit
 * ------------------------------------------------------------------ */

/** `{"error": CODE, "detail": "..."}` out of a control-plane error, when it is JSON. */
export function controlPlaneErrorBody(cause: unknown): { code: string; detail: string } | null {
  const message = cause instanceof Error ? cause.message : String(cause);
  const start = message.indexOf("{");
  if (start < 0) return null;
  try {
    const record = asRecord(JSON.parse(message.slice(start)));
    if (!record) return null;
    return { code: asString(record["error"]), detail: asString(record["detail"]) };
  } catch {
    // The body is cut at 200 characters: find the code by eye.
    const code = /"error"\s*:\s*"([A-Z_]+)"/.exec(message)?.[1];
    return code ? { code, detail: "" } : null;
  }
}

/**
 * A console from before app removal answers DELETE/PATCH with its router's own
 * 404 ("404 page not found", no JSON code) or 405. A newer console's 404 says
 * `NOT_FOUND`: the app itself is gone.
 */
function isOlderConsole(cause: unknown): boolean {
  const status = controlPlaneErrorStatus(cause);
  if (status === 405 || status === 501) return true;
  return status === 404 && controlPlaneErrorBody(cause) === null;
}

function readableDetail(detail: string): string {
  const text = detail.trim();
  if (text.length === 0 || /<[a-z!/]/i.test(text)) return "";
  return ` ${text.slice(0, 200)}${/[.!?]$/.test(text) ? "" : "."}`;
}

export const REMOVE_NEEDS_CONSOLE_UPDATE =
  "Removing apps needs a console update — try again later.";

/**
 * `DELETE /api/v1/boxes/{id}/apps/{deployment_id}?delete_data=` — synchronous
 * (it stops the app's containers), so it may take a minute or two. Data is
 * kept unless `deleteData` is exactly true.
 */
export async function removeComputerApp(
  ctx: UnoComputerClientContext & {
    readonly boxId: number | null;
    readonly deploymentId: number;
    readonly deleteData: boolean;
  },
): Promise<UnoComputerRemoveAppResult> {
  const request = bind(ctx);
  if (!request) throw new UnoComputerActionError(NOT_LINKED_MESSAGE);
  if (ctx.boxId === null) throw new UnoComputerActionError(NO_COMPUTER_MESSAGE);
  let raw: unknown;
  try {
    raw = await request(
      `/api/v1/boxes/${ctx.boxId}/apps/${ctx.deploymentId}?delete_data=${ctx.deleteData === true}`,
      { method: "DELETE" },
    );
  } catch (cause) {
    if (isOlderConsole(cause)) throw new UnoComputerActionError(REMOVE_NEEDS_CONSOLE_UPDATE);
    const body = controlPlaneErrorBody(cause);
    switch (body?.code) {
      case "NOT_FOUND":
        throw new UnoComputerActionError("This app isn't on this computer anymore.");
      case "APP_BUSY":
        throw new UnoComputerActionError(
          "This app is still being installed or updated. Try again when that finishes.",
        );
      case "APP_REMOVE_FAILED":
        throw new UnoComputerActionError(
          `Uno couldn't remove the app, and nothing was changed.${readableDetail(body.detail)}`,
        );
    }
    throw new UnoComputerActionError(errorMessage(cause));
  }
  const record = asRecord(raw) ?? {};
  return {
    removed: record["removed"] !== false,
    templateId: asNullableString(record["template_id"]),
    dataDeleted: record["data_deleted"] === true,
  };
}

/** `PATCH /api/v1/boxes/{id}/apps/{deployment_id}` `{"ai_limit_usd": n | null}`. */
export async function setComputerAppAiLimit(
  ctx: UnoComputerClientContext & {
    readonly boxId: number | null;
    readonly deploymentId: number;
    readonly limitUsd: number | null;
  },
): Promise<{ aiKey: UnoComputerAppAiKey }> {
  const request = bind(ctx);
  if (!request) throw new UnoComputerActionError(NOT_LINKED_MESSAGE);
  if (ctx.boxId === null) throw new UnoComputerActionError(NO_COMPUTER_MESSAGE);
  let raw: unknown;
  try {
    raw = await request(`/api/v1/boxes/${ctx.boxId}/apps/${ctx.deploymentId}`, {
      method: "PATCH",
      body: JSON.stringify({ ai_limit_usd: ctx.limitUsd }),
    });
  } catch (cause) {
    if (isOlderConsole(cause)) {
      throw new UnoComputerActionError(
        "Changing the AI limit needs a console update — try again later.",
      );
    }
    const body = controlPlaneErrorBody(cause);
    if (body?.code === "APP_NO_AI_KEY") {
      throw new UnoComputerActionError("This app doesn't have an AI key of its own.");
    }
    if (body?.code === "NOT_FOUND") {
      throw new UnoComputerActionError("This app isn't on this computer anymore.");
    }
    throw new UnoComputerActionError(errorMessage(cause));
  }
  const aiKey = parseAiKey(asRecord(raw)?.["ai_key"]);
  return { aiKey: aiKey ?? { limitUsd: ctx.limitUsd, spentUsd: 0 } };
}

/* ------------------------------------------------------------------
 * Sign in with Uno: open an app already signed in, share it
 * ------------------------------------------------------------------ */

/**
 * `POST /api/v1/boxes/{id}/apps/{deployment_id}/open` — a one-time link that
 * signs the owner in to Uno for this computer's apps and lands in the app
 * already signed in (valid once, for a minute: ask at the moment of the click).
 * A console from before Sign in with Uno has no such route: then the app's own
 * address, and the app asks for its password as before.
 */
export async function openComputerApp(
  ctx: UnoComputerClientContext & {
    readonly boxId: number | null;
    readonly deploymentId: number;
    readonly fallbackUrl: string | null;
  },
): Promise<UnoComputerOpenAppResult> {
  const request = bind(ctx);
  if (!request) throw new UnoComputerActionError(NOT_LINKED_MESSAGE);
  if (ctx.boxId === null) throw new UnoComputerActionError(NO_COMPUTER_MESSAGE);
  let raw: unknown;
  try {
    raw = await request(`/api/v1/boxes/${ctx.boxId}/apps/${ctx.deploymentId}/open`, {
      method: "POST",
    });
  } catch (cause) {
    if (isOlderConsole(cause) && ctx.fallbackUrl) {
      return { url: ctx.fallbackUrl, signedIn: false };
    }
    const body = controlPlaneErrorBody(cause);
    if (body?.code === "NOT_FOUND") {
      throw new UnoComputerActionError("This app isn't on this computer anymore.");
    }
    if (body?.code === "APP_NOT_RUNNING") {
      throw new UnoComputerActionError("This app isn't running yet — try again when it's ready.");
    }
    throw new UnoComputerActionError(errorMessage(cause));
  }
  const record = asRecord(raw) ?? {};
  const url = asString(record["url"]);
  if (!/^https?:\/\//.test(url)) {
    if (ctx.fallbackUrl) return { url: ctx.fallbackUrl, signedIn: false };
    throw new UnoComputerActionError("Uno didn't give an address for this app.");
  }
  return { url, signedIn: record["signed_in"] === true };
}

export function parseAppAccess(raw: unknown): UnoComputerAppAccess {
  const record = asRecord(raw) ?? {};
  const list = Array.isArray(record["people"]) ? record["people"] : [];
  const people = list
    .map(asRecord)
    .filter(
      (p): p is Record<string, unknown> => p !== null && asNullableNumber(p["user_id"]) !== null,
    )
    .map((p) => {
      const email = asNullableString(p["email"]);
      return {
        userId: asNumber(p["user_id"]),
        name: asString(p["username"]) || email || `Uno account ${asNumber(p["user_id"])}`,
        email,
      };
    });
  return { people, ready: record["sso_ready"] !== false };
}

function accessError(cause: unknown): UnoComputerActionError {
  if (isOlderConsole(cause)) {
    return new UnoComputerActionError("Sharing apps needs a console update — try again later.");
  }
  const body = controlPlaneErrorBody(cause);
  switch (body?.code) {
    case "USER_NOT_FOUND":
      return new UnoComputerActionError(
        "There's no Uno account with this email. Ask them to sign up at console.uno4.dev, then share again.",
      );
    case "ALREADY_OWNER":
      return new UnoComputerActionError("That's you — you always have access.");
    case "APP_NO_SSO":
      return new UnoComputerActionError(
        "This app doesn't sign in with Uno, so it can't be shared from here. Share its sign-in details instead.",
      );
    case "NOT_FOUND":
      return new UnoComputerActionError("This app isn't on this computer anymore.");
    case "SSO_NOT_CONFIGURED":
      return new UnoComputerActionError("Sharing apps isn't available on this Uno console yet.");
  }
  return new UnoComputerActionError(errorMessage(cause));
}

/** `GET|POST|DELETE /api/v1/boxes/{id}/apps/{deployment_id}/access[/{user_id}]`. */
export async function computerAppAccess(
  ctx: UnoComputerClientContext & {
    readonly boxId: number | null;
    readonly deploymentId: number;
    readonly action:
      | { readonly kind: "list" }
      | { readonly kind: "share"; readonly login: string }
      | {
          readonly kind: "unshare";
          readonly userId: number;
        };
  },
): Promise<UnoComputerAppAccess> {
  const request = bind(ctx);
  if (!request) throw new UnoComputerActionError(NOT_LINKED_MESSAGE);
  if (ctx.boxId === null) throw new UnoComputerActionError(NO_COMPUTER_MESSAGE);
  const base = `/api/v1/boxes/${ctx.boxId}/apps/${ctx.deploymentId}/access`;
  try {
    switch (ctx.action.kind) {
      case "list":
        return parseAppAccess(await request(base, { method: "GET" }));
      case "share":
        return parseAppAccess(
          await request(base, {
            method: "POST",
            body: JSON.stringify({ login: ctx.action.login.trim() }),
          }),
        );
      case "unshare":
        return parseAppAccess(await request(`${base}/${ctx.action.userId}`, { method: "DELETE" }));
    }
  } catch (cause) {
    throw accessError(cause);
  }
}
