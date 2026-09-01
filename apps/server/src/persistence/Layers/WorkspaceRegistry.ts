import {
  DEFAULT_WORKSPACE_POLICY,
  EnvironmentId,
  type WorkspaceCapability,
  type WorkspaceClaim,
  type WorkspaceGrant,
  type WorkspaceIdentity,
  type WorkspaceMachine,
  type WorkspaceMachineKind,
  type WorkspaceMachineScope,
  type WorkspacePolicy,
  type WorkspaceRequest,
  type WorkspaceRequestKind,
  type WorkspaceRequestStatus,
  type WorkspaceState,
  type WorkspaceTransport,
  type CrossEnvironmentWriteMode,
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type ManagerRepositoryError } from "../Errors.ts";
import {
  WorkspaceRegistryRepository,
  type ClaimAcquireOutcome,
  type WorkspaceRegistryRepositoryShape,
} from "../Services/WorkspaceRegistry.ts";

interface IdentityRow {
  readonly workspaceId: string;
  readonly name: string;
  readonly epoch: number;
  readonly registryEnvironmentId: string | null;
  readonly unoAccountId: number | null;
  readonly policyJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface MachineRow {
  readonly environmentId: string;
  readonly label: string;
  readonly monogram: string;
  readonly colorSlot: number;
  readonly kind: string;
  readonly unoBoxId: number | null;
  readonly scope: string;
  readonly repositoriesJson: string;
  readonly addedAt: string;
  readonly lastSeenAt: string | null;
}

interface GrantRow {
  readonly grantId: string;
  readonly fromEnvironmentId: string;
  readonly toEnvironmentId: string;
  readonly repositoryKey: string;
  readonly capabilitiesJson: string;
  readonly transport: string;
  readonly mode: string;
  readonly requiresClaim: number;
  readonly createdAt: string;
}

interface ClaimRow {
  readonly claimId: string;
  readonly claimKey: string;
  readonly holderEnvironmentId: string;
  readonly reason: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

interface RequestRow {
  readonly requestId: string;
  readonly kind: string;
  readonly fromEnvironmentId: string;
  readonly toEnvironmentId: string;
  readonly repositoryKey: string;
  readonly threadId: string | null;
  readonly reason: string;
  readonly payloadPreview: string;
  readonly status: string;
  readonly nonce: string;
  readonly hops: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
}

/**
 * A stored value that no longer parses (hand-edited row, downgrade, a literal
 * we later renamed) falls back to the safe end of the range rather than
 * failing the whole snapshot: a registry that refuses to load is worse than one
 * that reads a single row conservatively.
 */
function parseJsonArray(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function parsePolicy(raw: string): WorkspacePolicy {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_WORKSPACE_POLICY;
    const candidate = parsed as Partial<WorkspacePolicy>;
    return {
      crossEnvironmentWrite: isWriteMode(candidate.crossEnvironmentWrite)
        ? candidate.crossEnvironmentWrite
        : DEFAULT_WORKSPACE_POLICY.crossEnvironmentWrite,
      maxForwardHops:
        typeof candidate.maxForwardHops === "number" && candidate.maxForwardHops >= 0
          ? candidate.maxForwardHops
          : DEFAULT_WORKSPACE_POLICY.maxForwardHops,
      dropOwnEcho:
        typeof candidate.dropOwnEcho === "boolean"
          ? candidate.dropOwnEcho
          : DEFAULT_WORKSPACE_POLICY.dropOwnEcho,
      crossEnvironmentTurnsPerHour:
        typeof candidate.crossEnvironmentTurnsPerHour === "number" &&
        candidate.crossEnvironmentTurnsPerHour >= 0
          ? candidate.crossEnvironmentTurnsPerHour
          : DEFAULT_WORKSPACE_POLICY.crossEnvironmentTurnsPerHour,
      maxConcurrentCrossEnvironment:
        typeof candidate.maxConcurrentCrossEnvironment === "number" &&
        candidate.maxConcurrentCrossEnvironment >= 0
          ? candidate.maxConcurrentCrossEnvironment
          : DEFAULT_WORKSPACE_POLICY.maxConcurrentCrossEnvironment,
      acceptPeerCommands:
        typeof candidate.acceptPeerCommands === "boolean"
          ? candidate.acceptPeerCommands
          : DEFAULT_WORKSPACE_POLICY.acceptPeerCommands,
    };
  } catch {
    return DEFAULT_WORKSPACE_POLICY;
  }
}

function isWriteMode(value: unknown): value is CrossEnvironmentWriteMode {
  return value === "deny" || value === "request" || value === "allow";
}

function toMachineKind(value: string): WorkspaceMachineKind {
  return value === "local" || value === "ssh" || value === "uno_box" ? value : "ssh";
}

function toMachineScope(value: string): WorkspaceMachineScope {
  return value === "repositories" ? "repositories" : "full";
}

function toTransport(value: string): WorkspaceTransport {
  return value === "registry" ? "registry" : "direct";
}

function toCapabilities(raw: string): readonly WorkspaceCapability[] {
  const allowed = new Set<string>([
    "view_status",
    "view_threads",
    "read_transcript",
    "create_threads",
    "write",
  ]);
  return parseJsonArray(raw).filter((entry): entry is WorkspaceCapability => allowed.has(entry));
}

function toRequestKind(value: string): WorkspaceRequestKind {
  return value === "create_thread" || value === "read_transcript" ? value : "post_message";
}

function toRequestStatus(value: string): WorkspaceRequestStatus {
  return value === "approved" || value === "rejected" || value === "expired" ? value : "pending";
}

function toIdentity(row: IdentityRow): WorkspaceIdentity {
  return {
    workspaceId: row.workspaceId,
    name: row.name,
    epoch: row.epoch,
    registryEnvironmentId:
      row.registryEnvironmentId === null ? null : EnvironmentId.make(row.registryEnvironmentId),
    unoAccountId: row.unoAccountId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMachine(row: MachineRow): WorkspaceMachine {
  return {
    environmentId: EnvironmentId.make(row.environmentId),
    label: row.label,
    monogram: row.monogram,
    colorSlot: row.colorSlot,
    kind: toMachineKind(row.kind),
    unoBoxId: row.unoBoxId,
    scope: toMachineScope(row.scope),
    repositories: parseJsonArray(row.repositoriesJson),
    addedAt: row.addedAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function toGrant(row: GrantRow): WorkspaceGrant {
  return {
    grantId: row.grantId,
    fromEnvironmentId: row.fromEnvironmentId,
    toEnvironmentId: row.toEnvironmentId,
    repositoryKey: row.repositoryKey,
    capabilities: toCapabilities(row.capabilitiesJson),
    transport: toTransport(row.transport),
    mode: isWriteMode(row.mode) ? row.mode : "request",
    requiresClaim: row.requiresClaim !== 0,
    createdAt: row.createdAt,
  };
}

function toClaim(row: ClaimRow): WorkspaceClaim {
  return {
    claimId: row.claimId,
    claimKey: row.claimKey,
    holderEnvironmentId: EnvironmentId.make(row.holderEnvironmentId),
    reason: row.reason,
    acquiredAt: row.acquiredAt,
    expiresAt: row.expiresAt,
  };
}

function toRequest(row: RequestRow): WorkspaceRequest {
  return {
    requestId: row.requestId,
    kind: toRequestKind(row.kind),
    fromEnvironmentId: EnvironmentId.make(row.fromEnvironmentId),
    toEnvironmentId: EnvironmentId.make(row.toEnvironmentId),
    repositoryKey: row.repositoryKey,
    threadId: row.threadId,
    reason: row.reason,
    payloadPreview: row.payloadPreview,
    status: toRequestStatus(row.status),
    nonce: row.nonce,
    hops: row.hops,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
  };
}

const IDENTITY_COLUMNS = `
  workspace_id AS "workspaceId",
  name AS "name",
  epoch AS "epoch",
  registry_environment_id AS "registryEnvironmentId",
  uno_account_id AS "unoAccountId",
  policy_json AS "policyJson",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const makeWorkspaceRegistryRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const fail = (operation: string) =>
    toPersistenceSqlError(`WorkspaceRegistryRepository.${operation}`);

  /**
   * Every registry mutation goes through here. Callers that forget it produce a
   * snapshot whose contents changed while its epoch did not, which is exactly
   * the silent staleness the panel is supposed to make impossible.
   */
  const bumpEpoch = (now: string) =>
    sql`
      UPDATE workspace_identity
      SET epoch = epoch + 1, updated_at = ${now}
      WHERE id = 1
    `;

  const readIdentityRow = sql.unsafe<IdentityRow>(
    `SELECT ${IDENTITY_COLUMNS} FROM workspace_identity WHERE id = 1`,
  );

  const getIdentity: WorkspaceRegistryRepositoryShape["getIdentity"] = () =>
    readIdentityRow.pipe(
      Effect.map((rows) => {
        const row = rows[0];
        return row ? Option.some(toIdentity(row)) : Option.none();
      }),
      Effect.mapError(fail("getIdentity")),
    );

  const ensureWorkspace: WorkspaceRegistryRepositoryShape["ensureWorkspace"] = (input) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO workspace_identity (
          id, workspace_id, name, epoch, registry_environment_id,
          uno_account_id, policy_json, created_at, updated_at
        ) VALUES (
          1, ${input.workspaceId}, ${input.name}, 0, NULL,
          NULL, ${JSON.stringify(DEFAULT_WORKSPACE_POLICY)}, ${input.now}, ${input.now}
        )
        ON CONFLICT(id) DO NOTHING
      `;
      const rows = yield* readIdentityRow;
      const row = rows[0];
      if (!row) {
        // Unreachable unless the insert above was rolled back underneath us.
        return {
          workspaceId: input.workspaceId,
          name: input.name,
          epoch: 0,
          registryEnvironmentId: null,
          unoAccountId: null,
          createdAt: input.now,
          updatedAt: input.now,
        } satisfies WorkspaceIdentity;
      }
      return toIdentity(row);
    }).pipe(Effect.mapError(fail("ensureWorkspace")));

  const updateIdentity: WorkspaceRegistryRepositoryShape["updateIdentity"] = (input) =>
    Effect.gen(function* () {
      if (input.name !== undefined) {
        yield* sql`UPDATE workspace_identity SET name = ${input.name} WHERE id = 1`;
      }
      if (input.registryEnvironmentId !== undefined) {
        yield* sql`
          UPDATE workspace_identity
          SET registry_environment_id = ${input.registryEnvironmentId}
          WHERE id = 1
        `;
      }
      if (input.unoAccountId !== undefined) {
        yield* sql`
          UPDATE workspace_identity SET uno_account_id = ${input.unoAccountId} WHERE id = 1
        `;
      }
      yield* bumpEpoch(input.now);
    }).pipe(Effect.mapError(fail("updateIdentity")));

  const upsertMachine: WorkspaceRegistryRepositoryShape["upsertMachine"] = (machine) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO workspace_machines (
          environment_id, label, monogram, color_slot, kind,
          uno_box_id, scope, repositories_json, added_at, last_seen_at
        ) VALUES (
          ${machine.environmentId}, ${machine.label}, ${machine.monogram},
          ${machine.colorSlot}, ${machine.kind}, ${machine.unoBoxId},
          ${machine.scope}, ${JSON.stringify(machine.repositories)},
          ${machine.addedAt}, ${machine.lastSeenAt}
        )
        ON CONFLICT(environment_id) DO UPDATE SET
          label = excluded.label,
          monogram = excluded.monogram,
          color_slot = excluded.color_slot,
          kind = excluded.kind,
          uno_box_id = excluded.uno_box_id,
          scope = excluded.scope,
          repositories_json = excluded.repositories_json,
          -- added_at is intentionally not updated: an upsert is a rename or a
          -- re-pair, not a new machine, and the panel sorts by when it joined.
          last_seen_at = COALESCE(excluded.last_seen_at, workspace_machines.last_seen_at)
      `;
      yield* bumpEpoch(machine.addedAt);
    }).pipe(Effect.mapError(fail("upsertMachine")));

  const removeMachine: WorkspaceRegistryRepositoryShape["removeMachine"] = (input) =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM workspace_machines WHERE environment_id = ${input.environmentId}`;
      // Grants and claims that named the machine go with it; leaving them would
      // silently re-authorise a future machine that reuses the id.
      yield* sql`
        DELETE FROM workspace_grants
        WHERE from_environment_id = ${input.environmentId}
           OR to_environment_id = ${input.environmentId}
      `;
      yield* sql`
        DELETE FROM workspace_claims WHERE holder_environment_id = ${input.environmentId}
      `;
      yield* bumpEpoch(input.now);
    }).pipe(Effect.mapError(fail("removeMachine")));

  const touchMachine: WorkspaceRegistryRepositoryShape["touchMachine"] = (input) =>
    sql`
      UPDATE workspace_machines
      SET last_seen_at = ${input.lastSeenAt}
      WHERE environment_id = ${input.environmentId}
    `.pipe(Effect.asVoid, Effect.mapError(fail("touchMachine")));

  const setPolicy: WorkspaceRegistryRepositoryShape["setPolicy"] = (input) =>
    Effect.gen(function* () {
      yield* sql`
        UPDATE workspace_identity SET policy_json = ${JSON.stringify(input.policy)} WHERE id = 1
      `;
      yield* bumpEpoch(input.now);
    }).pipe(Effect.mapError(fail("setPolicy")));

  const upsertGrant: WorkspaceRegistryRepositoryShape["upsertGrant"] = (input) =>
    Effect.gen(function* () {
      const grant = input.grant;
      yield* sql`
        INSERT INTO workspace_grants (
          grant_id, from_environment_id, to_environment_id, repository_key,
          capabilities_json, transport, mode, requires_claim, created_at
        ) VALUES (
          ${grant.grantId}, ${grant.fromEnvironmentId}, ${grant.toEnvironmentId},
          ${grant.repositoryKey}, ${JSON.stringify(grant.capabilities)}, ${grant.transport},
          ${grant.mode}, ${grant.requiresClaim ? 1 : 0}, ${grant.createdAt}
        )
        ON CONFLICT(grant_id) DO UPDATE SET
          from_environment_id = excluded.from_environment_id,
          to_environment_id = excluded.to_environment_id,
          repository_key = excluded.repository_key,
          capabilities_json = excluded.capabilities_json,
          transport = excluded.transport,
          mode = excluded.mode,
          requires_claim = excluded.requires_claim
      `;
      yield* bumpEpoch(input.now);
    }).pipe(Effect.mapError(fail("upsertGrant")));

  const removeGrant: WorkspaceRegistryRepositoryShape["removeGrant"] = (input) =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM workspace_grants WHERE grant_id = ${input.grantId}`;
      yield* bumpEpoch(input.now);
    }).pipe(Effect.mapError(fail("removeGrant")));

  const acquireClaim: WorkspaceRegistryRepositoryShape["acquireClaim"] = (input) =>
    Effect.gen(function* () {
      // Expired rows are cleared first so a crashed holder does not park a key
      // forever: the TTL is the recovery mechanism, not an admin action.
      yield* sql`DELETE FROM workspace_claims WHERE expires_at <= ${input.now}`;
      const existingRows = yield* sql<ClaimRow>`
        SELECT
          claim_id AS "claimId",
          claim_key AS "claimKey",
          holder_environment_id AS "holderEnvironmentId",
          reason AS "reason",
          acquired_at AS "acquiredAt",
          expires_at AS "expiresAt"
        FROM workspace_claims
        WHERE claim_key = ${input.claimKey}
      `;
      const existing = existingRows[0];
      if (existing && existing.holderEnvironmentId !== input.holderEnvironmentId) {
        return { kind: "taken", claim: toClaim(existing) } satisfies ClaimAcquireOutcome;
      }
      if (existing) {
        yield* sql`
          UPDATE workspace_claims
          SET expires_at = ${input.expiresAt}, reason = ${input.reason}
          WHERE claim_key = ${input.claimKey}
        `;
        yield* bumpEpoch(input.now);
        return {
          kind: "renewed",
          claim: {
            ...toClaim(existing),
            reason: input.reason,
            expiresAt: input.expiresAt,
          },
        } satisfies ClaimAcquireOutcome;
      }
      const claimId = `claim_${input.claimKey}_${input.now}`;
      yield* sql`
        INSERT INTO workspace_claims (
          claim_id, claim_key, holder_environment_id, reason, acquired_at, expires_at
        ) VALUES (
          ${claimId}, ${input.claimKey}, ${input.holderEnvironmentId},
          ${input.reason}, ${input.now}, ${input.expiresAt}
        )
      `;
      yield* bumpEpoch(input.now);
      return {
        kind: "acquired",
        claim: {
          claimId,
          claimKey: input.claimKey,
          holderEnvironmentId: EnvironmentId.make(input.holderEnvironmentId),
          reason: input.reason,
          acquiredAt: input.now,
          expiresAt: input.expiresAt,
        },
      } satisfies ClaimAcquireOutcome;
    }).pipe(Effect.mapError(fail("acquireClaim")));

  const releaseClaim: WorkspaceRegistryRepositoryShape["releaseClaim"] = (input) =>
    Effect.gen(function* () {
      const before = yield* sql<{ readonly total: number }>`
        SELECT COUNT(*) AS "total" FROM workspace_claims WHERE claim_key = ${input.claimKey}
      `;
      if ((before[0]?.total ?? 0) === 0) return false;
      if (input.holderEnvironmentId === null) {
        yield* sql`DELETE FROM workspace_claims WHERE claim_key = ${input.claimKey}`;
      } else {
        yield* sql`
          DELETE FROM workspace_claims
          WHERE claim_key = ${input.claimKey}
            AND holder_environment_id = ${input.holderEnvironmentId}
        `;
      }
      const after = yield* sql<{ readonly total: number }>`
        SELECT COUNT(*) AS "total" FROM workspace_claims WHERE claim_key = ${input.claimKey}
      `;
      const removed = (after[0]?.total ?? 0) === 0;
      if (removed) yield* bumpEpoch(input.now);
      return removed;
    }).pipe(Effect.mapError(fail("releaseClaim")));

  const createRequest: WorkspaceRegistryRepositoryShape["createRequest"] = (input) =>
    Effect.gen(function* () {
      const request = input.request;
      yield* sql`
        INSERT INTO workspace_requests (
          request_id, kind, from_environment_id, to_environment_id, repository_key,
          thread_id, reason, payload_preview, status, nonce, hops,
          created_at, expires_at, decided_at
        ) VALUES (
          ${request.requestId}, ${request.kind}, ${request.fromEnvironmentId},
          ${request.toEnvironmentId}, ${request.repositoryKey}, ${request.threadId},
          ${request.reason}, ${request.payloadPreview}, ${request.status}, ${request.nonce},
          ${request.hops}, ${request.createdAt}, ${request.expiresAt}, ${request.decidedAt}
        )
      `;
      yield* bumpEpoch(request.createdAt);
    }).pipe(Effect.mapError(fail("createRequest")));

  const requestColumns = `
    request_id AS "requestId",
    kind AS "kind",
    from_environment_id AS "fromEnvironmentId",
    to_environment_id AS "toEnvironmentId",
    repository_key AS "repositoryKey",
    thread_id AS "threadId",
    reason AS "reason",
    payload_preview AS "payloadPreview",
    status AS "status",
    nonce AS "nonce",
    hops AS "hops",
    created_at AS "createdAt",
    expires_at AS "expiresAt",
    decided_at AS "decidedAt"
  `;

  const getRequest: WorkspaceRegistryRepositoryShape["getRequest"] = (input) =>
    sql
      .unsafe<RequestRow>(`SELECT ${requestColumns} FROM workspace_requests WHERE request_id = ?`, [
        input.requestId,
      ])
      .pipe(
        Effect.map((rows) => {
          const row = rows[0];
          return row ? Option.some(toRequest(row)) : Option.none();
        }),
        Effect.mapError(fail("getRequest")),
      );

  const decideRequest: WorkspaceRegistryRepositoryShape["decideRequest"] = (input) =>
    Effect.gen(function* () {
      // "Did this call decide it" is answered by the row's status *before* the
      // update, not by comparing timestamps afterwards: two decisions landing
      // in the same millisecond produce identical `decided_at`, and the second
      // one would then read as successful — a replayed approval flipping an
      // already-rejected request is exactly the case this guards.
      const beforeRows = yield* sql<{ readonly status: string }>`
        SELECT status AS "status" FROM workspace_requests WHERE request_id = ${input.requestId}
      `;
      const before = beforeRows[0];
      if (!before || before.status !== "pending") return Option.none();

      yield* sql`
        UPDATE workspace_requests
        SET status = ${input.status}, decided_at = ${input.decidedAt}
        WHERE request_id = ${input.requestId} AND status = 'pending'
      `;
      yield* bumpEpoch(input.decidedAt);
      const rows = yield* sql.unsafe<RequestRow>(
        `SELECT ${requestColumns} FROM workspace_requests WHERE request_id = ?`,
        [input.requestId],
      );
      const row = rows[0];
      if (!row) return Option.none();
      const decided = toRequest(row);
      return decided.status === input.status ? Option.some(decided) : Option.none();
    }).pipe(Effect.mapError(fail("decideRequest")));

  const expireRequests: WorkspaceRegistryRepositoryShape["expireRequests"] = (input) =>
    Effect.gen(function* () {
      const stale = yield* sql<{ readonly total: number }>`
        SELECT COUNT(*) AS "total"
        FROM workspace_requests
        WHERE status = 'pending' AND expires_at <= ${input.now}
      `;
      const total = stale[0]?.total ?? 0;
      if (total === 0) return 0;
      yield* sql`
        UPDATE workspace_requests
        SET status = 'expired', decided_at = ${input.now}
        WHERE status = 'pending' AND expires_at <= ${input.now}
      `;
      yield* bumpEpoch(input.now);
      return total;
    }).pipe(Effect.mapError(fail("expireRequests")));

  const recordActivity: WorkspaceRegistryRepositoryShape["recordActivity"] = (input) =>
    sql`
      INSERT INTO workspace_activity (occurred_at, from_environment_id, kind)
      VALUES (${input.occurredAt}, ${input.fromEnvironmentId}, ${input.kind})
    `.pipe(Effect.asVoid, Effect.mapError(fail("recordActivity")));

  const countActivitySince: WorkspaceRegistryRepositoryShape["countActivitySince"] = (input) =>
    sql<{ readonly total: number }>`
      SELECT COUNT(*) AS "total" FROM workspace_activity WHERE occurred_at >= ${input.since}
    `.pipe(
      Effect.map((rows) => rows[0]?.total ?? 0),
      Effect.mapError(fail("countActivitySince")),
    );

  const getInstructionText: WorkspaceRegistryRepositoryShape["getInstructionText"] = (input) =>
    sql<{ readonly text: string }>`
      SELECT text AS "text" FROM workspace_instructions WHERE environment_id = ${input.environmentId}
    `.pipe(
      Effect.map((rows) => rows[0]?.text ?? ""),
      Effect.mapError(fail("getInstructionText")),
    );

  const setInstructionText: WorkspaceRegistryRepositoryShape["setInstructionText"] = (input) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO workspace_instructions (environment_id, text, updated_at)
        VALUES (${input.environmentId}, ${input.text}, ${input.now})
        ON CONFLICT(environment_id) DO UPDATE SET
          text = excluded.text,
          updated_at = excluded.updated_at
      `;
      yield* bumpEpoch(input.now);
    }).pipe(Effect.mapError(fail("setInstructionText")));

  const getState: WorkspaceRegistryRepositoryShape["getState"] = (input) =>
    Effect.gen(function* () {
      const identityRows = yield* readIdentityRow;
      const identityRow = identityRows[0];
      const identity: WorkspaceIdentity = identityRow
        ? toIdentity(identityRow)
        : {
            workspaceId: "workspace-uninitialised",
            name: "Workspace",
            epoch: 0,
            registryEnvironmentId: null,
            unoAccountId: null,
            createdAt: input.now,
            updatedAt: input.now,
          };
      const policy = identityRow ? parsePolicy(identityRow.policyJson) : DEFAULT_WORKSPACE_POLICY;

      const machineRows = yield* sql<MachineRow>`
        SELECT
          environment_id AS "environmentId",
          label AS "label",
          monogram AS "monogram",
          color_slot AS "colorSlot",
          kind AS "kind",
          uno_box_id AS "unoBoxId",
          scope AS "scope",
          repositories_json AS "repositoriesJson",
          added_at AS "addedAt",
          last_seen_at AS "lastSeenAt"
        FROM workspace_machines
        ORDER BY added_at ASC
      `;

      const claimRows = yield* sql<ClaimRow>`
        SELECT
          claim_id AS "claimId",
          claim_key AS "claimKey",
          holder_environment_id AS "holderEnvironmentId",
          reason AS "reason",
          acquired_at AS "acquiredAt",
          expires_at AS "expiresAt"
        FROM workspace_claims
        WHERE expires_at > ${input.now}
        ORDER BY acquired_at ASC
      `;

      const grantRows = yield* sql<GrantRow>`
        SELECT
          grant_id AS "grantId",
          from_environment_id AS "fromEnvironmentId",
          to_environment_id AS "toEnvironmentId",
          repository_key AS "repositoryKey",
          capabilities_json AS "capabilitiesJson",
          transport AS "transport",
          mode AS "mode",
          requires_claim AS "requiresClaim",
          created_at AS "createdAt"
        FROM workspace_grants
        ORDER BY created_at ASC
      `;

      const requestRows = yield* sql.unsafe<RequestRow>(
        `SELECT ${requestColumns} FROM workspace_requests
         WHERE status = 'pending' AND expires_at > ? ORDER BY created_at ASC`,
        [input.now],
      );

      const hourAgo = new Date(new Date(input.now).getTime() - 60 * 60 * 1000).toISOString();
      const activityRows = yield* sql<{ readonly total: number }>`
        SELECT COUNT(*) AS "total" FROM workspace_activity WHERE occurred_at >= ${hourAgo}
      `;

      return {
        identity,
        machines: machineRows.map(toMachine),
        claims: claimRows.map(toClaim),
        grants: grantRows.map(toGrant),
        policy,
        pendingRequests: requestRows.map(toRequest),
        usage: {
          crossEnvironmentTurnsLastHour: activityRows[0]?.total ?? 0,
          // Active claims are the honest proxy for "work in flight from
          // elsewhere": a peer holds one for the duration of what it is doing.
          concurrentCrossEnvironment: claimRows.length,
        },
      } satisfies WorkspaceState;
    }).pipe(Effect.mapError(fail("getState")));

  return {
    ensureWorkspace,
    getIdentity,
    updateIdentity,
    getState,
    upsertMachine,
    removeMachine,
    touchMachine,
    setPolicy,
    upsertGrant,
    removeGrant,
    acquireClaim,
    releaseClaim,
    createRequest,
    decideRequest,
    getRequest,
    expireRequests,
    recordActivity,
    countActivitySince,
    getInstructionText,
    setInstructionText,
  } satisfies WorkspaceRegistryRepositoryShape;
});

export const WorkspaceRegistryRepositoryLive = Layer.effect(
  WorkspaceRegistryRepository,
  makeWorkspaceRegistryRepository,
);

export type { ManagerRepositoryError };
