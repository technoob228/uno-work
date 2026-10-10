/**
 * The chat header's quiet line about what this chat runs on, and so who pays
 * for its AI: "Uno AI" / "Your Claude plan" / "Your ChatGPT plan" / "Your own
 * key" (decision 10.10). The sentence about money is in the tooltip.
 *
 * It says what the daemon knows about the chat's harness now (`chatRunsOn`);
 * when the daemon can't tell, there is no chip — never a guess about money.
 */
import { CHAT_RUNS_ON_HINT, CHAT_RUNS_ON_LABEL, type ChatRunsOn } from "@t3tools/shared/chatRunsOn";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ChatRunsOnChip({ runsOn }: { readonly runsOn: ChatRunsOn | null }) {
  if (runsOn === null) return null;
  const label = CHAT_RUNS_ON_LABEL[runsOn];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="shrink-0 cursor-default truncate text-xs text-muted-foreground"
            data-testid="chat-runs-on"
            data-runs-on={runsOn}
            aria-label={`This chat runs on: ${label}`}
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-72">
        {CHAT_RUNS_ON_HINT[runsOn]}
      </TooltipPopup>
    </Tooltip>
  );
}
