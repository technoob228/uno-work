import {
  EnvironmentId,
  type WorkspaceIdentity,
  type WorkspaceMachine,
  type WorkspaceMachineKind,
  type WorkspaceMachineScope,
  type WorkspaceState,
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type ManagerRepositoryError } from "../Errors.ts";
import {
  WorkspaceRegistryRepository,
  type WorkspaceRegistryRepositoryShape,
} from "../Services/WorkspaceRegistry.ts";

interface IdentityRow {
  readonly workspaceId: string;
  readonly name: string;
  readonly epoch: number;
  readonly registryEnvironmentId: string | null;
  readonly unoAccountId: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const IDENTITY_COLUMNS = `
  workspace_id AS "workspaceId",
  name AS "name",
  epoch AS "epoch",
  registry_environment_id AS "registryEnvironmentId",
  uno_account_id AS "unoAccountId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

/**
 * `policy_json` is NOT NULL in migration 038 and nothing reads it any more —
 * the cross-machine policy went away with the grants. New rows get an empty
 * object until the release that drops the column.
 */
const LEGACY_EMPTY_POLICY_JSON = "{}";

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

function toMachineKind(value: string): WorkspaceMachineKind {
  return value === "local" || value === "ssh" || value === "uno_box" ? value : "ssh";
}

function toMachineScope(value: string): WorkspaceMachineScope {
  return value === "repositories" ? "repositories" : "full";
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
          NULL, ${LEGACY_EMPTY_POLICY_JSON}, ${input.now}, ${input.now}
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
      yield* bumpEpoch(input.now);
    }).pipe(Effect.mapError(fail("removeMachine")));

  const touchMachine: WorkspaceRegistryRepositoryShape["touchMachine"] = (input) =>
    sql`
      UPDATE workspace_machines
      SET last_seen_at = ${input.lastSeenAt}
      WHERE environment_id = ${input.environmentId}
    `.pipe(Effect.asVoid, Effect.mapError(fail("touchMachine")));

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

      return {
        identity,
        machines: machineRows.map(toMachine),
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
    getInstructionText,
    setInstructionText,
  } satisfies WorkspaceRegistryRepositoryShape;
});

export const WorkspaceRegistryRepositoryLive = Layer.effect(
  WorkspaceRegistryRepository,
  makeWorkspaceRegistryRepository,
);

export type { ManagerRepositoryError };
