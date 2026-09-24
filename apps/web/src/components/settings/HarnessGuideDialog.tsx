/**
 * docs/custom-harness.md inside the app (bundled at build time), so the
 * contract is one click away from Settings → Harnesses even offline; the
 * daemon keeps the same file at `~/.uno/docs/custom-harness.md` for agents.
 *
 * @module components/settings/HarnessGuideDialog
 */
import guideMarkdown from "../../../../../docs/custom-harness.md?raw";

import ChatMarkdown from "../ChatMarkdown";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";

export function HarnessGuideDialog({
  open,
  onOpenChange,
  guidePath,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Where the daemon keeps the same file, for agents. */
  readonly guidePath: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-3xl overflow-hidden">
        <div className="flex max-h-[85vh] min-h-0 flex-col bg-background">
          <DialogHeader className="border-b border-border/70">
            <DialogTitle>Custom harness guide</DialogTitle>
            <DialogDescription>
              The contract a harness must follow.
              {guidePath ? (
                <>
                  {" "}
                  On this machine it is also at <code>{guidePath}</code> — tell your AI to read it
                  and add a harness for you.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 text-sm [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-6 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold">
            <ChatMarkdown text={guideMarkdown} cwd={undefined} />
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
