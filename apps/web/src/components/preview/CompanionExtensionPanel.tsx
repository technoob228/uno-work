/**
 * Веб-режим встроенного браузера. Electron-webview здесь нет: страница
 * открывается новой вкладкой браузера человека. Расширение Uno Work Companion —
 * необязательное: только чтобы агент работал во вкладках человека; если оно
 * стоит, адреса открываются через него.
 */
import {
  CheckCircle2Icon,
  DownloadIcon,
  ExternalLinkIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  detectBrowserExtension,
  readDetectedExtensionVersion,
  readExtensionStatus,
  runExtensionBrowserCommand,
} from "../../browserExtensionBridge";
import { cn } from "../../lib/utils";
import { toastManager, stackedThreadToast } from "../ui/toast";
import { Button } from "../ui/button";

export const COMPANION_EXTENSION_DOWNLOAD_URL =
  "https://console.uno4.dev/cli/work/uno-work-companion-0.2.0.zip";

export type DetectState = "checking" | "connected" | "missing";

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

  // No extension (the usual case): the page opens in a new tab of this
  // browser — no install needed. The extension is an optional extra, explained
  // in plain words below (Misha 16.10: "it asks for some extension — what is
  // it and why").
  let host: string | null = null;
  try {
    host = url ? new URL(url).hostname : null;
  } catch {
    host = null;
  }
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 overflow-auto px-6 py-6 text-muted-foreground"
      data-testid="your-browser-panel"
    >
      <ExternalLinkIcon className="size-8 opacity-40" />
      <div className="space-y-1 text-center">
        <p className="text-sm font-medium text-foreground">Opens in your browser</p>
        <p className="mx-auto max-w-sm text-xs">
          {url
            ? "Sites open in a new tab of this browser, with your own sign-ins."
            : "Enter an address above. It opens in a new tab of this browser."}
        </p>
      </div>
      {url ? (
        <Button size="sm" onClick={onOpenExternal} data-testid="your-browser-open-tab">
          <ExternalLinkIcon className="size-3.5" />
          Open {host ?? "it"} in a new tab
        </Button>
      ) : null}
      <CompanionExtensionDetails
        className="mx-auto mt-2 max-w-sm"
        detectState={detectState}
        onCheck={() => void check()}
        summary="Want the agent to work in this browser too?"
      />
    </div>
  );
}

/**
 * The optional extension, folded: what it's for and how to add it. Shared by
 * the page above and the web version's live tab (YourBrowserTab), where it is
 * the small "Advanced" line under the page.
 */
export function CompanionExtensionDetails({
  summary,
  detectState,
  onCheck,
  className,
  summaryClassName,
}: {
  summary: string;
  detectState: DetectState;
  onCheck: () => void;
  className?: string;
  summaryClassName?: string;
}) {
  return (
    <details className={cn("text-xs", className)} data-testid="companion-extension-details">
      <summary
        className={cn(
          "cursor-pointer text-center text-muted-foreground/80 hover:text-foreground",
          summaryClassName,
        )}
      >
        {summary}
      </summary>
      <div className="mt-2 space-y-2 text-left text-muted-foreground">
        <p>
          Only if you want the agent to click and type in your own tabs (with your sign-ins). For
          that, add the Uno Work Companion extension to Chrome. You don't need it to open sites —
          the agent also has its own browser on your computer.
        </p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Download the archive and unzip it into a folder.</li>
          <li>
            Open <span className="font-mono">chrome://extensions</span> and turn on Developer mode.
          </li>
          <li>Click "Load unpacked" and pick the folder from the archive.</li>
          <li>Come back and press Check again.</li>
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            render={<a href={COMPANION_EXTENSION_DOWNLOAD_URL} download />}
          >
            <DownloadIcon className="size-3.5" />
            Download extension
          </Button>
          <Button size="xs" variant="ghost" onClick={onCheck}>
            {detectState === "checking" ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
            Check again
          </Button>
          {detectState === "connected" ? (
            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2Icon className="size-3.5" />
              Connected
            </span>
          ) : null}
        </div>
      </div>
    </details>
  );
}

/** Is the extension in this browser: checked once on mount, again on "Check again". */
export function useCompanionExtensionCheck(): { detectState: DetectState; check: () => void } {
  const [detectState, setDetectState] = useState<DetectState>("checking");
  const check = useCallback(() => {
    setDetectState("checking");
    void detectBrowserExtension().then((detected) =>
      setDetectState(detected === null ? "missing" : "connected"),
    );
  }, []);
  useEffect(() => {
    check();
  }, [check]);
  return { detectState, check };
}
