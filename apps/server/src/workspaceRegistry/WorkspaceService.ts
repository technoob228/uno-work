/**
 * WorkspaceService — машины этого демона и текст инструкций.
 *
 * Здесь осталось ровно то, чем пользуется приложение: список машин с
 * подписями, монограммами и цветами и слои инструкций.
 *
 * Гранты, claims, запросы и политика реестра (миграция 038) удалены. Они
 * описывали «одна машина командует другой», но ни одна проверка прав по ним не
 * выполнялась, а RPC `workspace.*` мог дёрнуть любой подключённый клиент: это
 * была готовая точка эскалации, как только права появятся. Права на чужие
 * директории будут считаться из аккаунта (см. knowledge/uno-work-team-workspace.md),
 * а не из локального реестра. Таблицы 038 остаются на месте до релиза,
 * который их снесёт.
 */
import {
  EnvironmentId,
  WorkspaceRpcError,
  deriveMachineMonogram,
  type WorkspaceMachine,
  type WorkspaceState,
  type WorkspaceSyncMachinesInput,
  type WorkspaceUpdateMachineInput,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Option } from "effect";

import { WorkspaceRegistryRepository } from "../persistence/Services/WorkspaceRegistry.ts";

/**
 * Three hues, then neutral. A fourth hue puts a pair on screen that the
 * commonest colour-vision deficiencies cannot separate.
 */
const MACHINE_COLOR_SLOTS = 3;

const WORKSPACE_ID_PREFIX = "workspace_";

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
  readonly getInstructionText: (input: {
    readonly scope: string;
  }) => Effect.Effect<string, WorkspaceRpcError>;
  readonly setInstructionText: (input: {
    readonly scope: string;
    readonly text: string;
  }) => Effect.Effect<WorkspaceState, WorkspaceRpcError>;
}

export class WorkspaceService extends Context.Service<WorkspaceService, WorkspaceServiceShape>()(
  "t3/workspace/WorkspaceService",
) {}

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
    return yield* repository.getState({ now: now() });
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
    getInstructionText,
    setInstructionText,
  } satisfies WorkspaceServiceShape;
});

export const WorkspaceServiceLive = Layer.effect(WorkspaceService, makeWorkspaceService);
