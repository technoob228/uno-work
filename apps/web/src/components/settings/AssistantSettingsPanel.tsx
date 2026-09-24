/**
 * Settings → Assistant (environment scope): Uno's overview on top (what it
 * is, show in sidebar, what it can see and manage, Telegram / Slack through
 * the guided dialog — 0.0.85), then the full connector page: bot token,
 * which chats may write, what each chat talks to, and under "Advanced" the
 * technical rest (external MCP brains, per-assistant settings).
 *
 * Bound to an explicit environment because every row it edits is in one
 * daemon's database.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { AssistantOverviewSettings } from "../assistant/AssistantOverviewSettings";
import { TelegramPage } from "../helper/TelegramPage";

export function AssistantSettingsPanel({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  return (
    <TelegramPage
      environmentId={environmentId}
      header={<AssistantOverviewSettings environmentId={environmentId} />}
    />
  );
}
