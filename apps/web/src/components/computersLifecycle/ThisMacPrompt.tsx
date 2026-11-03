/**
 * The desktop app's own path (SPEC: "Десктоп-приложение на этом же компьютере
 * после входа в Uno само ставит помощника"): signed in, with a cloud computer
 * on the account, and this Mac not one of the computers yet — one calm card.
 * Yes → the app sets the helper up itself (no terminal) → "What is it for?"
 * with "A full computer" picked → "Bring your work?".
 */
import { LaptopIcon, Loader2Icon } from "lucide-react";

import { lifecycleBackend } from "../../computersLifecycle/backend";
import { useComputersLifecycleDesktop } from "../../computersLifecycle/desktop";
import { lifecycle, useLifecycle } from "../../computersLifecycle/store";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useMyComputers, useRefreshMyComputers } from "../../localComputer/useMyComputers";
import { useSidebarDComputers } from "../sidebar/SidebarDComputers";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function ThisMacPrompt() {
  const desktop = useComputersLifecycleDesktop();
  const prompt = useLifecycle((state) => state.thisMacPrompt);
  const addOpen = useLifecycle((state) => state.addOpen);
  const primaryId = usePrimaryEnvironmentId();
  const { computers: own, settled } = useMyComputers(desktop ? primaryId : null);
  const hasCloud = useSidebarDComputers().some((computer) => computer.cloud);
  const refresh = useRefreshMyComputers();
  const shown =
    desktop &&
    prompt !== "done" &&
    !addOpen &&
    settled &&
    own.length === 0 &&
    hasCloud &&
    lifecycleBackend.canInstallHere();
  if (!shown) return null;

  const yes = async () => {
    lifecycle.setThisMacPrompt("installing");
    try {
      const computerId = await lifecycleBackend.installHere();
      if (computerId === null) throw new Error("not available");
      await refresh();
      lifecycle.thisMacConnected(computerId);
    } catch {
      lifecycle.setThisMacPrompt("ask");
      toastManager.add({ type: "error", title: "Couldn’t set up this Mac. Try again." });
    }
  };
  const installing = prompt === "installing";
  return (
    <div
      className="fixed right-6 bottom-6 z-40 flex w-80 flex-col gap-3 rounded-2xl border bg-popover p-4 text-popover-foreground shadow-lg/5"
      data-testid="lc-this-mac-prompt"
      role="dialog"
      aria-label="Make this Mac one of your computers?"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          {installing ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <LaptopIcon className="size-4" />
          )}
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">
            {installing ? "Setting up this Mac…" : "Make this Mac one of your computers?"}
          </span>
          <span className="text-xs text-muted-foreground">
            {installing
              ? "No terminal needed."
              : "Your agents can use it, and chats can start on it."}
          </span>
        </div>
      </div>
      {installing ? null : (
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => lifecycle.setThisMacPrompt("done")}
            data-testid="lc-this-mac-later"
          >
            Skip
          </Button>
          <Button size="sm" onClick={() => void yes()} data-testid="lc-this-mac-yes">
            Yes
          </Button>
        </div>
      )}
    </div>
  );
}
