import { scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { CheckIcon, EyeIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useEnvironmentSupportsThreadSettlement } from "../../environments/threadSettlementSupport";
import { markChatDone } from "../../inbox/inboxDone";
import { selectSidebarThreadSummaryByRef, useStore } from "../../store";
import { isYourTurn } from "../Sidebar.yourTurn";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * "Read" and "Done" in the chat's header while the chat waits on the person:
 * looking at the answer doesn't end "Your turn" — replying or one of these
 * does. Read keeps the chat in its place in the list; Done parks it on the
 * Done shelf.
 */
export function ChatDoneButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Phone: the check mark alone, so the chat's title keeps its room. */
  readonly compact?: boolean;
}) {
  const ref = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const thread = useStore((state) => selectSidebarThreadSummaryByRef(state, ref));
  const supported = useEnvironmentSupportsThreadSettlement(props.environmentId);
  const setThreadReadAt = useStore((state) => state.setThreadReadAt);
  const [pending, setPending] = useState(false);
  if (!thread || !isYourTurn(thread, new Date().toISOString())) return null;

  const onClick = () => {
    setPending(true);
    markChatDone(props.environmentId, props.threadId)
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Couldn't mark it done",
          description: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setPending(false));
  };

  const read = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            className="shrink-0"
            onClick={() => setThreadReadAt(ref, new Date().toISOString())}
            data-testid="chat-read-button"
            aria-label="Mark as read"
          />
        }
      >
        <EyeIcon className="size-3" />
        {props.compact ? null : "Read"}
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-64">
        You've seen the answer and have nothing to add for now. The chat stays in the list and stops
        asking for your turn until it finishes something new.
      </TooltipPopup>
    </Tooltip>
  );
  if (!supported) return read;

  return (
    <>
      {read}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              className="shrink-0 border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300"
              disabled={pending}
              onClick={onClick}
              data-testid="chat-done-button"
              aria-label="Done"
            />
          }
        >
          <CheckIcon className="size-3" />
          {props.compact ? null : "Done"}
        </TooltipTrigger>
        <TooltipPopup side="bottom" className="max-w-64">
          This chat finished and waits for you. Reply to keep going, or press Done when there's
          nothing more to do.
        </TooltipPopup>
      </Tooltip>
    </>
  );
}
