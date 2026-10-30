/** Messages set aside with ⌘S: click one to bring it into this chat. */
import { ArchiveIcon, XIcon } from "lucide-react";
import { memo } from "react";

import {
  stashedMessagePreview,
  useComposerStashStore,
  type StashedMessage,
} from "../../composerStashStore";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export const ComposerStashMenu = memo(function ComposerStashMenu(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRestore: (entry: StashedMessage) => void;
}) {
  const entries = useComposerStashStore((store) => store.entries);
  const remove = useComposerStashStore((store) => store.remove);
  if (entries.length === 0) return null;
  const label = `${entries.length} set aside`;
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger
        aria-label={label}
        title={label}
        data-testid="composer-stash"
        className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 text-muted-foreground text-xs tabular-nums transition-colors hover:bg-accent/60"
      >
        <ArchiveIcon className="size-3.5" aria-hidden />
        <span>{entries.length}</span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" className="w-80">
        <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto" role="list">
          {entries.map((entry) => (
            <li key={entry.id} className="group/stash relative">
              <button
                type="button"
                className="w-full cursor-pointer truncate rounded-md py-1.5 pr-8 pl-2 text-left text-sm hover:bg-accent/60"
                onClick={() => {
                  const taken = useComposerStashStore.getState().take(entry.id);
                  if (taken) props.onRestore(taken);
                  props.onOpenChange(false);
                }}
              >
                {stashedMessagePreview(entry)}
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="absolute top-1 right-1 opacity-0 group-hover/stash:opacity-100 focus-visible:opacity-100"
                aria-label="Delete"
                onClick={() => remove(entry.id)}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      </PopoverPopup>
    </Popover>
  );
});
