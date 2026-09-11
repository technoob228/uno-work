/**
 * Settings → Assistants (environment scope) now IS the Telegram page: the
 * Helper is one per account and its settings are how the owner connects a
 * Telegram bot, chooses which chats may talk and what each chat talks to.
 *
 * Everything technical this panel used to show (external capability tokens
 * for MCP brains, links to per-assistant settings) lives under "Advanced" on
 * that page. Bound to an explicit environment because every row it edits is
 * in one daemon's database.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { TelegramPage } from "../helper/TelegramPage";

export function AssistantSettingsPanel({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  return <TelegramPage environmentId={environmentId} />;
}
