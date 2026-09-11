import { DEFAULT_CONNECTOR_ADDRESSING } from "@t3tools/contracts";

import { SettingsRow } from "../settings/settingsLayout";
import { Switch } from "../ui/switch";
import { addressingFormFromConfig, type AddressingForm } from "./telegramPageLogic";

export type AddressingFormState = AddressingForm;

export const DEFAULT_ADDRESSING_FORM: AddressingFormState = addressingFormFromConfig(
  DEFAULT_CONNECTOR_ADDRESSING,
);

const SURFACE_COPY = {
  telegram: {
    namesDescription:
      "Names the bot answers to in groups (comma-separated). Matched loosely, so “Антоха” also answers to “Антон”. Private chats always get a reply.",
    mentionTitle: "Only reply when addressed (groups)",
    mentionDescription:
      "In group chats, react only to an @mention, a reply to the bot, or one of its names above. Turn off to answer every message (only for a chat dedicated to the bot).",
    smartWakeDescription:
      "When the name isn't literally said, let an LLM decide if the message is aimed at the bot. Costs one cheap call per unmatched group message; also enables catching the name in group voice messages.",
    hotWindowDescription:
      "After the bot replies, keep answering the same chat without re-addressing it for this many seconds. 0 disables it.",
  },
  slack: {
    namesDescription:
      "Names the bot answers to in channels (comma-separated). Matched loosely. DMs always get a reply.",
    mentionTitle: "Only reply when addressed (channels)",
    mentionDescription:
      "In channels, react only to an @mention, a live bot thread, or one of its names. Off = answer every message the bot can see.",
    smartWakeDescription:
      "When the name isn't literally said, let an LLM decide if the message is aimed at the bot. Costs one cheap call per unmatched channel message.",
    hotWindowDescription:
      "After the bot replies, keep answering the same thread without re-addressing it for this many seconds. 0 disables it.",
  },
} as const;

/**
 * The four addressing controls shared by every chat connector: wake names,
 * require-mention, smart wake, follow-up window. Rendered inside a
 * SettingsSection; the owner of the form state saves it with the connector.
 */
export function AddressingRows({
  surface,
  state,
  onChange,
  disabled = false,
}: {
  surface: "telegram" | "slack";
  state: AddressingFormState;
  onChange: (next: AddressingFormState) => void;
  disabled?: boolean;
}) {
  const copy = SURFACE_COPY[surface];
  return (
    <>
      <SettingsRow
        title="Bot names"
        description={copy.namesDescription}
        control={
          <input
            type="text"
            value={state.names}
            disabled={disabled}
            aria-label={`${surface} bot names`}
            onChange={(event) => onChange({ ...state, names: event.target.value })}
            placeholder="Антоха, Антон"
            className="w-64 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
          />
        }
      />
      <SettingsRow
        title={copy.mentionTitle}
        description={copy.mentionDescription}
        control={
          <Switch
            checked={state.requireMention}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ ...state, requireMention: checked })}
            aria-label="Require addressing"
          />
        }
      />
      <SettingsRow
        title="Smart wake"
        description={copy.smartWakeDescription}
        control={
          <Switch
            checked={state.smartWake}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ ...state, smartWake: checked })}
            aria-label="Smart wake"
          />
        }
      />
      <SettingsRow
        title="Follow-up window (seconds)"
        description={copy.hotWindowDescription}
        control={
          <input
            type="number"
            min={0}
            value={state.hotWindowSec}
            disabled={disabled}
            aria-label={`${surface} follow-up window seconds`}
            onChange={(event) => onChange({ ...state, hotWindowSec: event.target.value })}
            placeholder="0"
            className="w-24 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
          />
        }
      />
    </>
  );
}
