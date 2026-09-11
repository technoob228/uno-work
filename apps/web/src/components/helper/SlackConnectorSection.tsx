import { useCallback, useEffect, useState } from "react";
import { SendIcon } from "lucide-react";
import type { EnvironmentId, ManagerSlackConnectorStatus } from "@t3tools/contracts";

import { saveAssistantSlack } from "../../lib/managerApi";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import {
  AddressingRows,
  DEFAULT_ADDRESSING_FORM,
  type AddressingFormState,
} from "./AddressingRows";
import { ModelSelectionFields } from "./ModelSelectionFields";
import {
  addressingConfigFromForm,
  addressingFormFromConfig,
  splitIdList,
} from "./telegramPageLogic";

/**
 * Self-contained Slack connector form for one assistant: tokens, allowed
 * channels, default harness, addressing. Owns its draft state, seeds it from
 * `slack` whenever that changes, and reports the outcome to the page.
 */
export function SlackConnectorSection({
  environmentId,
  projectId,
  slack,
  canMutate,
  environmentLabel,
  onSaved,
  onError,
}: {
  environmentId: EnvironmentId;
  projectId: string;
  slack: ManagerSlackConnectorStatus | null;
  canMutate: boolean;
  environmentLabel: string;
  onSaved: (notice: string) => void;
  onError: (message: string) => void;
}) {
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [channels, setChannels] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [instanceId, setInstanceId] = useState("uno");
  const [model, setModel] = useState("");
  const [addressing, setAddressing] = useState<AddressingFormState>(DEFAULT_ADDRESSING_FORM);

  useEffect(() => {
    if (slack === null) return;
    setEnabled(slack.enabled);
    setChannels(slack.allowedChannelIds.join(", "));
    if (slack.defaultModelSelection !== null) {
      setInstanceId(slack.defaultModelSelection.instanceId);
      setModel(slack.defaultModelSelection.model);
    }
    setAddressing(addressingFormFromConfig(slack.addressing));
  }, [slack]);

  const handleSave = useCallback(() => {
    // The button is disabled too; this is the guard that actually holds.
    if (!canMutate) return;
    void saveAssistantSlack({
      environmentId,
      projectId,
      ...(botToken.trim().length > 0 ? { botToken: botToken.trim() } : {}),
      ...(appToken.trim().length > 0 ? { appToken: appToken.trim() } : {}),
      allowedChannelIds: splitIdList(channels),
      enabled,
      defaultModelSelection: model.trim().length > 0 ? { instanceId, model: model.trim() } : null,
      addressing: addressingConfigFromForm(addressing),
    })
      .then(() => {
        setBotToken("");
        setAppToken("");
        onSaved(`Slack connector saved on ${environmentLabel}.`);
      })
      .catch((cause: unknown) =>
        onError(cause instanceof Error ? cause.message : "Failed to save Slack connector."),
      );
  }, [
    canMutate,
    environmentId,
    environmentLabel,
    projectId,
    botToken,
    appToken,
    channels,
    enabled,
    instanceId,
    model,
    addressing,
    onSaved,
    onError,
  ]);

  return (
    <SettingsSection
      title="Slack"
      icon={<SendIcon className="size-3.5" />}
      headerAction={
        <Button size="xs" variant="outline" disabled={!canMutate} onClick={handleSave}>
          Save
        </Button>
      }
    >
      <SettingsRow
        title="Slack bot"
        description={
          slack?.configured
            ? `Bot ${slack.botUserName ? `@${slack.botUserName}` : "configured"} · ${
                slack.enabled ? "enabled" : "disabled"
              }${slack.lastError ? ` · error: ${slack.lastError}` : ""}`
            : "Socket Mode bot: create the app from docs/slack-app-manifest.yaml, then paste both tokens."
        }
        control={
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Slack enabled" />
        }
      />
      <SettingsRow
        title="Bot token (xoxb-…)"
        description={
          slack?.configured ? "Leave empty to keep the current token." : "Bot User OAuth Token."
        }
        control={
          <input
            type="password"
            value={botToken}
            onChange={(event) => setBotToken(event.target.value)}
            placeholder="xoxb-…"
            aria-label="Slack bot token"
            className="w-64 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
          />
        }
      />
      <SettingsRow
        title="App token (xapp-…)"
        description={
          slack?.configured
            ? "Leave empty to keep the current token."
            : "App-Level Token with connections:write (for Socket Mode)."
        }
        control={
          <input
            type="password"
            value={appToken}
            onChange={(event) => setAppToken(event.target.value)}
            placeholder="xapp-…"
            aria-label="Slack app token"
            className="w-64 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
          />
        }
      />
      <SettingsRow
        title="Allowed channel ids"
        description="Channel and/or DM ids the bot may act in (comma-separated). Invite the bot to each channel with /invite."
        control={
          <input
            type="text"
            value={channels}
            onChange={(event) => setChannels(event.target.value)}
            placeholder="C0123ABCD, D0456WXYZ"
            aria-label="Slack allowed channel ids"
            className="w-64 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
          />
        }
      />
      <SettingsRow
        title="Default harness for Slack"
        description="Slack threads of this assistant always start on this harness/model — pick one that is authorized here."
        control={
          <ModelSelectionFields
            instanceId={instanceId}
            model={model}
            onInstanceChange={setInstanceId}
            onModelChange={setModel}
            placeholder="uno/moonshotai/kimi-k2.7-code"
            ariaLabel="Slack default"
          />
        }
      />
      <AddressingRows surface="slack" state={addressing} onChange={setAddressing} />
    </SettingsSection>
  );
}
