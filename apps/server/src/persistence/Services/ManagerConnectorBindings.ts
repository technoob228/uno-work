/**
 * ManagerConnectorBindingRepository - Persistence for chat → target bindings
 * of assistant connectors (`manager_connector_bindings`, ADR 2026-09-11).
 *
 * One row per (kind, chatId). A chat without a row is bound to the
 * assistant of the connector that carries it — the resolution of that
 * default lives in `manager/connectorBindings.ts`, not here.
 *
 * @module ManagerConnectorBindingRepository
 */
import type {
  ManagerConnectorBinding,
  ManagerConnectorBindingKind,
  ManagerConnectorBindingTarget,
  ProjectId,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect, Option } from "effect";

import type { ManagerRepositoryError } from "../Errors.ts";

export interface ManagerConnectorBindingKey {
  readonly kind: ManagerConnectorBindingKind;
  readonly chatId: string;
}

export interface ManagerConnectorBindingRepositoryShape {
  readonly get: (
    input: ManagerConnectorBindingKey,
  ) => Effect.Effect<Option.Option<ManagerConnectorBinding>, ManagerRepositoryError>;
  /** Every binding row; the resolver filters by target in memory (the table is tiny). */
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ManagerConnectorBinding>,
    ManagerRepositoryError
  >;
  /** Bindings of the chats carried by one assistant's connectors (settings UI). */
  readonly listByConnectorProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<ManagerConnectorBinding>, ManagerRepositoryError>;
  readonly upsert: (
    input: ManagerConnectorBindingKey & {
      readonly connectorProjectId: ProjectId;
      readonly target: ManagerConnectorBindingTarget;
      readonly notifyOnComplete: boolean;
      readonly updatedAt: string;
    },
  ) => Effect.Effect<void, ManagerRepositoryError>;
  /** Returns whether a row was removed. */
  readonly remove: (
    input: ManagerConnectorBindingKey,
  ) => Effect.Effect<boolean, ManagerRepositoryError>;
}

export class ManagerConnectorBindingRepository extends Context.Service<
  ManagerConnectorBindingRepository,
  ManagerConnectorBindingRepositoryShape
>()("t3/persistence/Services/ManagerConnectorBindings/ManagerConnectorBindingRepository") {}
