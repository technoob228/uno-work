/**
 * WorkspaceService — the rules half of the workspace registry.
 *
 * The repository stores rows; this decides what a peer machine is allowed to
 * do with them. Three properties are worth stating because the tests lean on
 * them:
 *
 * - **Deny wins.** A `deny` grant beats every allow regardless of how specific
 *   the allow is, so "never touch this machine" cannot be re-enabled by adding
 *   a narrower rule further down the list.
 * - **Absence is not permission.** With no matching grant the workspace policy
 *   decides, and its default is `request` — a human sees it.
 * - **Budgets are per workspace, not per token.** A peer that exhausts the
 *   hourly cross-environment budget is refused even if every grant says yes:
 *   the budget protects the machine from a loop, and a loop is made of
 *   individually authorised calls.
 */
import {
  DEFAULT_WORKSPACE_POLICY,
  EnvironmentId,
  WORKSPACE_GRANT_WILDCARD,
  WorkspaceRpcError,
  deriveMachineMonogram,
  type WorkspaceCapability,
  type WorkspaceGrant,
  type WorkspaceMachine,
  type WorkspaceRequest,
  type WorkspaceState,
  type WorkspaceSyncMachinesInput,
  type WorkspaceUpdateMachineInput,
  type WorkspaceUpsertGrantInput,
  type CrossEnvironmentWriteMode,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Option } from "effect";

import { WorkspaceRegistryRepository } from "../persistence/Services/WorkspaceRegistry.ts";

/** Long enough to survive a slow turn, short enough that a crash frees the key. */
const DEFAULT_CLAIM_TTL_SECONDS = 15 * 60;
/** Matches the assistant's approval window; the mock shows "expires in 28 min". */
const REQUEST_TTL_SECONDS = 30 * 60;
/**
 * Three hues, then neutral. A fourth hue puts a pair on screen that the
 * commonest colour-vision deficiencies cannot separate.
 */
const MACHINE_COLOR_SLOTS = 3;

const WORKSPACE_ID_PREFIX = "workspace_";

export interface WorkspaceCapabilityDecision {
  readonly outcome: "allow" | "request" | "deny";
  readonly reason: string;
  /** The grant that decided it, when one did. */
  readonly grant: WorkspaceGrant | null;
  readonly requiresClaim: boolean;
}

export interface WorkspaceServiceShape {
  readonly getState: Effect.Effect<WorkspaceState, WorkspaceRpcError>;
  readonly rename: (input: {
    readonly name: string;
  }) => Effect.Effect<WorkspaceState, WorkspaceRpcError>;
  readonly syncMachines: (
    input: WorkspaceSyncMachinesInput,
  ) => Effect.Effect<WorkspaceState, WorkspaceRpcError>;
  readonly updateMachine: (
    input: WorkspaceUpdateMachineInput,
  ) => Effect.Effect<WorkspaceState, WorkspaceRpcError>;
  readonly removeMachine: (input: {
    readonly environmentId: EnvironmentId;
  }) => Effect.Effect<WorkspaceState, WorkspaceRpcError>;
  readonly setPolicy: (input: {
    readonly policy: WorkspaceState["policy"];
  }) => Effect.Effect<WorkspaceState, WorkspaceRpcError>;
  readonly upsertGrant: (
    input: WorkspaceUpsertGrantInput,
  ) => Effect.Effect<WorkspaceState, WorkspaceRpcError>;
  readonly removeGrant: (input: {
    readonly grantId: string;
  }) => Effect.Effect<WorkspaceState, WorkspaceRpcError>;
  readonly acquireClaim: (input: {
    readonly claimKey: string;
    readonly holderEnvironmentId: EnvironmentId;
    readonly reason: string;
    readonly ttlSeconds?: number | undefined;
  }) => Effect.Effect<
    {
      readonly outcome: "acquired" | "renewed" | "taken";
      readonly claim: WorkspaceState["claims"][number];
      readonly state: WorkspaceState;
    },
    WorkspaceRpcError
  >;
  readonly releaseClaim: (input: {
    readonly claimKey: string;
    readonly holderEnvironmentId: EnvironmentId | null;
  }) => Effect.Effect<WorkspaceState, WorkspaceRpcError>;
  readonly createRequest: (input: {
    readonly kind: WorkspaceRequest["kind"];
    readonly fromEnvironmentId: EnvironmentId;
    readonly toEnvironmentId: EnvironmentId;
    readonly repositoryKey: string;
    readonly threadId?: string | null | undefined;
    readonly reason: string;
    readonly payloadPreview: string;
    readonly hops?: number | undefined;
  }) => Effect.Effect<
    {
      readonly disposition: "pending" | "auto_approved";
      readonly request: WorkspaceRequest;
      readonly state: WorkspaceState;
    },
    WorkspaceRpcError
  >;
  readonly decideRequest: (input: {
    readonly requestId: string;
    readonly decision: "approve" | "reject";
  }) => Effect.Effect<WorkspaceState, WorkspaceRpcError>;
  readonly getInstructionText: (input: {
    readonly scope: string;
  }) => Effect.Effect<string, WorkspaceRpcError>;
  readonly setInstructionText: (input: {
    readonly scope: string;
    readonly text: string;
  }) => Effect.Effect<WorkspaceState, WorkspaceRpcError>;
  /** Pure decision function, exposed for the enforcement path and for tests. */
  readonly evaluate: (input: {
    readonly state: WorkspaceState;
    readonly fromEnvironmentId: string;
    readonly toEnvironmentId: string;
    readonly repositoryKey: string;
    readonly capability: WorkspaceCapability;
  }) => WorkspaceCapabilityDecision;
}

export class WorkspaceService extends Context.Service<WorkspaceService, WorkspaceServiceShape>()(
  "t3/workspace/WorkspaceService",
) {}

function matches(pattern: string, value: string): boolean {
  return pattern === WORKSPACE_GRANT_WILDCARD || pattern === value;
}

/**
 * More specific wins among allows: an exact from/to/repo triple outranks a
 * wildcard. Specificity does not rescue a `deny`, which is handled before this
 * is consulted.
 */
function grantSpecificity(grant: WorkspaceGrant): number {
  let score = 0;
  if (grant.fromEnvironmentId !== WORKSPACE_GRANT_WILDCARD) score += 4;
  if (grant.toEnvironmentId !== WORKSPACE_GRANT_WILDCARD) score += 2;
  if (grant.repositoryKey !== WORKSPACE_GRANT_WILDCARD) score += 1;
  return score;
}

export function evaluateCapability(input: {
  readonly state: WorkspaceState;
  readonly fromEnvironmentId: string;
  readonly toEnvironmentId: string;
  readonly repositoryKey: string;
  readonly capability: WorkspaceCapability;
}): WorkspaceCapabilityDecision {
  const { state } = input;
  if (!state.policy.acceptPeerCommands) {
    return {
      outcome: "deny",
      reason: "Accepting commands from other machines is switched off.",
      grant: null,
      requiresClaim: false,
    };
  }

  const applicable = state.grants.filter(
    (grant) =>
      matches(grant.fromEnvironmentId, input.fromEnvironmentId) &&
      matches(grant.toEnvironmentId, input.toEnvironmentId) &&
      matches(grant.repositoryKey, input.repositoryKey),
  );

  const denial = applicable.find((grant) => grant.mode === "deny");
  if (denial) {
    return {
      outcome: "deny",
      reason: "A deny rule covers this machine.",
      grant: denial,
      requiresClaim: false,
    };
  }

  const granting = applicable
    .filter((grant) => grant.capabilities.includes(input.capability))
    .toSorted((left, right) => grantSpecificity(right) - grantSpecificity(left));
  const best = granting[0];
  if (best) {
    return {
      outcome: best.mode === "allow" ? "allow" : "request",
      reason:
        best.mode === "allow"
          ? "A grant allows this outright."
          : "A grant covers this, but each use is confirmed.",
      grant: best,
      requiresClaim: best.requiresClaim,
    };
  }

  const fallback: CrossEnvironmentWriteMode = state.policy.crossEnvironmentWrite;
  return {
    outcome: fallback === "allow" ? "allow" : fallback === "deny" ? "deny" : "request",
    reason:
      fallback === "deny"
        ? "No grant matches and the workspace refuses cross-environment writes."
        : fallback === "allow"
          ? "No grant matches; the workspace allows cross-environment writes."
          : "No grant matches; the workspace asks for confirmation.",
    grant: null,
    requiresClaim: false,
  };
}

/**
 * Deterministic from the environment id, so the same machine keeps its hue
 * across daemons that never talked to each other — a machine seen from two
 * clients should not read as two machines.
 */
function deriveColorSlot(environmentId: string): number {
  let hash = 0;
  for (let index = 0; index < environmentId.length; index += 1) {
    hash = (hash * 31 + environmentId.charCodeAt(index)) % 100_000;
  }
  return hash % MACHINE_COLOR_SLOTS;
}

const nowIso = () => new Date().toISOString();

const makeWorkspaceService = Effect.gen(function* () {
  const repository = yield* WorkspaceRegistryRepository;

  const toRpcError = (message: string, reason?: WorkspaceRpcError["reason"]) => () =>
    new WorkspaceRpcError({ message, ...(reason ? { reason } : {}) });

  const now = nowIso;

  const ensure = Effect.gen(function* () {
    const existing = yield* repository.getIdentity();
    if (Option.isSome(existing)) return existing.value;
    return yield* repository.ensureWorkspace({
      workspaceId: `${WORKSPACE_ID_PREFIX}${crypto.randomUUID()}`,
      name: "Workspace",
      now: now(),
    });
  }).pipe(Effect.mapError(toRpcError("Unable to read the workspace registry.")));

  const snapshot = Effect.gen(function* () {
    yield* ensure;
    const timestamp = now();
    // Expiry is evaluated on read rather than on a timer: a daemon that was
    // asleep for an hour must not serve a stale pending request as live.
    yield* repository.expireRequests({ now: timestamp }).pipe(Effect.ignore);
    return yield* repository.getState({ now: timestamp });
  }).pipe(Effect.mapError(toRpcError("Unable to read the workspace registry.")));

  const syncMachines: WorkspaceServiceShape["syncMachines"] = (input) =>
    Effect.gen(function* () {
      yield* ensure;
      const timestamp = now();
      const current = yield* repository
        .getState({ now: timestamp })
        .pipe(Effect.mapError(toRpcError("Unable to read the workspace registry.")));
      const known = new Map(current.machines.map((machine) => [machine.environmentId, machine]));

      for (const incoming of input.machines) {
        const existing = known.get(incoming.environmentId);
        const machine: WorkspaceMachine = {
          environmentId: incoming.environmentId,
          label: incoming.label.trim().length > 0 ? incoming.label.trim() : incoming.environmentId,
          // A machine the user has renamed keeps its monogram and hue: those are
          // the things they have learned to recognise it by.
          monogram: existing?.monogram ?? deriveMachineMonogram(incoming.label),
          colorSlot: existing?.colorSlot ?? deriveColorSlot(incoming.environmentId),
          kind: incoming.kind,
          unoBoxId: incoming.unoBoxId ?? existing?.unoBoxId ?? null,
          scope: existing?.scope ?? "full",
          repositories: existing?.repositories ?? [],
          addedAt: existing?.addedAt ?? timestamp,
          // An explicit `null` means "we have not heard from it": a sleeping box
          // adopted from the account list is in the workspace but has never
          // answered us. Stamping `now` here would render it as live, which is
          // exactly the silent-staleness the panel exists to prevent. Only an
          // absent field falls back to what we already knew.
          lastSeenAt:
            incoming.lastSeenAt !== undefined
              ? incoming.lastSeenAt
              : (existing?.lastSeenAt ?? null),
        };
        yield* repository
          .upsertMachine(machine)
          .pipe(Effect.mapError(toRpcError("Unable to record the machine.")));
      }

      if (input.registryEnvironmentId !== undefined) {
        yield* repository
          .updateIdentity({ registryEnvironmentId: input.registryEnvironmentId, now: timestamp })
          .pipe(Effect.mapError(toRpcError("Unable to set the registry machine.")));
      }

      return yield* snapshot;
    });

  const rename: WorkspaceServiceShape["rename"] = (input) =>
    Effect.gen(function* () {
      yield* ensure;
      const name = input.name.trim();
      if (name.length === 0) {
        return yield* new WorkspaceRpcError({
          message: "A workspace needs a name.",
          reason: "invalid_request",
        });
      }
      yield* repository
        .updateIdentity({ name, now: now() })
        .pipe(Effect.mapError(toRpcError("Unable to rename the workspace.")));
      return yield* snapshot;
    });

  const updateMachine: WorkspaceServiceShape["updateMachine"] = (input) =>
    Effect.gen(function* () {
      const state = yield* snapshot;
      const existing = state.machines.find(
        (machine) => machine.environmentId === input.environmentId,
      );
      if (!existing) {
        return yield* new WorkspaceRpcError({
          message: "That machine is not in the workspace.",
          reason: "not_found",
        });
      }
      const monogram = input.monogram?.trim();
      const machine: WorkspaceMachine = {
        ...existing,
        label:
          input.label?.trim() && input.label.trim().length > 0
            ? input.label.trim()
            : existing.label,
        // Two characters is the shipped answer; longer input is cut rather than
        // rejected so a paste does not lose the edit.
        monogram:
          monogram && monogram.length > 0 ? monogram.slice(0, 2).toUpperCase() : existing.monogram,
        colorSlot:
          typeof input.colorSlot === "number" && input.colorSlot >= 0
            ? Math.floor(input.colorSlot)
            : existing.colorSlot,
        scope: input.scope ?? existing.scope,
        repositories: input.repositories ?? existing.repositories,
      };
      yield* repository
        .upsertMachine(machine)
        .pipe(Effect.mapError(toRpcError("Unable to update the machine.")));
      return yield* snapshot;
    });

  const removeMachine: WorkspaceServiceShape["removeMachine"] = (input) =>
    Effect.gen(function* () {
      yield* repository
        .removeMachine({ environmentId: input.environmentId, now: now() })
        .pipe(Effect.mapError(toRpcError("Unable to remove the machine.")));
      return yield* snapshot;
    });

  const setPolicy: WorkspaceServiceShape["setPolicy"] = (input) =>
    Effect.gen(function* () {
      yield* ensure;
      yield* repository
        .setPolicy({ policy: { ...DEFAULT_WORKSPACE_POLICY, ...input.policy }, now: now() })
        .pipe(Effect.mapError(toRpcError("Unable to save the workspace rules.")));
      return yield* snapshot;
    });

  const upsertGrant: WorkspaceServiceShape["upsertGrant"] = (input) =>
    Effect.gen(function* () {
      yield* ensure;
      const timestamp = now();
      yield* repository
        .upsertGrant({
          grant: {
            grantId: input.grantId ?? `grant_${crypto.randomUUID()}`,
            fromEnvironmentId: input.fromEnvironmentId,
            toEnvironmentId: input.toEnvironmentId,
            repositoryKey: input.repositoryKey,
            capabilities: input.capabilities,
            transport: input.transport,
            mode: input.mode,
            requiresClaim: input.requiresClaim,
            createdAt: timestamp,
          },
          now: timestamp,
        })
        .pipe(Effect.mapError(toRpcError("Unable to save the grant.")));
      return yield* snapshot;
    });

  const removeGrant: WorkspaceServiceShape["removeGrant"] = (input) =>
    Effect.gen(function* () {
      yield* repository
        .removeGrant({ grantId: input.grantId, now: now() })
        .pipe(Effect.mapError(toRpcError("Unable to remove the grant.")));
      return yield* snapshot;
    });

  const acquireClaim: WorkspaceServiceShape["acquireClaim"] = (input) =>
    Effect.gen(function* () {
      yield* ensure;
      const timestamp = now();
      const ttl =
        typeof input.ttlSeconds === "number" && input.ttlSeconds > 0
          ? input.ttlSeconds
          : DEFAULT_CLAIM_TTL_SECONDS;
      const expiresAt = new Date(new Date(timestamp).getTime() + ttl * 1000).toISOString();
      const outcome = yield* repository
        .acquireClaim({
          claimKey: input.claimKey,
          holderEnvironmentId: input.holderEnvironmentId,
          reason: input.reason,
          now: timestamp,
          expiresAt,
        })
        .pipe(Effect.mapError(toRpcError("Unable to take the claim.")));
      const state = yield* snapshot;
      return { outcome: outcome.kind, claim: outcome.claim, state };
    });

  const releaseClaim: WorkspaceServiceShape["releaseClaim"] = (input) =>
    Effect.gen(function* () {
      yield* repository
        .releaseClaim({
          claimKey: input.claimKey,
          holderEnvironmentId: input.holderEnvironmentId,
          now: now(),
        })
        .pipe(Effect.mapError(toRpcError("Unable to release the claim.")));
      return yield* snapshot;
    });

  const createRequest: WorkspaceServiceShape["createRequest"] = (input) =>
    Effect.gen(function* () {
      const state = yield* snapshot;
      const hops = input.hops ?? 0;
      if (hops > state.policy.maxForwardHops) {
        return yield* new WorkspaceRpcError({
          message: `Refused after ${hops} forwards; the workspace allows ${state.policy.maxForwardHops}.`,
          reason: "hop_limit",
        });
      }
      if (state.policy.dropOwnEcho && input.fromEnvironmentId === input.toEnvironmentId) {
        return yield* new WorkspaceRpcError({
          message: "A machine cannot send itself a cross-environment request.",
          reason: "invalid_request",
        });
      }
      if (state.usage.crossEnvironmentTurnsLastHour >= state.policy.crossEnvironmentTurnsPerHour) {
        return yield* new WorkspaceRpcError({
          message: `The hourly cross-environment budget (${state.policy.crossEnvironmentTurnsPerHour}) is spent.`,
          reason: "budget_exhausted",
        });
      }

      const capability: WorkspaceCapability =
        input.kind === "read_transcript"
          ? "read_transcript"
          : input.kind === "create_thread"
            ? "create_threads"
            : "write";
      const decision = evaluateCapability({
        state,
        fromEnvironmentId: input.fromEnvironmentId,
        toEnvironmentId: input.toEnvironmentId,
        repositoryKey: input.repositoryKey,
        capability,
      });
      if (decision.outcome === "deny") {
        return yield* new WorkspaceRpcError({
          message: decision.reason,
          reason: "policy_denied",
        });
      }
      if (decision.requiresClaim) {
        const claimKey = `${input.repositoryKey}|${input.threadId ?? "*"}`;
        const holder = state.claims.find((claim) => claim.claimKey === claimKey);
        if (holder && holder.holderEnvironmentId !== input.fromEnvironmentId) {
          return yield* new WorkspaceRpcError({
            message: `The claim on ${claimKey} is held by another machine.`,
            reason: "claim_taken",
          });
        }
      }

      const timestamp = now();
      const request: WorkspaceRequest = {
        requestId: `wsreq_${crypto.randomUUID()}`,
        kind: input.kind,
        fromEnvironmentId: input.fromEnvironmentId,
        toEnvironmentId: input.toEnvironmentId,
        repositoryKey: input.repositoryKey,
        threadId: input.threadId ?? null,
        reason: input.reason,
        payloadPreview: input.payloadPreview,
        status: decision.outcome === "allow" ? "approved" : "pending",
        nonce: crypto.randomUUID(),
        hops,
        createdAt: timestamp,
        expiresAt: new Date(
          new Date(timestamp).getTime() + REQUEST_TTL_SECONDS * 1000,
        ).toISOString(),
        decidedAt: decision.outcome === "allow" ? timestamp : null,
      };
      yield* repository
        .createRequest({ request })
        .pipe(Effect.mapError(toRpcError("Unable to record the request.")));
      // Auto-approved traffic is metered too — otherwise a standing grant is a
      // hole in the budget rather than a shortcut through the dialog.
      if (decision.outcome === "allow") {
        yield* repository
          .recordActivity({
            occurredAt: timestamp,
            fromEnvironmentId: input.fromEnvironmentId,
            kind: input.kind,
          })
          .pipe(Effect.ignore);
      }
      return {
        disposition:
          decision.outcome === "allow" ? ("auto_approved" as const) : ("pending" as const),
        request,
        state: yield* snapshot,
      };
    });

  const decideRequest: WorkspaceServiceShape["decideRequest"] = (input) =>
    Effect.gen(function* () {
      const timestamp = now();
      const decided = yield* repository
        .decideRequest({
          requestId: input.requestId,
          status: input.decision === "approve" ? "approved" : "rejected",
          decidedAt: timestamp,
        })
        .pipe(Effect.mapError(toRpcError("Unable to record the decision.")));
      if (Option.isNone(decided)) {
        return yield* new WorkspaceRpcError({
          message: "That request was already decided or has expired.",
          reason: "not_found",
        });
      }
      if (input.decision === "approve") {
        yield* repository
          .recordActivity({
            occurredAt: timestamp,
            fromEnvironmentId: decided.value.fromEnvironmentId,
            kind: decided.value.kind,
          })
          .pipe(Effect.ignore);
      }
      return yield* snapshot;
    });

  const getInstructionText: WorkspaceServiceShape["getInstructionText"] = (input) =>
    repository
      .getInstructionText({ environmentId: input.scope })
      .pipe(Effect.mapError(toRpcError("Unable to read the instructions.")));

  const setInstructionText: WorkspaceServiceShape["setInstructionText"] = (input) =>
    Effect.gen(function* () {
      yield* ensure;
      yield* repository
        .setInstructionText({ environmentId: input.scope, text: input.text, now: now() })
        .pipe(Effect.mapError(toRpcError("Unable to save the instructions.")));
      return yield* snapshot;
    });

  return {
    getState: snapshot,
    rename,
    syncMachines,
    updateMachine,
    removeMachine,
    setPolicy,
    upsertGrant,
    removeGrant,
    acquireClaim,
    releaseClaim,
    createRequest,
    decideRequest,
    getInstructionText,
    setInstructionText,
    evaluate: evaluateCapability,
  } satisfies WorkspaceServiceShape;
});

export const WorkspaceServiceLive = Layer.effect(WorkspaceService, makeWorkspaceService);
