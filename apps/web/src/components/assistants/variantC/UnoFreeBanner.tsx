/**
 * Variant C on Free: Uno lives on the cloud computer, and on Free it sleeps
 * when the person leaves — so no 08:00 summary and no Telegram answers until
 * Work opens. Said plainly above Uno's chat, with the way to Plus.
 */
import { MoonIcon } from "lucide-react";

import { PLUS_URL, useUnoPlan } from "./useUnoPlan";

export function UnoFreeBanner() {
  const plan = useUnoPlan();
  if (plan !== "free") return null;
  return (
    <div
      className="mx-auto mt-2 flex w-full max-w-3xl items-center gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      data-testid="uno-free-banner"
    >
      <MoonIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        On Free, your cloud computer sleeps when you leave. Uno can't write first or answer Telegram
        until you open Work — then it catches up.
      </span>
      <a
        href={PLUS_URL}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 font-medium text-primary hover:underline"
      >
        Keep Uno awake · Plus
      </a>
    </div>
  );
}
