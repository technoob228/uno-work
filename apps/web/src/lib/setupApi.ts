/**
 * The daemon routes behind the guided setup's real features (onboarding v3):
 * connectors with OAuth, a remote MCP server check, reading the project's
 * material, Telegram through Uno's shared bot, and "Add to Slack". The
 * machine talks to the console with its own identity; this interface only
 * asks its daemon. Shapes: reports/day_2026-09-25/onboarding-v3/CONTRACT.md §C.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentFetchJson } from "~/environments/http/target";

interface EnvironmentScoped {
  readonly environmentId: EnvironmentId;
}

// ── Connectors ────────────────────────────────────────────────────────

export type ConnectorProvider = "google-drive" | "gmail" | "notion" | "github";

export interface SetupConnector {
  readonly provider: ConnectorProvider;
  readonly name: string;
  readonly description: string;
  /** The console has this provider's OAuth app; false = "Soon". */
  readonly available: boolean;
  readonly connected: boolean;
  /** The signed-in account (email, login or workspace). */
  readonly account: string | null;
  readonly connectedAt: string | null;
  readonly toolCount: number;
  /** The provider refused the grant: connect again. */
  readonly needsReconnect?: boolean;
}

export interface SetupConnectorsState {
  /** False when this computer can't reach its Uno account (not a cloud computer). */
  readonly available: boolean;
  readonly reason: string | null;
  readonly connectors: ReadonlyArray<SetupConnector>;
}

export function listConnectors(input: EnvironmentScoped): Promise<SetupConnectorsState> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/connectors",
  });
}

export function startConnector(
  input: EnvironmentScoped & { readonly provider: ConnectorProvider },
): Promise<{ readonly authorizeUrl: string }> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: `/api/manager/connectors/${input.provider}/start`,
    method: "POST",
    body: {},
  });
}

export function disconnectConnector(
  input: EnvironmentScoped & { readonly provider: ConnectorProvider },
): Promise<{ readonly ok: boolean }> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: `/api/manager/connectors/${input.provider}`,
    method: "DELETE",
  });
}

// ── Your own MCP server ───────────────────────────────────────────────

export interface McpProbeResult {
  readonly ok: boolean;
  readonly toolCount: number;
  readonly toolNames: ReadonlyArray<string>;
  readonly needsAuth: boolean;
  readonly error: string | null;
}

export function probeMcpServer(
  input: EnvironmentScoped & { readonly url: string },
): Promise<McpProbeResult> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/mcp/probe",
    method: "POST",
    body: { url: input.url },
  });
}

// ── Material ──────────────────────────────────────────────────────────

export type MaterialItemState = "queued" | "reading" | "read" | "skipped" | "failed";

export interface MaterialReadItem {
  readonly name: string;
  readonly kind: "file" | "link";
  readonly state: MaterialItemState;
  readonly note: string | null;
}

export interface MaterialReadJob {
  readonly state: "running" | "done" | "failed";
  readonly items: ReadonlyArray<MaterialReadItem>;
  /** What the AI learned, one line each, naming the source. */
  readonly learned: ReadonlyArray<string>;
  /** "<project>/materials" in Cloud storage, when every file got there. */
  readonly savedToCloud: string | null;
  readonly summaryPath: string | null;
  readonly error: string | null;
}

export function startMaterialsRead(
  input: EnvironmentScoped & {
    readonly projectPath: string;
    readonly links: ReadonlyArray<string>;
  },
): Promise<{ readonly jobId: string }> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/materials/read",
    method: "POST",
    body: { projectPath: input.projectPath, links: input.links },
  });
}

export function getMaterialsRead(
  input: EnvironmentScoped & { readonly jobId: string },
): Promise<MaterialReadJob> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: `/api/manager/materials/read/${encodeURIComponent(input.jobId)}`,
  });
}

// ── Channels ──────────────────────────────────────────────────────────

export interface SharedTelegramLink {
  readonly code: string;
  readonly expiresAt: string;
  readonly botUsername: string | null;
  readonly link: string | null;
}

/** Telegram through Uno's own bot: no BotFather, just press Start. */
export function connectSharedTelegram(
  input: EnvironmentScoped & { readonly projectId: string },
): Promise<SharedTelegramLink> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/telegram/shared",
    method: "POST",
    body: { projectId: input.projectId },
  });
}

export interface SlackInstallState {
  /** Uno's Slack app is set up on the console. */
  readonly available: boolean;
  readonly installed: boolean;
  readonly teamName: string | null;
  readonly botUserName: string | null;
  /** The computer is listening to the installation. */
  readonly connected: boolean;
}

export function startSlackInstall(
  input: EnvironmentScoped & { readonly projectId: string },
): Promise<{ readonly available: boolean; readonly authorizeUrl: string | null }> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/slack/install",
    method: "POST",
    body: { projectId: input.projectId },
  });
}

export function getSlackInstall(
  input: EnvironmentScoped & { readonly projectId: string },
): Promise<SlackInstallState> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/slack/install",
    searchParams: { projectId: input.projectId },
  });
}

export function removeSlackInstall(
  input: EnvironmentScoped & { readonly projectId: string },
): Promise<unknown> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/slack/install",
    method: "DELETE",
    searchParams: { projectId: input.projectId },
  });
}

/**
 * Opens a provider's sign-in in a small window (a popup keeps Uno Work
 * where it is). Resolves when the console's callback page reports back
 * (`postMessage` {type, ok}) or the window closes. Popup blocked → a new tab.
 */
export function openAuthWindow(
  url: string,
  messageType: "uno-connector" | "uno-slack",
): Promise<{ readonly ok: boolean; readonly closed: boolean }> {
  return new Promise((resolve) => {
    const width = 520;
    const height = 680;
    const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
    const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
    const popup = window.open(
      url,
      "uno-auth",
      `popup=yes,width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)}`,
    );
    let done = false;
    const finish = (result: { ok: boolean; closed: boolean }) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      window.clearInterval(timer);
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { readonly type?: unknown; readonly ok?: unknown } | null;
      if (!data || data.type !== messageType) return;
      finish({ ok: data.ok === true, closed: false });
    };
    window.addEventListener("message", onMessage);
    const timer = window.setInterval(() => {
      if (!popup || popup.closed) finish({ ok: false, closed: true });
    }, 700);
  });
}
