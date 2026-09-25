/**
 * The Uno console (control plane) as the `uno-work` tools see it: sites'
 * password and forms, managed databases.
 *
 * Calls go with THIS computer's own token (`settings.uno.boxToken`, the
 * work-machine token the console wrote at sign-in; its rights are set by the
 * person in Settings, Computer access, and the console checks the owner of
 * every site and database). On a laptop without it, the account key a person
 * put in Settings is used — never the AI key (`unollm_…`), which the console
 * does not accept.
 *
 * Bodies are never logged: a database connection string comes back here.
 */
import type { ServerSettings } from "@t3tools/contracts";

/** The AI key's prefix (`unoGatewayKey.ts`): the console answers it 401. */
const AI_KEY_PREFIX = "unollm_";

export interface ConsoleReply {
  readonly status: number;
  readonly body: unknown;
}

export interface ConsoleRequest {
  readonly method: "GET" | "POST" | "PUT";
  /** `/api/v1/...` */
  readonly path: string;
  readonly body?: unknown;
}

const CONSOLE_TIMEOUT_MS = 60_000;

/** The credential the tools may use, or "" when this computer isn't linked. */
export function consoleToken(settings: Pick<ServerSettings, "uno">): string {
  const machine = settings.uno.boxToken?.trim() ?? "";
  if (machine.length > 0) return machine;
  const account = settings.uno.apiKey.trim();
  return account.startsWith(AI_KEY_PREFIX) ? "" : account;
}

export async function consoleRequest(
  input: ConsoleRequest & {
    readonly baseUrl: string;
    readonly token: string;
    readonly fetchImpl?: typeof fetch;
  },
): Promise<ConsoleReply> {
  const response = await (input.fetchImpl ?? fetch)(`${input.baseUrl}${input.path}`, {
    method: input.method,
    headers: {
      authorization: `Bearer ${input.token}`,
      ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    signal: AbortSignal.timeout(CONSOLE_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // plain-text answer
  }
  return { status: response.status, body };
}
