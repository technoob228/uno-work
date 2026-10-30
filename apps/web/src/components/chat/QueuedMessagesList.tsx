/**
 * "Up next" at the end of the feed: what the person wrote while the agent was
 * working (queuedMessageStore.ts). Each message waits as a quiet bubble on the
 * person's side with Send now · Edit · Delete (row layout after upstream
 * QueuedRunsControl.tsx, bd3287b640).
 */
import { ArrowUpIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { memo } from "react";

import { extractQuotes } from "../../lib/chatQuotes";
import { type QueuedChatMessage } from "../../queuedMessageStore";

/** What the person wrote, with a word for the quotes that go with it. */
function queuedMessageText(text: string): string {
  const { text: own, quotes } = extractQuotes(text);
  if (quotes.length === 0) return own;
  const count = quotes.length === 1 ? "1 quote" : `${quotes.length} quotes`;
  return own ? `${own}\n+ ${count}` : count;
}

export const QueuedMessagesList = memo(function QueuedMessagesList({
  messages,
  onSendNow,
  onEdit,
  onDelete,
}: {
  messages: ReadonlyArray<QueuedChatMessage>;
  onSendNow: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (messages.length === 0) return null;
  return (
    <div className="flex flex-col items-end gap-2 pb-3" data-testid="queued-messages">
      <p className="pr-1 text-[11px] font-medium text-muted-foreground">Up next</p>
      {messages.map((message, index) => (
        <div
          key={message.id}
          className="group max-w-[80%] rounded-2xl rounded-br-sm border border-dashed border-border bg-secondary/40 px-4 py-2.5"
          data-testid="queued-message"
        >
          <p className="line-clamp-4 whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground/80">
            {queuedMessageText(message.text)}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="mr-auto">
              {message.hold
                ? "Waiting for you to send it"
                : index === 0
                  ? "Sends when the agent is done"
                  : "Sends after the one above"}
            </span>
            <button
              type="button"
              className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
              title="Send it now, while the agent is still working"
              onClick={() => onSendNow(message.id)}
            >
              <ArrowUpIcon className="size-3" />
              Send now
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 hover:text-foreground"
              title="Back into the message box to change it"
              onClick={() => onEdit(message.id)}
            >
              <PencilIcon className="size-3" />
              Edit
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 hover:text-foreground"
              onClick={() => onDelete(message.id)}
            >
              <Trash2Icon className="size-3" />
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
});
