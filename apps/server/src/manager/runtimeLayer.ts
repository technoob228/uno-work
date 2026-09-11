import { Layer } from "effect";

import { ManagerActionProposalRepositoryLive } from "../persistence/Layers/ManagerActionProposals.ts";
import { ManagerCapabilityTokenRepositoryLive } from "../persistence/Layers/ManagerCapabilityTokens.ts";
import { ManagerConnectorBindingRepositoryLive } from "../persistence/Layers/ManagerConnectorBindings.ts";
import { ManagerConnectorRepositoryLive } from "../persistence/Layers/ManagerConnectors.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../persistence/Layers/ProjectionPendingApprovals.ts";
import { RemindersRepositoryLive } from "../persistence/Layers/Reminders.ts";
import { AssistantBootstrapLive, ManagerAssistantServiceLive } from "./Layers/AssistantService.ts";
import { ConnectorEventsForwarderLive } from "./Layers/ConnectorEventsForwarder.ts";
import { ConnectorNotifyServiceLive } from "./Layers/ConnectorNotify.ts";
import { ManagerApprovalServiceLive } from "./Layers/ManagerApprovalService.ts";
import { ManagerBudgetServiceLive } from "./Layers/ManagerBudgetService.ts";
import { ManagerTokenAuthServiceLive } from "./Layers/ManagerTokenAuth.ts";
import { ManagerToolServiceLive } from "./Layers/ManagerToolService.ts";
import { ManagerTelegramServiceLive } from "./Layers/TelegramConnector.ts";
import { ManagerSlackServiceLive } from "./Layers/SlackConnector.ts";

const ManagerRepositoriesLive = Layer.mergeAll(
  ManagerActionProposalRepositoryLive,
  ManagerCapabilityTokenRepositoryLive,
  ManagerConnectorBindingRepositoryLive,
  ManagerConnectorRepositoryLive,
  ProjectionPendingApprovalRepositoryLive,
  RemindersRepositoryLive,
);

/**
 * Manager tool layer runtime. Requires `SqlClient`, `OrchestrationEngineService`,
 * `ProjectionSnapshotQuery` and `ProviderRegistry` (the assistant picks its
 * default harness from what is actually authenticated) from the outer runtime
 * (see `server.ts`).
 *
 * Exposes the repositories too: the assistant HTTP routes read connectors and
 * the assistant token directly.
 */
export const ManagerLayerLive = Layer.mergeAll(
  ManagerToolServiceLive,
  // Pushes thread events (errors, approvals, opt-in completions) to bound
  // chats; consumes the notify service and the engine provided below.
  ConnectorEventsForwarderLive,
).pipe(
  // Order matters: each layer's requirements are satisfied by the layers
  // provided AFTER it in this pipe.
  Layer.provideMerge(ManagerAssistantServiceLive),
  // Outbound channel (HTTP notify + forwarder) on top of the Telegram sender.
  Layer.provideMerge(ConnectorNotifyServiceLive),
  Layer.provideMerge(ManagerTelegramServiceLive),
  Layer.provideMerge(ManagerSlackServiceLive),
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
