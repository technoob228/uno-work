/**
 * In place of the message box in a chat imported from a computer: what it is,
 * and what's wrong if the history can't load. Writing in such a chat comes with
 * continuing it on the computer or in the cloud.
 */
import type { MyComputerChatHistory, ThreadComputerSource } from "@t3tools/contracts";
import { CloudIcon } from "lucide-react";

import { Button } from "../ui/button";
import { historyNotice } from "./chatImport.logic";

export function ImportedChatNote({
  source,
  history,
  loading,
  onRetry,
  onContinueInCloud,
  continuing = false,
}: {
  source: ThreadComputerSource;
  history: MyComputerChatHistory | undefined;
  loading: boolean;
  onRetry: () => void;
  /** Computers lifecycle: the computer is a tool for agents, so the chat goes on in the cloud. */
  onContinueInCloud?: () => void;
  continuing?: boolean;
}) {
  const notice = historyNotice({ history, loading, computerName: source.computerName });
  return (
    <div
      className="flex flex-col gap-1 rounded-2xl border border-border/60 bg-card px-4 py-3 text-sm"
      data-testid="imported-chat-note"
    >
      {onContinueInCloud ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground">Imported from {source.computerName}.</p>
          <Button
            size="sm"
            disabled={continuing}
            onClick={onContinueInCloud}
            data-testid="lc-imported-continue-cloud"
          >
            <CloudIcon />
            {continuing ? "Copying the project…" : "Continue in the cloud"}
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground">
          Imported from {source.computerName}. Continuing here is coming soon.
        </p>
      )}
      {notice !== null ? (
        <div className="flex items-center justify-between gap-3">
          <p data-testid="imported-chat-notice">{notice.text}</p>
          {notice.retry ? (
            <Button variant="ghost" size="sm" disabled={loading} onClick={onRetry}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
