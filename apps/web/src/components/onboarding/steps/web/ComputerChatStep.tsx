import { Loader2, MessageSquare } from "lucide-react";
import { useState } from "react";

import { FIRST_CHAT_SUGGESTIONS } from "../../firstChat";
import { StepTitle } from "../stepShared";

export interface ComputerChatStepProps {
  pending: boolean;
  error: string | null;
  /** Opens the first chat with this message ready to send (see useFirstChatLaunch). */
  onPick: (prompt: string) => void;
}

/**
 * Final onboarding screen: no more explaining — pick a first task. Each chip
 * opens a real draft chat on the machine with the message already in the
 * composer, so the first send is a single keystroke.
 */
export function ComputerChatStep({ pending, error, onPick }: ComputerChatStepProps) {
  const [pickedId, setPickedId] = useState<string | null>(null);

  return (
    <div className="m-auto flex w-full max-w-2xl flex-col items-center gap-6 text-center">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
        First task
      </div>
      <StepTitle>Ask it to do something</StepTitle>
      <p className="max-w-xl text-base leading-relaxed text-muted-foreground">
        That&apos;s the whole workflow: you ask, your computer does the work, you watch it happen.
        Start with one of these, or open the chat and ask in your own words.
      </p>

      <div className="grid w-full max-w-xl gap-3 sm:grid-cols-2">
        {FIRST_CHAT_SUGGESTIONS.map((suggestion) => {
          const isPicked = pending && pickedId === suggestion.id;
          return (
            <button
              key={suggestion.id}
              type="button"
              disabled={pending}
              onClick={() => {
                setPickedId(suggestion.id);
                onPick(suggestion.prompt);
              }}
              className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 text-left text-sm font-medium transition hover:border-primary/50 hover:bg-primary/5 disabled:opacity-60"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                {isPicked ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <MessageSquare className="size-4" />
                )}
              </span>
              {suggestion.label}
            </button>
          );
        })}
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground/70">
        Picking one opens your first chat with the message ready — you press Enter to send it.
      </p>
    </div>
  );
}
