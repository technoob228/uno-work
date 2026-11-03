/**
 * M7: this cloud computer's own ed25519 key, and the signed frames it sends to
 * the helper on the person's computer (`v: 2`).
 *
 * Why: the console only relays frames. Before M7 a console that was broken
 * into could tell every connected laptop to run anything. Now the helper runs
 * only what a key it trusts signed: the keys of the person's cloud computers at
 * the moment the laptop was paired (or paired again from a new cloud computer).
 * The console can't add a key and can't forge a frame.
 *
 * The key lives in `<stateDir>/my-computer/box-key.json` (0600) together with
 * what it was made for (the box id, else a fingerprint of the machine token):
 * an image cloned to another box sees a different owner and makes a key of
 * its own, so clones never share one (the 19.10 shared-token lesson).
 *
 * Envelope: `{ v: 2, id, kid, sig, p }`, where `p` is the inner request as JSON
 * text (`op` and its fields plus `id`, `computerId`, `ts`, `nonce`) and `sig`
 * is ed25519 over the UTF-8 bytes of `p`. The console still appends `ch`.
 *
 * @module myComputer/frameSigning
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as signBytes,
  type KeyObject,
} from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

export const SIGNED_FRAME_VERSION = 2;

export interface BoxKey {
  /** Lowercase hex of the first 8 bytes of sha256(raw public key). */
  readonly kid: string;
  /** base64 (standard) of the raw 32-byte public key. */
  readonly publicKey: string;
  readonly privateKey: KeyObject;
}

export interface SignedEnvelope {
  readonly v: typeof SIGNED_FRAME_VERSION;
  readonly id: string;
  readonly kid: string;
  readonly sig: string;
  readonly p: string;
}

interface StoredKey {
  readonly version: 1;
  readonly owner: string;
  /** PKCS#8 DER, base64. */
  readonly privateKey: string;
}

export function keyIdOf(rawPublicKey: Buffer): string {
  return createHash("sha256").update(rawPublicKey).digest().subarray(0, 8).toString("hex");
}

function rawPublicKeyOf(privateKey: KeyObject): Buffer {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("not an ed25519 key");
  return Buffer.from(jwk.x, "base64url");
}

function boxKeyOf(privateKey: KeyObject): BoxKey {
  const raw = rawPublicKeyOf(privateKey);
  return { kid: keyIdOf(raw), publicKey: raw.toString("base64"), privateKey };
}

/**
 * Who this key is for: `box:<id>` when the box id is known, else a short
 * fingerprint of the machine token (a clone gets its own token at
 * individualization). "" when neither is known: no key then.
 */
export function keyOwner(input: { readonly boxId: number | null; readonly token: string }): string {
  if (input.boxId !== null && input.boxId > 0) return `box:${input.boxId}`;
  if (input.token.length > 0) {
    return `token:${createHash("sha256").update(input.token).digest("hex").slice(0, 16)}`;
  }
  return "";
}

const keyFile = (stateDir: string) => path.join(stateDir, "my-computer", "box-key.json");

/**
 * This computer's key for `owner`: read, or made and saved when missing or
 * made for someone else. One writer per process (callers memoize).
 */
export async function loadOrCreateBoxKey(stateDir: string, owner: string): Promise<BoxKey> {
  const file = keyFile(stateDir);
  try {
    const stored = JSON.parse(await fsp.readFile(file, "utf8")) as Partial<StoredKey>;
    if (stored.version === 1 && stored.owner === owner && typeof stored.privateKey === "string") {
      const privateKey = createPrivateKey({
        key: Buffer.from(stored.privateKey, "base64"),
        format: "der",
        type: "pkcs8",
      });
      if (privateKey.asymmetricKeyType === "ed25519") return boxKeyOf(privateKey);
    }
  } catch {
    // Missing or unreadable: a new one below.
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const body: StoredKey = { version: 1, owner, privateKey: Buffer.from(der).toString("base64") };
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  await fsp.rename(temp, file);
  return boxKeyOf(privateKey);
}

/**
 * The signed form of one request. `frame` is the request without `id`; the
 * inner JSON carries the id, the target computer, the time and a nonce, so a
 * frame can't be replayed later, to another computer, or under another id.
 */
export function signFrame(input: {
  readonly key: BoxKey;
  readonly id: string;
  readonly computerId: string;
  readonly frame: Readonly<Record<string, unknown>>;
  readonly now?: number;
}): SignedEnvelope {
  const inner = JSON.stringify({
    ...input.frame,
    id: input.id,
    computerId: input.computerId,
    ts: input.now ?? Date.now(),
    nonce: randomBytes(16).toString("base64url"),
  });
  const sig = signBytes(null, Buffer.from(inner, "utf8"), input.key.privateKey).toString("base64");
  return { v: SIGNED_FRAME_VERSION, id: input.id, kid: input.key.kid, sig, p: inner };
}

/** Helper error codes of M7 refusals, with what the agent should hear. */
export const SIGNATURE_REFUSALS: Readonly<Record<string, string>> = {
  untrusted_key:
    "doesn't trust this cloud computer yet. The person can connect it again from here (Add computer, the same one command): it keeps its chats.",
  unsigned_frame:
    "only takes signed requests from Uno, and this Uno Work sent an unsigned one. Updating Uno Work fixes it.",
  bad_signature:
    "refused a request whose signature didn't match. Try again; if it repeats, tell the person.",
  stale_frame:
    "refused a request as too old: its clock and this computer's differ by more than 5 minutes. Ask the person to check the date and time on it.",
  replayed_frame: "refused a repeated request. Try again.",
  wrong_computer: "refused a request meant for another computer.",
};
