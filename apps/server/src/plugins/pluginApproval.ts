/**
 * Plugin manifest approval.
 *
 * Plugins are installed by writing files — usually by an agent. So that a
 * manifest cannot start running shell commands (or serving a panel) behind the
 * user's back, the daemon only activates a plugin whose manifest the user
 * approved in Settings → Extensions. What is approved is the sha256 of the
 * canonical manifest; any change to it (a new command, another cron, a
 * repointed panel) makes the plugin inactive again until re-approved.
 *
 * `enabled` is excluded from the hash: flipping the toggle is the user's own
 * action and must not require re-approval.
 *
 * Records live in `<stateDir>/plugin-approvals.json`, outside the plugins
 * directory, and each one is HMAC-signed (plugin id + manifest hash) with a key
 * from the server secret store. A record that is unsigned or mis-signed counts
 * as "not approved", so approvals cannot be forged by writing that JSON file.
 *
 * One-off upgrade migration: when the signing key does not exist yet (first
 * run of a daemon that knows about approvals), every plugin that is installed,
 * valid and enabled at that moment is grandfathered with signed records. Key
 * existence is the "done" flag — a deleted or corrupted approvals file later on
 * means "nothing approved", never a second grandfathering.
 *
 * LIMITATION: the agent runs under the same OS user as the daemon, so it can in
 * principle read the secret store (`<stateDir>/secrets`, 0600 but same uid) and
 * mint valid records. This raises the bar from "write a JSON file" to
 * "deliberately steal a key"; real separation needs the agent to run under a
 * different uid than the daemon.
 */
import { createHash, randomBytes } from "node:crypto";

import type { PluginManifest } from "@t3tools/contracts";

import { signPayload, timingSafeEqualBase64Url } from "../auth/utils.ts";

export const PLUGIN_APPROVALS_FILE = "plugin-approvals.json";
/** Secret store entry holding the HMAC key for approval records. */
export const PLUGIN_APPROVALS_KEY_SECRET = "plugin-approvals-hmac";
export const PLUGIN_APPROVALS_KEY_BYTES = 32;
const PLUGIN_APPROVALS_VERSION = 2;
const APPROVAL_RECORD_DOMAIN = "uno-plugin-approval-v1";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export type PluginApprovalStatus = "approved" | "new" | "changed";

/** Verified approvals: pluginId → approved manifest hash. */
export type PluginApprovals = Readonly<Record<string, string>>;

export function generatePluginApprovalsKey(): Uint8Array {
  return new Uint8Array(randomBytes(PLUGIN_APPROVALS_KEY_BYTES));
}

/**
 * JSON with object keys sorted at every level and `undefined` members dropped,
 * so the hash depends on content only, not on key order or formatting.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** sha256 (hex) of the canonical decoded manifest, without `enabled`. */
export function manifestApprovalHash(manifest: PluginManifest): string {
  const { enabled: _enabled, ...rest } = manifest;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

export function approvalRecordSignature(key: Uint8Array, pluginId: string, hash: string): string {
  return signPayload([APPROVAL_RECORD_DOMAIN, pluginId, hash].join("\u0000"), key);
}

export function pluginApprovalStatus(
  approvals: PluginApprovals,
  pluginId: string,
  manifestHash: string,
): PluginApprovalStatus {
  const approvedHash = approvals[pluginId];
  if (approvedHash === undefined) return "new";
  return approvedHash === manifestHash ? "approved" : "changed";
}

/**
 * One-off upgrade step: every installed, valid and enabled plugin becomes
 * approved. The caller runs it only when the signing key is created.
 */
export function grandfatherPluginApprovals(
  plugins: ReadonlyArray<{ readonly id: string; readonly manifest: PluginManifest | undefined }>,
): PluginApprovals {
  const approved: Record<string, string> = {};
  for (const plugin of plugins) {
    if (plugin.manifest === undefined || !plugin.manifest.enabled) continue;
    approved[plugin.id] = manifestApprovalHash(plugin.manifest);
  }
  return approved;
}

export function approvePluginManifest(
  approvals: PluginApprovals,
  pluginId: string,
  manifestHash: string,
): PluginApprovals {
  return { ...approvals, [pluginId]: manifestHash };
}

/**
 * Keeps only records whose signature verifies with `key`; anything else — bad
 * JSON, unsigned or mis-signed entries — is dropped (fails closed).
 */
export function parsePluginApprovals(raw: string, key: Uint8Array): PluginApprovals {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const records = (parsed as Record<string, unknown>).approved;
  if (records === null || typeof records !== "object" || Array.isArray(records)) return {};
  const approved: Record<string, string> = {};
  for (const [pluginId, record] of Object.entries(records as Record<string, unknown>)) {
    if (record === null || typeof record !== "object") continue;
    const { hash, sig } = record as Record<string, unknown>;
    if (typeof hash !== "string" || !SHA256_HEX_PATTERN.test(hash)) continue;
    if (typeof sig !== "string" || sig.length === 0) continue;
    if (!timingSafeEqualBase64Url(sig, approvalRecordSignature(key, pluginId, hash))) continue;
    approved[pluginId] = hash;
  }
  return approved;
}

export function serializePluginApprovals(approvals: PluginApprovals, key: Uint8Array): string {
  const records: Record<string, { hash: string; sig: string }> = {};
  for (const [pluginId, hash] of Object.entries(approvals).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    records[pluginId] = { hash, sig: approvalRecordSignature(key, pluginId, hash) };
  }
  return `${JSON.stringify({ version: PLUGIN_APPROVALS_VERSION, approved: records }, null, 2)}\n`;
}
