/**
 * "Add to Slack" for the Uno Work desktop app on a laptop (21.10).
 *
 * A cloud computer talks to the console as itself (its machine token) and
 * sets Uno's Slack app up on its own. A laptop's server has no identity at
 * the console — the person's sign-in lives in the desktop's main process
 * (`window.desktopBridge.unoAccount`, "Sign in with Uno"). So here the
 * interface does the console's part with that sign-in:
 *
 *   1. console `GET /api/v1/work/slack/device` — this desktop's installation;
 *   2. local server `POST /api/manager/assistant/slack/device` with that
 *      answer — it stores the relay like a cloud computer would;
 *   3. if the server says `needsRelay`, console
 *      `POST /api/v1/work/slack/device/relay` → a relay token (`slr_…`) for
 *      the server only, and step 2 again with it.
 *
 * The server polls the relay while Uno Work is open; nothing wakes a laptop,
 * so the console keeps what arrives meanwhile for `queue_ttl_hours` (24).
 *
 * The orchestration takes its two transports as arguments: tests drive it
 * without a desktop or a server.
 *
 * @module lib/deviceSlack
 */
import type { ManagerSlackRoutingStatus } from "@t3tools/contracts";

/** One call to the console as the signed-in person (`accountRequest`). */
export type AccountCall = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<unknown>;

export interface DeviceSlackSyncBody {
  readonly projectId: string;
  readonly available: boolean;
  readonly installed: boolean;
  readonly teamName: string | null;
  readonly botUserName: string | null;
  readonly installerUserId: string | null;
  readonly relayFingerprint: string | null;
  readonly relayToken?: string;
}

export interface DeviceSlackSyncResult {
  readonly available: boolean;
  readonly installed: boolean;
  readonly teamName: string | null;
  readonly botUserName: string | null;
  readonly connected: boolean;
  readonly installerDmReady: boolean;
  readonly needsRelay: boolean;
  /** Several computers (or Uno accounts) in the workspace (console 257). */
  readonly routing?: ManagerSlackRoutingStatus;
}

export interface DeviceSlackDeps {
  readonly account: AccountCall;
  /** `POST /api/manager/assistant/slack/device` on this computer's server. */
  readonly sync: (body: DeviceSlackSyncBody) => Promise<DeviceSlackSyncResult>;
  /** `DELETE /api/manager/assistant/slack/device?projectId=` on this computer's server. */
  readonly forget: (projectId: string) => Promise<unknown>;
  /** The person isn't signed in with Uno in this app (`AccountSignInRequiredError`). */
  readonly isSignInRequired: (error: unknown) => boolean;
  /** The console's HTTP status of a refusal, or null. */
  readonly statusOf: (error: unknown) => number | null;
}

/** What the Slack card shows for the desktop app (setupApi's SlackInstallState + extras). */
export interface DeviceSlackState {
  readonly available: boolean;
  readonly installed: boolean;
  readonly teamName: string | null;
  readonly botUserName: string | null;
  readonly connected: boolean;
  /** Uno's app answers this desktop app, read only while Uno Work is open. */
  readonly device: true;
  /** How long Slack messages wait at Uno while Uno Work is closed. */
  readonly queueTtlHours: number;
  /** Sign in with Uno first (the desktop has no account yet). */
  readonly signInRequired: boolean;
  readonly routing?: ManagerSlackRoutingStatus;
}

/** The console's default when an older answer has no `queue_ttl_hours`. */
export const DEVICE_QUEUE_TTL_HOURS = 24;

const DEVICE_PATH = "/api/v1/work/slack/device";

const str = (body: unknown, key: string): string | null => {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const bool = (body: unknown, key: string): boolean =>
  typeof body === "object" && body !== null && (body as Record<string, unknown>)[key] === true;

const num = (body: unknown, key: string): number | null => {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
};

/** A line for the card: how a laptop answers in Slack. */
export function deviceSlackDeliveryLine(queueTtlHours: number): string {
  return `Answers while Uno Work is open on this computer; messages wait up to ${queueTtlHours} hours.`;
}

/** Read this desktop's installation and bring the local server in line with it. */
export async function readDeviceSlack(
  deps: DeviceSlackDeps,
  projectId: string,
): Promise<DeviceSlackState> {
  let consoleAnswer: unknown;
  try {
    consoleAnswer = await deps.account("GET", DEVICE_PATH);
  } catch (error) {
    if (deps.isSignInRequired(error)) {
      return {
        available: false,
        installed: false,
        teamName: null,
        botUserName: null,
        connected: false,
        device: true,
        queueTtlHours: DEVICE_QUEUE_TTL_HOURS,
        signInRequired: true,
      };
    }
    throw error;
  }
  const body: DeviceSlackSyncBody = {
    projectId,
    available: bool(consoleAnswer, "available"),
    installed: bool(consoleAnswer, "installed"),
    teamName: str(consoleAnswer, "team_name"),
    botUserName: str(consoleAnswer, "bot_user_name"),
    installerUserId: str(consoleAnswer, "installer_user_id"),
    relayFingerprint: str(consoleAnswer, "relay_fingerprint"),
  };
  let synced = await deps.sync(body);
  if (synced.needsRelay) {
    const minted = await deps.account("POST", `${DEVICE_PATH}/relay`, {});
    const relayToken = str(minted, "relay_token");
    if (relayToken === null) throw new Error("Uno didn't hand this computer its Slack connection.");
    synced = await deps.sync({ ...body, relayToken });
  }
  return {
    available: synced.available,
    installed: synced.installed,
    teamName: synced.teamName,
    botUserName: synced.botUserName,
    connected: synced.connected,
    device: true,
    queueTtlHours: num(consoleAnswer, "queue_ttl_hours") ?? DEVICE_QUEUE_TTL_HOURS,
    signInRequired: false,
    ...(synced.routing !== undefined ? { routing: synced.routing } : {}),
  };
}

/** Where to send the person to add Uno's app to their workspace, for this desktop. */
export async function startDeviceSlack(
  deps: DeviceSlackDeps,
): Promise<{ readonly available: boolean; readonly authorizeUrl: string | null }> {
  try {
    const answer = await deps.account("POST", `${DEVICE_PATH}/install`, {});
    const authorizeUrl = str(answer, "authorize_url");
    if (authorizeUrl === null) throw new Error("Uno didn't return a Slack link. Try again.");
    return { available: true, authorizeUrl };
  } catch (error) {
    // 503 SLACK_APP_NOT_CONFIGURED: Uno's app isn't set up on the console.
    if (deps.statusOf(error) === 503) return { available: false, authorizeUrl: null };
    throw error;
  }
}

/** Remove Uno's app for this desktop at the console, then forget the relay here. */
export async function removeDeviceSlack(deps: DeviceSlackDeps, projectId: string): Promise<void> {
  await deps.account("DELETE", DEVICE_PATH);
  await deps.forget(projectId);
}
