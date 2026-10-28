/**
 * The assistant sandbox — "Only selected projects" held as a boundary: on a
 * computer that can run it (Linux with bubblewrap: an Uno cloud computer),
 * a restricted assistant's agent sees only its projects and its own folder.
 * Elsewhere (a Mac today) "Only selected projects" is refused when it is set,
 * and an assistant restricted before is stopped at its next turn, never run
 * open.
 *
 * @module AssistantSandbox
 */
import { Schema } from "effect";

import { ManagerAssistantSummary } from "./manager.ts";

/**
 * `GET /api/manager/assistants`. `assistantSandbox`: this computer can hold
 * an assistant to its selected projects — offer "Only selected projects"
 * only when true. Absent on daemons before it: treat as false.
 */
export const ManagerAssistantsList = Schema.Struct({
  assistants: Schema.Array(ManagerAssistantSummary),
  assistantSandbox: Schema.optional(Schema.Boolean),
  /**
   * The account has assistants (`assistants_mvp`), as this computer's daemon
   * sees it with its own key — for a page opened at the computer's own
   * address, where the account isn't reachable from the browser.
   */
  assistantsEnabled: Schema.optional(Schema.Boolean),
});
export type ManagerAssistantsList = typeof ManagerAssistantsList.Type;
