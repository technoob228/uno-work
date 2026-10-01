/**
 * Веб-режим встроенного браузера. Electron-webview здесь нет, поэтому браузером
 * управляет расширение Uno Work Companion во вкладках пользователя. Панель
 * детектит расширение, ведёт по установке и открывает адреса через него.
 */
import {
  CheckCircle2Icon,
  DownloadIcon,
  ExternalLinkIcon,
  Loader2Icon,
  PuzzleIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  detectBrowserExtension,
  readDetectedExtensionVersion,
  readExtensionStatus,
  runExtensionBrowserCommand,
} from "../../browserExtensionBridge";
import { toastManager, stackedThreadToast } from "../ui/toast";
import { Button } from "../ui/button";

export const COMPANION_EXTENSION_DOWNLOAD_URL =
  "https://console.uno4.dev/cli/work/uno-work-companion-0.2.0.zip";

type DetectState = "checking" | "connected" | "missing";

export function CompanionExtensionPanel({
  url,
  onOpenExternal,
}: {
  url: string;
  onOpenExternal: () => void;
}) {
  const [detectState, setDetectState] = useState<DetectState>("checking");
  const [version, setVersion] = useState<string | null>(null);
  const [sharedTabs, setSharedTabs] = useState<number | null>(null);

  const check = useCallback(async () => {
    setDetectState("checking");
    const detected = await detectBrowserExtension();
    if (detected === null) {
      setDetectState("missing");
      return;
    }
    setVersion(readDetectedExtensionVersion());
    setDetectState("connected");
    const status = await readExtensionStatus();
    setSharedTabs(status?.sharedTabs ?? null);
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const openViaExtension = useCallback(async () => {
    try {
      await runExtensionBrowserCommand({ command: "openUrl", url });
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Opened in a browser tab",
          description: "The agent can now use this tab.",
        }),
      );
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "The extension didn't open the tab",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }, [url]);

  if (detectState === "checking") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-muted-foreground">
        <Loader2Icon className="size-6 animate-spin opacity-60" />
        <p className="text-xs">Looking for the Uno Work Companion extension…</p>
      </div>
    );
  }

  if (detectState === "connected") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center text-muted-foreground">
        <CheckCircle2Icon className="size-8 text-emerald-500" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            Extension connected{version ? ` (v${version})` : ""}
          </p>
          <p className="mx-auto max-w-sm text-xs">
            The agent opens pages in tabs of this browser, using your signed-in sessions. It only
            sees tabs it opened itself
            {sharedTabs !== null ? ` (now: ${sharedTabs})` : ""} or tabs you shared with the
            extension icon.
          </p>
        </div>
        {url ? (
          <Button size="sm" variant="outline" onClick={() => void openViaExtension()}>
            <ExternalLinkIcon className="size-3.5" />
            Open {new URL(url).hostname} in a tab
          </Button>
        ) : (
          <p className="text-xs">Enter an address above. It will open in a new tab.</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 overflow-auto px-6 py-6 text-muted-foreground">
      <PuzzleIcon className="size-8 opacity-40" />
      <div className="space-y-1 text-center">
        <p className="text-sm font-medium text-foreground">
          Connect the Uno Work Companion extension
        </p>
        <p className="mx-auto max-w-sm text-xs">
          In the web version, the agent browses through the extension, in your own tabs and
          sessions. No passwords, no remote browser.
        </p>
      </div>
      <ol className="max-w-sm list-decimal space-y-1 pl-5 text-left text-xs">
        <li>Download the archive and unzip it into a folder.</li>
        <li>
          Open <span className="font-mono">chrome://extensions</span> and turn on Developer mode.
        </li>
        <li>Click "Load unpacked" and pick the folder from the archive.</li>
        <li>Come back here and reload the page.</li>
      </ol>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" render={<a href={COMPANION_EXTENSION_DOWNLOAD_URL} download />}>
          <DownloadIcon className="size-3.5" />
          Download extension
        </Button>
        <Button size="sm" variant="outline" onClick={() => void check()}>
          <RefreshCwIcon className="size-3.5" />
          Check again
        </Button>
        {url ? (
          <Button size="sm" variant="ghost" onClick={onOpenExternal}>
            <ExternalLinkIcon className="size-3.5" />
            Open in a new tab
          </Button>
        ) : null}
      </div>
    </div>
  );
}
