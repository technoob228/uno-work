/**
 * On an assistant's page: what its work runs on and what it replies with —
 * both chosen in one place, Settings → AI → "Default model" (13.11 v2, Misha:
 * the page used to have "Who does the work" and "The AI it runs on" as two
 * more pickers). Shows the value and links there; picks nothing itself.
 *
 * @module components/assistants/AssistantAiLine
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { assistantModelLabel } from "@t3tools/shared/assistantLlm";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { useAssistantLlm } from "../../assistant/useAssistantLlm";
import {
  useEnvironmentProviders,
  useEnvironmentSettings,
} from "../../environments/settings/serverSettings";
import { cardOf } from "../assistant/AssistantPowerPicker";
import { DEFAULT_MODEL_FOLD_HASH } from "../settings/DefaultModelFolds";
import { modelSelectionLabel } from "../settings/NewChatDefaultsRows";
import { autoWorkChoice, modelChoices } from "./assistantMemoryModels.logic";
import { BRAIN_NAME } from "./assistantTeam.logic";

export function AssistantAiLine(props: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly revoked?: boolean;
}) {
  const { environmentId, name } = props;
  const navigate = useNavigate();
  const providers = useEnvironmentProviders(environmentId);
  const settings = useEnvironmentSettings(environmentId);
  const llm = useAssistantLlm(environmentId);
  const auto = useMemo(
    () =>
      autoWorkChoice(providers, modelChoices(providers, name), settings?.harnessUnoCredits ?? {}),
    [providers, name, settings?.harnessUnoCredits],
  );
  // What the server reads for its work (personRouting.ts): the computer's copy.
  const chosen = settings?.defaultModelSelection ?? null;
  const work = chosen
    ? modelSelectionLabel(providers, chosen)
    : auto
      ? `Auto · ${auto.label}`
      : "Auto";
  const brain = llm.status
    ? [
        llm.status.model ? assistantModelLabel(llm.status.model) : null,
        BRAIN_NAME[cardOf(llm.status.provider)],
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const open = (fold?: string) =>
    void navigate({ to: "/settings/ai", ...(fold ? { hash: `fold=${fold}` } : {}) });
  return (
    <div className="flex flex-col gap-0.5" data-testid="assistant-profile-ai">
      <div className="flex flex-wrap items-center gap-x-2">
        <span>{work}</span>
        {props.revoked ? null : (
          <button
            type="button"
            onClick={() => open()}
            className="cursor-pointer text-xs text-primary hover:underline"
            data-testid="assistant-profile-ai-change"
          >
            Change in Settings → AI
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        The default model: {name}'s chats and the tasks it hands out run on it.
        {brain ? (
          <>
            {" "}
            It replies with {brain} (
            <button
              type="button"
              onClick={() => open(DEFAULT_MODEL_FOLD_HASH.advanced)}
              className="cursor-pointer text-primary hover:underline"
            >
              Advanced
            </button>
            ).
          </>
        ) : null}
      </p>
    </div>
  );
}
