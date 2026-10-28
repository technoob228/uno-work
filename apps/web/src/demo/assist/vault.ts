/**
 * The password vault of each demo computer (`vault.list` / `vault.upsert`),
 * as the daemon keeps it: the page gets metadata back, never a password. The
 * demo doesn't keep the password either — only that one was given — so a flow
 * can check it reached the vault and nowhere else.
 */
import { answerTeamRpc } from "../assistantsFixtures";

interface SavedLogin {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly username: string;
  readonly updatedAt: number;
  /** A password was given (its value is dropped here, like a log would). */
  readonly passwordSaved: boolean;
}

const byEnvironment = new Map<string, SavedLogin[]>();
let nextId = 1;

function savedOn(environmentId: string): SavedLogin[] {
  const list = byEnvironment.get(environmentId) ?? [];
  byEnvironment.set(environmentId, list);
  return list;
}

const meta = ({ passwordSaved: _dropped, ...entry }: SavedLogin) => entry;

/** The answer to a vault RPC of that computer, or undefined for any other RPC. */
export function answerVaultRpc(
  environmentId: string,
  tag: string,
  body: Readonly<Record<string, unknown>>,
): unknown {
  if (tag === "vault.list") {
    const base = (answerTeamRpc("vault.list") as ReadonlyArray<unknown> | undefined) ?? [];
    return [...base, ...savedOn(environmentId).map(meta)];
  }
  if (tag !== "vault.upsert") return undefined;
  const input = (body["input"] ?? {}) as Record<string, unknown>;
  const list = savedOn(environmentId);
  const id = typeof body["id"] === "string" ? body["id"] : `demo-login-${nextId++}`;
  const before = list.find((entry) => entry.id === id);
  const entry: SavedLogin = {
    id,
    label: String(input["label"] ?? ""),
    url: String(input["url"] ?? ""),
    username: String(input["username"] ?? ""),
    updatedAt: Date.now(),
    passwordSaved:
      (typeof input["password"] === "string" && input["password"].length > 0) ||
      (before?.passwordSaved ?? false),
  };
  if (before) list.splice(list.indexOf(before), 1, entry);
  else list.push(entry);
  return meta(entry);
}

/** For flows: what that computer's vault holds (no passwords — only whether one was saved). */
export function demoVault(environmentId: string): ReadonlyArray<SavedLogin> {
  return [...savedOn(environmentId)];
}
