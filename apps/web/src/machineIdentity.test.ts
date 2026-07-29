import { describe, expect, it } from "vitest";

import {
  deriveMonogram,
  fallbackMachineLabel,
  normalizeMonogramOverride,
  resolveMachineIdentities,
  type MachineIdentityCandidate,
  type PersistedMachineIdentity,
} from "./machineIdentity";

function machine(environmentId: string, label: string | null): MachineIdentityCandidate {
  return { environmentId, label };
}

function resolve(
  machines: ReadonlyArray<MachineIdentityCandidate>,
  persisted: Record<string, PersistedMachineIdentity> = {},
  order: readonly string[] = [],
) {
  return resolveMachineIdentities({ machines, persisted, order });
}

describe("deriveMonogram", () => {
  it("takes initials from multi-word labels", () => {
    expect(deriveMonogram("cozy-maple")).toBe("CM");
    expect(deriveMonogram("vm-pico")).toBe("VP");
    expect(deriveMonogram("my dev box")).toBe("MD");
  });

  it("takes leading characters from single-word labels", () => {
    expect(deriveMonogram("hostkey81337")).toBe("HO");
    expect(deriveMonogram("prod")).toBe("PR");
  });

  it("handles non-latin and degenerate labels", () => {
    expect(deriveMonogram("этот мак")).toBe("ЭМ");
    expect(deriveMonogram("---")).toBe("?");
    expect(deriveMonogram("x")).toBe("X");
  });
});

describe("normalizeMonogramOverride", () => {
  it("upper-cases, strips whitespace and caps length", () => {
    expect(normalizeMonogramOverride(" prd ")).toBe("PRD");
    expect(normalizeMonogramOverride("production")).toBe("PRO");
    expect(normalizeMonogramOverride("h k")).toBe("HK");
  });

  it("returns empty for blank input so callers read it as no override", () => {
    expect(normalizeMonogramOverride("   ")).toBe("");
    expect(normalizeMonogramOverride("")).toBe("");
  });
});

describe("resolveMachineIdentities", () => {
  it("assigns hue slots in first-seen order and reports them for pinning", () => {
    const result = resolve([
      machine("env-a", "alpha"),
      machine("env-b", "bravo"),
      machine("env-c", "charlie"),
    ]);

    expect(result.identities.get("env-a")?.colorSlot).toBe(1);
    expect(result.identities.get("env-b")?.colorSlot).toBe(2);
    expect(result.identities.get("env-c")?.colorSlot).toBe(3);
    expect([...result.slotsToPin]).toEqual([
      ["env-a", 1],
      ["env-b", 2],
      ["env-c", 3],
    ]);
    expect(result.order).toEqual(["env-a", "env-b", "env-c"]);
  });

  it("gives a neutral chip past the validated slot count instead of inventing a hue", () => {
    const result = resolve([
      machine("env-a", "alpha"),
      machine("env-b", "bravo"),
      machine("env-c", "charlie"),
      machine("env-d", "delta"),
    ]);

    expect(result.identities.get("env-d")?.colorSlot).toBe(0);
    // Still identifiable: the monogram carries it.
    expect(result.identities.get("env-d")?.monogram).toBe("DE");
    expect(result.slotsToPin.has("env-d")).toBe(false);
  });

  it("keeps a pinned hue when other machines appear", () => {
    const persisted = { "env-b": { monogram: "", colorSlot: 2 } };
    const before = resolve([machine("env-b", "bravo")], persisted, ["env-b"]);
    expect(before.identities.get("env-b")?.colorSlot).toBe(2);

    const after = resolve([machine("env-a", "alpha"), machine("env-b", "bravo")], persisted, [
      "env-b",
    ]);
    // env-b must not be repainted, and env-a must not steal slot 2.
    expect(after.identities.get("env-b")?.colorSlot).toBe(2);
    expect(after.identities.get("env-a")?.colorSlot).toBe(1);
  });

  it("keeps a hue reserved for a machine that is currently absent", () => {
    const persisted = {
      "env-a": { monogram: "", colorSlot: 1 },
      "env-gone": { monogram: "", colorSlot: 2 },
    };
    const result = resolve([machine("env-a", "alpha"), machine("env-new", "november")], persisted, [
      "env-a",
      "env-gone",
    ]);

    // Slot 2 belongs to the offline machine, so the newcomer takes 3.
    expect(result.identities.get("env-new")?.colorSlot).toBe(3);
    expect(result.order).toEqual(["env-a", "env-gone", "env-new"]);
  });

  it("is order-independent for newcomers", () => {
    const forwards = resolve([machine("env-a", "alpha"), machine("env-b", "bravo")]);
    const backwards = resolve([machine("env-b", "bravo"), machine("env-a", "alpha")]);

    expect(forwards.identities.get("env-a")?.colorSlot).toBe(
      backwards.identities.get("env-a")?.colorSlot,
    );
    expect(forwards.order).toEqual(backwards.order);
  });

  it("breaks monogram collisions with a numeric suffix, first claimant keeps the short form", () => {
    const result = resolve([machine("env-a", "hostkey81337"), machine("env-b", "hostkey99000")]);

    expect(result.identities.get("env-a")?.monogram).toBe("HO");
    expect(result.identities.get("env-b")?.monogram).toBe("HO2");
  });

  it("resolves a three-way collision without repeating", () => {
    const result = resolve([
      machine("env-a", "prod-one"),
      machine("env-b", "prod-two"),
      machine("env-c", "prod-three"),
    ]);

    expect([...result.identities.values()].map((identity) => identity.monogram)).toEqual([
      "PO",
      "PT",
      "PT2",
    ]);
  });

  it("honours a user override and lets it win over derivation", () => {
    const result = resolve([machine("env-a", "hostkey81337")], {
      "env-a": { monogram: "hk", colorSlot: 0 },
    });

    const identity = result.identities.get("env-a");
    expect(identity?.monogram).toBe("HK");
    expect(identity?.isMonogramOverridden).toBe(true);
  });

  it("falls back to a short environment id when the label has not loaded", () => {
    const result = resolve([machine("env-abcdef123456", null)]);

    const identity = result.identities.get("env-abcdef123456");
    expect(identity?.label).toBe(fallbackMachineLabel("env-abcdef123456"));
    // "env-abcd" reads as two words, so the initials rule applies.
    expect(identity?.monogram).toBe("EA");
  });

  it("ignores an out-of-range persisted slot rather than rendering an unknown hue", () => {
    const result = resolve([machine("env-a", "alpha")], {
      "env-a": { monogram: "", colorSlot: 99 },
    });

    expect(result.identities.get("env-a")?.colorSlot).toBe(1);
  });
});
