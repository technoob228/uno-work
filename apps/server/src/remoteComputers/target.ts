/**
 * Which computer of the account a chat goes to, and how to reach its daemon —
 * the pure half of "an assistant starts a chat on another computer"
 * (assistants D, 28.10; audit 27.10 #2).
 *
 * - {@link resolveComputerRef}: what the agent passed as `computerId` (a box
 *   id, `"box-N"`, a computer's name from `account_overview`, or `"this"`)
 *   against the account's computer list.
 * - {@link pairingTargetFromUrl}: the console's one-time pairing link
 *   (`POST /api/v1/boxes/{id}/work/session` → `https://<host>/pair#token=…`)
 *   split into the daemon's base URL and the credential, the same way the web
 *   app reads it (`apps/web/src/environments/remote/target.ts`).
 *
 * @module remoteComputers/target
 */
import type { UnoBox } from "@t3tools/contracts";

const THIS_COMPUTER_WORDS = new Set(["", "this", "self", "local", "here"]);

export type ComputerRef =
  | { readonly kind: "this" }
  | { readonly kind: "box"; readonly box: Pick<UnoBox, "id" | "name" | "status"> }
  | { readonly kind: "unknown"; readonly message: string };

const describeList = (boxes: ReadonlyArray<Pick<UnoBox, "id" | "name">>) =>
  boxes.length === 0
    ? "The account has no other computers."
    : `Computers of the account: ${boxes.map((box) => `${box.name} (box-${box.id})`).join(", ")}.`;

/**
 * `computerId` as the agent passed it. A number or `"box-N"` / `"N"` names a
 * box; anything else is matched against the computers' names (case and
 * spacing ignored). This computer — by word, id or name — is `this`.
 */
export function resolveComputerRef(
  raw: unknown,
  input: {
    readonly boxes: ReadonlyArray<Pick<UnoBox, "id" | "name" | "status">>;
    readonly ownBoxId: number | null;
  },
): ComputerRef {
  if (raw === undefined || raw === null) return { kind: "this" };
  const others = input.boxes.filter((box) => box.id !== input.ownBoxId);
  const byId = (id: number): ComputerRef => {
    if (input.ownBoxId !== null && id === input.ownBoxId) return { kind: "this" };
    const box = input.boxes.find((candidate) => candidate.id === id);
    return box === undefined
      ? {
          kind: "unknown",
          message: `There is no computer box-${id} in this Uno account. ${describeList(others)}`,
        }
      : { kind: "box", box };
  };
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw > 0
      ? byId(raw)
      : { kind: "unknown", message: `"${raw}" is not a computer id. ${describeList(others)}` };
  }
  if (typeof raw !== "string") {
    return { kind: "unknown", message: `computerId is a box id or a computer's name.` };
  }
  const value = raw.trim().toLowerCase();
  if (THIS_COMPUTER_WORDS.has(value)) return { kind: "this" };
  const id = /^(?:box-?)?(\d+)$/.exec(value)?.[1];
  if (id !== undefined) return byId(Number(id));
  const normalized = value.replace(/\s+/g, " ");
  const named = input.boxes.filter(
    (box) => box.name.trim().toLowerCase().replace(/\s+/g, " ") === normalized,
  );
  if (named.length === 1) {
    const box = named[0]!;
    return input.ownBoxId !== null && box.id === input.ownBoxId
      ? { kind: "this" }
      : { kind: "box", box };
  }
  if (named.length > 1) {
    return {
      kind: "unknown",
      message: `Several computers are called "${raw.trim()}": ${named.map((box) => `box-${box.id}`).join(", ")}. Pass the box id.`,
    };
  }
  return {
    kind: "unknown",
    message: `There is no computer "${raw.trim()}" in this Uno account. ${describeList(others)}`,
  };
}

export interface PairingTarget {
  /** The daemon's origin with a trailing slash, e.g. `https://box.app.uno4.dev/`. */
  readonly httpBaseUrl: string;
  /** One-time pairing credential, traded for a bearer session. Never logged. */
  readonly credential: string;
}

const readToken = (url: URL): string | null => {
  const hash = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const fromHash = hash.get("token")?.trim() ?? "";
  if (fromHash.length > 0) return fromHash;
  const fromQuery = url.searchParams.get("token")?.trim() ?? "";
  return fromQuery.length > 0 ? fromQuery : null;
};

const originOf = (raw: string): string | null => {
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}/`;
  } catch {
    return null;
  }
};

/**
 * `https://<host>/pair#token=…` (or a hosted `…?host=<backend>#token=…`) →
 * the daemon's base URL and the credential; null when the link carries no
 * token or is not http(s).
 */
export function pairingTargetFromUrl(raw: string): PairingTarget | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const credential = readToken(url);
  if (credential === null) return null;
  const hostParam = url.searchParams.get("host")?.trim() ?? "";
  const httpBaseUrl = hostParam.length > 0 ? originOf(hostParam) : originOf(url.toString());
  return httpBaseUrl === null ? null : { httpBaseUrl, credential };
}
