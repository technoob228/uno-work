/**
 * The desktop app's own path (SPEC: "Десктоп-приложение на этом же компьютере
 * после входа в Uno само ставит помощника"): signed in, with a cloud computer
 * connected, and this Mac not one of the computers yet — one calm card. Without
 * a cloud computer there is nobody to use the helper, so no card.
 * Yes → the app sets the helper up itself (no terminal) → "What is it for?"
 * with "A full computer" picked → "Bring your work?".
 */
import { useQueryClient } from "@tanstack/react-query";
import { LaptopIcon, Loader2Icon } from "lucide-react";

import { lifecycleBackend } from "../../computersLifecycle/backend";
import { useComputersLifecycleDesktop } from "../../computersLifecycle/desktop";
import { lifecycle, useLifecycle } from "../../computersLifecycle/store";
import { errorText, useOwnComputers } from "../../computersLifecycle/useComputers";
import { useRefreshMyComputers } from "../../localComputer/useMyComputers";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { useThisMacHelper } from "./WhereAgentsRun";

export function ThisMacPrompt() {
  const desktop = useComputersLifecycleDesktop();
  const prompt = useLifecycle((state) => state.thisMacPrompt);
  const addOpen = useLifecycle((state) => state.addOpen);
  const { hostId, computers: own, settled, enabled } = useOwnComputers();
  const helper = useThisMacHelper();
  const queryClient = useQueryClient();
  const refresh = useRefreshMyComputers();
  // This Mac already is one of the computers: its helper's id is on the list.
  const alreadyOne = helper.computerId !== null && own.some((one) => one.id === helper.computerId);
  const shown =
    desktop &&
    prompt !== "done" &&
    !addOpen &&
    hostId !== null &&
    enabled &&
    settled &&
    !alreadyOne &&
    lifecycleBackend.canInstallHere();
  if (!shown || hostId === null) return null;

  const yes = async () => {
    lifecycle.setThisMacPrompt("installing");
    try {
      const computerId = await lifecycleBackend.installHere(hostId);
      await Promise.all([
        refresh(),
        queryClient.invalidateQueries({ queryKey: ["computers", "this-mac-helper"] }),
      ]);
      lifecycle.thisMacConnected(computerId);
    } catch (cause) {
      lifecycle.setThisMacPrompt("ask");
      toastManager.add({
        type: "error",
        title: errorText(cause, "Couldn’t set up this Mac. Try again."),
      });
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
