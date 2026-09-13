/**
 * Which machine the app should reach for first.
 *
 * Used for where the app lands on open, which machine "Add project" and a
 * fresh chat draft preselect, and which row the sidebar switcher lists
 * first. One rule, one place:
 *
 *   1. the machine the user marked as default, if the app still knows it
 *      and can reach it right now;
 *   2. otherwise a computer of the user's own that is online — the place
 *      their files most likely are;
 *   3. otherwise the daemon serving the page;
 *   4. otherwise nothing.
 *
 * A chosen default that is offline is skipped, not honoured: landing on an
 * unreachable machine is a blank screen, and the user can pick it again once
 * it is back. Kept free of React so it can be unit-tested with plain objects.
 *
 * @module defaultEnvironment
 */
import type { EnvironmentId } from "@t3tools/contracts";

import type { MachineKind } from "./machineKind";

export interface DefaultEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly kind: MachineKind;
  /** True when this client holds a live connection to the machine. */
  readonly online: boolean;
  /** The daemon serving this page. */
  readonly isPrimary: boolean;
}

export interface ResolveDefaultEnvironmentInput {
  /** The user's explicit choice (`defaultEnvironmentId` setting), if any. */
  readonly explicitDefaultId: EnvironmentId | null;
  readonly candidates: ReadonlyArray<DefaultEnvironmentCandidate>;
}

export function resolveDefaultEnvironment(
  input: ResolveDefaultEnvironmentInput,
): EnvironmentId | null {
  if (input.explicitDefaultId !== null) {
    const explicit = input.candidates.find(
      (candidate) => candidate.environmentId === input.explicitDefaultId,
    );
    if (explicit?.online) return explicit.environmentId;
  }

  const onlineComputer = input.candidates.find(
    (candidate) => candidate.kind === "computer" && candidate.online,
  );
  if (onlineComputer) return onlineComputer.environmentId;

  const primary = input.candidates.find((candidate) => candidate.isPrimary);
  return primary?.environmentId ?? null;
}

/**
 * Whether to ask the user to choose: two or more machines to choose between
 * and no explicit choice that still points at one of them.
 */
export function shouldOfferDefaultEnvironmentChoice(
  input: ResolveDefaultEnvironmentInput,
): boolean {
  if (input.candidates.length < 2) return false;
  if (input.explicitDefaultId === null) return true;
  return !input.candidates.some((candidate) => candidate.environmentId === input.explicitDefaultId);
}
