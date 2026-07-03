import { Layer } from "effect";

import { ManagerActionProposalRepositoryLive } from "../persistence/Layers/ManagerActionProposals.ts";
import { ManagerCapabilityTokenRepositoryLive } from "../persistence/Layers/ManagerCapabilityTokens.ts";
import { ManagerConnectorRepositoryLive } from "../persistence/Layers/ManagerConnectors.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../persistence/Layers/ProjectionPendingApprovals.ts";
import {
  AssistantBootstrapLive,
  ManagerAssistantServiceLive,
} from "./Layers/AssistantService.ts";
import { ManagerApprovalServiceLive } from "./Layers/ManagerApprovalService.ts";
import { ManagerBudgetServiceLive } from "./Layers/ManagerBudgetService.ts";
import { ManagerTokenAuthServiceLive } from "./Layers/ManagerTokenAuth.ts";
import { ManagerToolServiceLive } from "./Layers/ManagerToolService.ts";
import { ManagerTelegramServiceLive } from "./Layers/TelegramConnector.ts";

const ManagerRepositoriesLive = Layer.mergeAll(
  ManagerActionProposalRepositoryLive,
  ManagerCapabilityTokenRepositoryLive,
  ManagerConnectorRepositoryLive,
  ProjectionPendingApprovalRepositoryLive,
);

/**
 * Manager tool layer runtime. Requires `SqlClient`, `OrchestrationEngineService`
 * and `ProjectionSnapshotQuery` from the outer runtime (see `server.ts`).
 *
 * Exposes the repositories too: the assistant HTTP routes read connectors and
 * the assistant token directly.
 */
export const ManagerLayerLive = ManagerToolServiceLive.pipe(
  // Order matters: each layer's requirements are satisfied by the layers
  // provided AFTER it in this pipe.
  Layer.provideMerge(ManagerAssistantServiceLive),
  Layer.provideMerge(ManagerTelegramServiceLive),
  Layer.provideMerge(ManagerApprovalServiceLive),
  Layer.provide(ManagerBudgetServiceLive),
  Layer.provideMerge(ManagerTokenAuthServiceLive),
  Layer.provideMerge(ManagerRepositoriesLive),
);

/**
 * Startup effect: ensure the assistant project/workspace/token exist. Wired
 * separately so it can depend on the full manager layer.
 */
export const ManagerAssistantBootstrapLive = AssistantBootstrapLive;
