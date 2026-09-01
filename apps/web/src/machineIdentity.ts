/**
 * Short display identity for a machine (environment): a monogram plus one of a
 * small number of validated hues.
 *
 * Two rules drive everything here, and both exist because the alternative is
 * visibly wrong rather than merely untidy:
 *
 * 1. **The monogram is the identity; the hue is reinforcement.** Only three
 *    hues survive colour-vision validation against this app's surfaces, so a
 *    fourth machine gets a neutral chip instead of a generated colour. Letters
 *    never run out, so identity never depends on a colour a reader may not be
 *    able to separate.
 * 2. **A hue follows the machine, not its position in the list.** Slots are
 *    pinned on first sight and persisted; recomputing them from the current
 *    list would repaint chips the user had already learned every time a machine
 *    was added or removed.
 *
 * Machine *health* (live / stale / offline) is deliberately not represented
 * here: it belongs to the reserved status palette and is rendered as a separate
 * dot, so a machine's identity never changes colour when it goes down.
 */

import {
  SIDEBAR_MACHINE_COLOR_SLOT_COUNT,
  SIDEBAR_MACHINE_MONOGRAM_MAX_LENGTH,
} from "@t3tools/contracts/settings";

export interface MachineIdentityCandidate {
  readonly environmentId: string;
  /** Human label if one has loaded; `null` while it has not. */
  readonly label: string | null;
}

export interface PersistedMachineIdentity {
  /** User override. Empty means "use the derived monogram". */
  readonly monogram: string;
  /** `0` = neutral (unassigned or overflow); `1…3` = a pinned hue. */
  readonly colorSlot: number;
}

export interface MachineIdentity {
  readonly environmentId: string;
  /** What to render in the chip: 1–3 characters, upper case. */
  readonly monogram: string;
  readonly colorSlot: number;
  /** Full label for tooltips and lists; never empty. */
  readonly label: string;
  /** True when the monogram came from the user rather than the label. */
  readonly isMonogramOverridden: boolean;
}

export interface ResolveMachineIdentitiesResult {
  readonly identities: ReadonlyMap<string, MachineIdentity>;
  /**
   * Slots that were assigned during this call and are not yet persisted. The
   * caller writes these back so the assignment becomes permanent — without
   * that step colours would be re-derived (and could move) on the next run.
   */
  readonly slotsToPin: ReadonlyMap<string, number>;
  /**
   * First-seen order including machines seen for the first time in this call,
   * for the caller to persist. Ids that are no longer present are preserved:
   * a machine that goes away and comes back should keep its place, and its hue
   * with it.
   */
  readonly order: readonly string[];
}

const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/u;

/** Short, stable stand-in for a machine whose label has not loaded yet. */
export function fallbackMachineLabel(environmentId: string): string {
  return environmentId.slice(0, 8);
}

/**
 * Normalise a user-supplied monogram: upper case, no whitespace, capped.
 *
 * Returns the empty string when nothing usable remains, which callers read as
 * "no override" rather than "an empty chip".
 */
export function normalizeMonogramOverride(value: string): string {
  const compact = value.replace(/\s+/gu, "");
  if (compact.length === 0) {
    return "";
  }
  return compact.slice(0, SIDEBAR_MACHINE_MONOGRAM_MAX_LENGTH).toLocaleUpperCase();
}

/**
 * Derive a two-character monogram from a label.
 *
 * Multi-word labels take the initials of the first two words (`cozy-maple` →
 * `CM`); single-word labels take the first two characters (`hostkey81337` →
 * `HO`). Deliberately literal rather than clever: a rule that picked "nice"
 * letters would be unpredictable, and the user can override any result.
 *
 * Collisions are *not* resolved by asking for a third letter — see
 * `resolveMachineIdentities`. A third letter drawn from the spelling carries no
 * information ("HOS" tells you nothing about which host it is), whereas a
 * numeric suffix says exactly what it is: the second machine whose name starts
 * this way.
 */
export function deriveMonogram(label: string): string {
  const words = label.split(NON_ALPHANUMERIC).filter((word) => word.length > 0);
  if (words.length === 0) {
    return "?";
  }
  const monogram =
    words.length >= 2
      ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`
      : (words[0] ?? "").slice(0, 2);
  return monogram.toLocaleUpperCase();
}

/**
 * Stable order for the machines we know about: previously seen ids in their
 * recorded order, then newcomers by id.
 *
 * Newcomers are sorted rather than taken in arrival order because arrival order
 * depends on which environment's socket connected first, which varies run to
 * run — and slot assignment reads this order.
 */
function resolveStableOrder(
  candidates: ReadonlyArray<MachineIdentityCandidate>,
  persistedOrder: readonly string[],
): string[] {
  const present = new Set(candidates.map((candidate) => candidate.environmentId));
  const ordered: string[] = [];
  const placed = new Set<string>();
  for (const environmentId of persistedOrder) {
    if (placed.has(environmentId)) {
      continue;
    }
    placed.add(environmentId);
    ordered.push(environmentId);
  }
  const newcomers = [...present].filter((environmentId) => !placed.has(environmentId)).toSorted();
  return [...ordered, ...newcomers];
}

/**
 * Give every machine a monogram and a hue slot.
 *
 * `persisted` carries user overrides and previously pinned slots; `order`
 * carries first-seen order. Both are pure inputs — the function returns what
 * should be written back rather than writing anything itself, so it stays
 * testable and callers can batch the persistence.
 */
export function resolveMachineIdentities(input: {
  readonly machines: ReadonlyArray<MachineIdentityCandidate>;
  readonly persisted: Readonly<Record<string, PersistedMachineIdentity>>;
  readonly order: readonly string[];
}): ResolveMachineIdentitiesResult {
  const order = resolveStableOrder(input.machines, input.order);
  const byId = new Map(input.machines.map((machine) => [machine.environmentId, machine]));

  // Slots already spoken for, including by machines that are not currently
  // present: a hue stays reserved for a machine that is merely offline.
  const takenSlots = new Set<number>();
  for (const entry of Object.values(input.persisted)) {
    if (entry.colorSlot >= 1 && entry.colorSlot <= SIDEBAR_MACHINE_COLOR_SLOT_COUNT) {
      takenSlots.add(entry.colorSlot);
    }
  }

  const slotsToPin = new Map<string, number>();
  const resolvedSlots = new Map<string, number>();
  for (const environmentId of order) {
    const persisted = input.persisted[environmentId];
    if (
      persisted !== undefined &&
      persisted.colorSlot >= 1 &&
      persisted.colorSlot <= SIDEBAR_MACHINE_COLOR_SLOT_COUNT
    ) {
      resolvedSlots.set(environmentId, persisted.colorSlot);
      continue;
    }
    if (!byId.has(environmentId)) {
      // Not connected and never pinned — nothing to assign yet.
      continue;
    }
    let assigned = 0;
    for (let slot = 1; slot <= SIDEBAR_MACHINE_COLOR_SLOT_COUNT; slot += 1) {
      if (!takenSlots.has(slot)) {
        assigned = slot;
        break;
      }
    }
    resolvedSlots.set(environmentId, assigned);
    if (assigned >= 1) {
      takenSlots.add(assigned);
      slotsToPin.set(environmentId, assigned);
    }
  }

  // Monograms, with collisions broken deterministically in stable order: the
  // first claimant keeps the short form, later ones lengthen and then take a
  // numeric suffix. Walking `order` (not arrival order) is what makes the
  // outcome the same on every run.
  const identities = new Map<string, MachineIdentity>();
  const usedMonograms = new Set<string>();
  for (const environmentId of order) {
    const machine = byId.get(environmentId);
    if (machine === undefined) {
      continue;
    }
    const label =
      machine.label !== null && machine.label.trim().length > 0
        ? machine.label.trim()
        : fallbackMachineLabel(environmentId);
    const override = normalizeMonogramOverride(input.persisted[environmentId]?.monogram ?? "");
    let monogram = override.length > 0 ? override : deriveMonogram(label);
    if (override.length === 0 && usedMonograms.has(monogram)) {
      const stem = monogram.slice(0, SIDEBAR_MACHINE_MONOGRAM_MAX_LENGTH - 1);
      let suffix = 2;
      monogram = `${stem}${suffix}`;
      while (usedMonograms.has(monogram)) {
        suffix += 1;
        // Single digit keeps the chip to three characters. Ten machines whose
        // names start alike is past the point where a monogram helps, so fall
        // back to the environment id, which is unique by construction.
        if (suffix > 9) {
          monogram = environmentId
            .slice(0, SIDEBAR_MACHINE_MONOGRAM_MAX_LENGTH)
            .toLocaleUpperCase();
          break;
        }
        monogram = `${stem}${suffix}`;
      }
    }
    usedMonograms.add(monogram);
    identities.set(environmentId, {
      environmentId,
      monogram,
      colorSlot: resolvedSlots.get(environmentId) ?? 0,
      label,
      isMonogramOverridden: override.length > 0,
    });
  }

  return { identities, slotsToPin, order };
}
