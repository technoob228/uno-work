/**
 * What to show where the interface isn't signed in to Uno yet. The account
 * belongs to the interface (see account/unoAccount.ts), so the fix is always
 * one step here — never "link a key in the machine's settings".
 */
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, LogInIcon } from "lucide-react";
import { useState } from "react";

import { UNO_WORK_URL, accountTransport } from "../../account/unoAccount";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const CONSOLE_WORK_URL = "https://console.uno4.dev/work";

export function AccountSignInCta({ className }: { readonly className?: string }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const transport = accountTransport();

  if (transport === "desktop") {
    return (
      <div className={className}>
        <p className="mb-3 text-sm text-muted-foreground">
          Sign in with your Uno account to see your computers, add new ones and switch between them.
        </p>
        <Button
          size="sm"
          disabled={busy}
          data-testid="uno-sign-in"
          onClick={async () => {
            setBusy(true);
            try {
              const status = await window.desktopBridge!.unoAccount!.signIn();
              if (status.signedIn) {
                await queryClient.invalidateQueries({ queryKey: ["workspace"] });
              }
            } catch (error) {
              toastManager.add({
                type: "error",
                title: "Couldn't sign in",
                description: error instanceof Error ? error.message : String(error),
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          <LogInIcon className="size-3.5" />
          {busy ? "Waiting for the browser…" : "Sign in with Uno"}
        </Button>
      </div>
    );
  }

  if (transport === "work-proxy") {
    return (
      <div className={className}>
        <p className="mb-3 text-sm text-muted-foreground">
          Your Uno session has ended. Sign in again to see your computers.
        </p>
        <Button size="sm" render={<a href={CONSOLE_WORK_URL} />}>
          <LogInIcon className="size-3.5" />
          Sign in again
        </Button>
      </div>
    );
  }

  return (
    <div className={className}>
      <p className="mb-3 text-sm text-muted-foreground">
        Your computers live in your Uno account. Open Uno Work at app.uno4.work (or the desktop app)
        to see, add and switch computers.
      </p>
      <Button
        size="sm"
        variant="outline"
        render={<a href={UNO_WORK_URL} target="_blank" rel="noreferrer" />}
      >
        <ExternalLinkIcon className="size-3.5" />
        Open app.uno4.work
      </Button>
    </div>
  );
}
