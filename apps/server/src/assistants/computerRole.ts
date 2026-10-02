/**
 * This computer's role in the account (`computer_role` of its box: workspace,
 * server, assistant, …), read from the console with the machine's own token.
 *
 * Only a cloud computer has one; a laptop (no `uno.boxToken`) answers null.
 * The answer is cached: the role is set when the computer is created and the
 * callers (a Hermes session start) must not wait on the console every time.
 * A failed lookup is cached for a shorter while and reads as null — callers
 * treat "unknown" as "not an assistant", plus their own local signals.
 *
 * @module assistants/computerRole
 */
import { readWorkMachineIdentity, type FetchLike } from "../manager/workConsole.ts";
import { controlPlaneBaseUrl } from "../workspaceRegistry/unoCloudParse.ts";

/** `computer_role` of a computer that runs one assistant (contract §1). */
export const ASSISTANT_COMPUTER_ROLE = "assistant";

const ROLE_TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 3_000;

/** `computer_role` from a `GET /api/v1/boxes/{id}` body, or null. */
export function parseComputerRole(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const role = (body as { computer_role?: unknown }).computer_role;
  return typeof role === "string" && role.trim().length > 0 ? role.trim() : null;
}

export interface OwnComputerRoleReaderDeps {
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
}

/** `settings.uno` as far as the machine identity goes. */
export type UnoMachineSettings =
  | {
      readonly boxToken?: string | undefined;
      readonly boxId?: number | null | undefined;
    }
  | null
  | undefined;

/**
 * A cached reader of this computer's role; never throws. Pass the current
 * `settings.uno` on every call: off a cloud computer it answers null at once.
 */
export function makeOwnComputerRoleReader(
  deps: OwnComputerRoleReaderDeps = {},
): (uno: UnoMachineSettings) => Promise<string | null> {
  let cached: {
    readonly boxId: number;
    readonly role: string | null;
    readonly until: number;
  } | null = null;
  let inFlight: Promise<string | null> | null = null;
  const now = deps.now ?? Date.now;

  const lookup = async (identity: { boxToken: string; boxId: number }): Promise<string | null> => {
    const remember = (role: string | null, ttlMs: number) => {
      cached = { boxId: identity.boxId, role, until: now() + ttlMs };
      return role;
    };
    try {
      const response = await (deps.fetchImpl ?? globalThis.fetch)(
        `${controlPlaneBaseUrl()}/api/v1/boxes/${identity.boxId}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${identity.boxToken}` },
          signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        },
      );
      if (!response.ok) return remember(null, FAILURE_TTL_MS);
      return remember(parseComputerRole(await response.json().catch(() => null)), ROLE_TTL_MS);
    } catch {
      return remember(null, FAILURE_TTL_MS);
    }
  };

  return (uno) => {
    const identity = readWorkMachineIdentity(uno);
    if (identity === null) return Promise.resolve(null);
    if (cached !== null && cached.boxId === identity.boxId && cached.until > now()) {
      return Promise.resolve(cached.role);
    }
    inFlight ??= lookup(identity).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
