/**
 * "Share link" for an Uno Drive file: a download link that works while the
 * computer sleeps (the console answers it), with an expiry, copy and a QR
 * code for a phone. The link is shown once — the console only keeps a hash.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, LinkIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { filesApi } from "../files/filesApi";
import { DRIVE_SHARE_DURATIONS, driveQueryKeys } from "./driveApi";

export function DriveShareDialog({
  environmentId,
  target,
  onOpenChange,
}: {
  environmentId: EnvironmentId | null;
  /** The file (key inside Drive); null = closed. */
  target: { key: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [hours, setHours] = useState(24 * 7);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: (input: { key: string; hours: number }) =>
      filesApi(environmentId).driveShareCreate({ key: input.key, expiresInHours: input.hours }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.shares(environmentId) }),
  });

  // A new file → a fresh dialog.
  const targetKey = target?.key ?? null;
  useEffect(() => {
    create.reset();
    setCopied(false);
    setHours(24 * 7);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on a new target only
  }, [targetKey]);

  const url = create.data?.url ?? null;
  const copy = async () => {
    if (!url) return;
    await navigator.clipboard.writeText(url).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <LinkIcon className="size-5 shrink-0 text-sky-500" />
            <span className="truncate">Share “{target?.name}”</span>
          </DialogTitle>
          <DialogDescription>
            Anyone with the link can download this file, even while your computer is asleep. You can
            turn the link off any time in Uno Drive → Shared links.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          {url ? (
            <div className="flex flex-col items-center gap-3">
              <div className="flex w-full items-center gap-2">
                <Input
                  readOnly
                  value={url}
                  aria-label="Link"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button size="sm" onClick={() => void copy()}>
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <QRCodeSvg value={url} size={132} className="rounded-lg bg-white p-2" />
              <p className="text-center text-xs text-muted-foreground">
                Works until{" "}
                {create.data?.expiresAt
                  ? new Date(create.data.expiresAt).toLocaleDateString()
                  : "you turn it off"}
                . Copy it now — for safety Uno keeps only a fingerprint of the link.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <div className="text-xs font-medium text-muted-foreground">Link works for</div>
                <div
                  className="flex flex-wrap gap-1.5"
                  role="radiogroup"
                  aria-label="Link works for"
                >
                  {DRIVE_SHARE_DURATIONS.map((option) => (
                    <button
                      key={option.hours}
                      type="button"
                      role="radio"
                      aria-checked={hours === option.hours}
                      onClick={() => setHours(option.hours)}
                      className={cn(
                        "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                        hours === option.hours
                          ? "border-primary bg-primary/10 font-medium"
                          : "border-border hover:bg-accent",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              {create.error ? (
                <p className="text-sm text-destructive">
                  {create.error instanceof Error ? create.error.message : "Couldn't make a link."}
                </p>
              ) : null}
              <Button
                disabled={create.isPending || !target}
                onClick={() => target && create.mutate({ key: target.key, hours })}
              >
                {create.isPending ? <Loader2Icon className="animate-spin" /> : <LinkIcon />}
                Create link
              </Button>
            </>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
