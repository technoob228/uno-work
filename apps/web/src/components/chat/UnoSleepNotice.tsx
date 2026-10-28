/**
 * Variant A (28.10), Free: Uno lives on a cloud computer that sleeps when
 * nobody uses it. Said once, honestly, above the composer of a chat with
 * Uno: it catches up when you open Work; Plus keeps it awake so it can
 * write first (the 08:00 summary, Allow from Telegram). "See Plus" opens the
 * console's plans in a new tab (console ↔ Work in a new tab).
 */
import { MoonIcon, XIcon } from "lucide-react";
import { memo, useState } from "react";

import { CHOOSE_PLAN_URL } from "../../account/planStatus";
import { openInNewTab } from "../../navigation/useOpenApp";
import { useUnoHome } from "../assistants/useUnoHome";
import { Button } from "../ui/button";

const DISMISSED = "uno:sleep-notice-dismissed";

export const UnoSleepNotice = memo(function UnoSleepNotice(props: {
  /** The open chat is one of Uno's (its channels). */
  readonly unoChat: boolean;
}) {
  const home = useUnoHome();
  const [dismissed, setDismissed] = useState(
    () => typeof sessionStorage !== "undefined" && sessionStorage.getItem(DISMISSED) === "1",
  );
  if (!props.unoChat || home.alwaysOn !== false || dismissed) return null;
  return (
    <div
      className="mx-3 mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-sm"
      role="status"
      data-testid="uno-sleep-notice"
    >
      <MoonIcon className="size-4 shrink-0 text-amber-600" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="font-medium">On Free, {home.label} naps when you're away.</span>{" "}
        <span className="text-muted-foreground">
          Uno catches up when you open Work. On Plus it stays awake: the summary comes at 08:00 and
          you can Allow from Telegram.
        </span>
      </span>
      <Button
        size="sm"
        type="button"
        onClick={() => openInNewTab(CHOOSE_PLAN_URL)}
        data-testid="uno-sleep-notice-plus"
      >
        See Plus
      </Button>
      <button
        type="button"
        aria-label="Hide"
        onClick={() => {
          sessionStorage.setItem(DISMISSED, "1");
          setDismissed(true);
        }}
        className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
});
