/**
 * "Share with a link" for a file in the panel (w0138, point 8): a popover
 * under ↗ — the same on the Mac and on a cloud computer: how long the link
 * works, a password, one button, then the link with Copy.
 *
 * Two ways to make the link (fileShare.logic.ts):
 * - "computer-link": the computer that has the file answers the link (a cloud
 *   computer has a public address; asleep, it wakes up for the visitor).
 * - "cloud-copy": the laptop isn't reachable from the internet, so nothing
 *   leaves it until the person presses "Upload copy & create link": a copy
 *   goes to Cloud storage → Shared/, and the link is to that copy. "Update
 *   copy" uploads it again under the same name — the link stays the same.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useMutation } from "@tanstack/react-query";
import {
  CheckIcon,
  CloudUploadIcon,
  CopyIcon,
  LinkIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { filesApi } from "../files/filesApi";
import { canShareForEditing } from "../files/ShareDialog";
import { shareUrl, useShareBaseUrl } from "../files/useShareBaseUrl";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverPopup } from "../ui/popover";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { type FileShareRoute, SHARED_COPIES_PREFIX, sharedCopyKey } from "./fileShare.logic";

const DURATIONS = [
  { id: "1d", label: "1 day", hours: 24 },
  { id: "7d", label: "7 days", hours: 24 * 7 },
  { id: "30d", label: "30 days", hours: 24 * 30 },
] as const;
type DurationId = (typeof DURATIONS)[number]["id"];

/** Upload a copy of the file into Cloud storage → Shared/; the key of the copy. */
async function uploadSharedCopy(environmentId: EnvironmentId, path: string, name: string) {
  const api = filesApi(environmentId);
  const drive = await api.driveState();
  if (!drive.available || drive.bucketId === null) {
    throw new Error(drive.message ?? "Cloud storage isn't available on this computer.");
  }
  await api.cloudCopyToCloud({
    paths: [path],
    bucketId: drive.bucketId,
    prefix: SHARED_COPIES_PREFIX,
  });
  return sharedCopyKey(name);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

export function FileSharePopover({
  open,
  onOpenChange,
  anchor,
  environmentId,
  path,
  name,
  route: preferredRoute,
  computerName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The ↗ button the popover hangs from. */
  anchor: Element | null;
  environmentId: EnvironmentId | null;
  path: string;
  name: string;
  route: FileShareRoute;
  /** "uno-product", "this Mac"… — said in the explanation. */
  computerName: string;
}) {
  const base = useShareBaseUrl(preferredRoute === "computer-link" ? environmentId : null);
  // A computer whose links can't open from the internet shares a copy instead.
  const [routeOverride, setRouteOverride] = useState<FileShareRoute | null>(null);
  const route: FileShareRoute =
    routeOverride ??
    (preferredRoute === "computer-link" && !base.isPublic ? "cloud-copy" : preferredRoute);
  const [duration, setDuration] = useState<DurationId>("7d");
  const [withPassword, setWithPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [canEdit, setCanEdit] = useState(false);
  const [copied, setCopied] = useState(false);
  const [phase, setPhase] = useState<"idle" | "uploading" | "linking">("idle");
  const editable = route === "computer-link" && canShareForEditing(name);
  const hours = DURATIONS.find((option) => option.id === duration)!.hours;

  useEffect(() => {
    if (!open) return;
    setRouteOverride(null);
    setDuration("7d");
    setWithPassword(false);
    setPassword("");
    setCanEdit(false);
    setCopied(false);
    create.reset();
    update.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a fresh popover each time it opens
  }, [open, path]);

  const create = useMutation({
    mutationFn: async (): Promise<string> => {
      if (!environmentId) throw new Error("This computer isn't connected.");
      const api = filesApi(environmentId);
      if (route === "cloud-copy") {
        setPhase("uploading");
        const key = await uploadSharedCopy(environmentId, path, name);
        setPhase("linking");
        const share = await api.driveShareCreate({ key, expiresInHours: hours });
        if (!share.url) throw new Error("Couldn't make a link.");
        return share.url;
      }
      setPhase("linking");
      const share = await api.createShare({
        path,
        expiresInSeconds: hours * 3600,
        password: withPassword ? password : null,
        ...(editable ? { access: canEdit ? "edit" : "view" } : {}),
      });
      const url = shareUrl(base, share.urlPath);
      if (!url) throw new Error("This computer's public address isn't known yet.");
      return url;
    },
    onSettled: () => setPhase("idle"),
  });

  const update = useMutation({
    mutationFn: async () => {
      if (!environmentId) throw new Error("This computer isn't connected.");
      await uploadSharedCopy(environmentId, path, name);
    },
  });

  const url = create.data ?? null;
  const copy = async () => {
    if (!url) return;
    await navigator.clipboard.writeText(url).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const passwordTooShort = withPassword && password.length < 4;
  const passwordAvailable = route === "computer-link";

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverPopup
        anchor={anchor}
        side="bottom"
        align="end"
        className="w-80"
        data-testid="file-share-popover"
      >
        <div className="flex flex-col gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <LinkIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium">Share “{name}”</span>
          </div>
          <p className={cn("text-xs leading-snug text-muted-foreground", url && "hidden")}>
            {route === "cloud-copy"
              ? `${computerName} can't be reached from the internet, so Uno puts a copy in Cloud storage → ${SHARED_COPIES_PREFIX} and links to it. Nothing is uploaded until you press the button.`
              : `The link opens this file on ${computerName}. If it's asleep, it wakes up for the visitor — the first open takes a few seconds.`}
          </p>

          {url ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <Input
                  readOnly
                  value={url}
                  aria-label="Link"
                  size="sm"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button size="sm" onClick={() => void copy()}>
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              {route === "cloud-copy" ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="min-w-0 flex-1">
                    A copy as of now. Changed the file? Update the copy — the link stays the same.
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={update.isPending}
                    onClick={() => update.mutate()}
                  >
                    {update.isPending ? (
                      <Loader2Icon className="animate-spin" />
                    ) : update.isSuccess ? (
                      <CheckIcon />
                    ) : (
                      <RefreshCwIcon />
                    )}
                    {update.isSuccess ? "Updated" : "Update copy"}
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Turn it off any time in Files → Shared links.
                </p>
              )}
            </div>
          ) : (
            <>
              {editable ? (
                <Field label="People with the link">
                  <ToggleGroup
                    variant="outline"
                    size="xs"
                    value={[canEdit ? "edit" : "view"]}
                    onValueChange={(value) => setCanEdit(value[0] === "edit")}
                  >
                    <Toggle value="view" className="px-2.5">
                      Can view
                    </Toggle>
                    <Toggle value="edit" className="px-2.5">
                      Can edit
                    </Toggle>
                  </ToggleGroup>
                </Field>
              ) : null}
              <Field label="Link works for">
                <ToggleGroup
                  variant="outline"
                  size="xs"
                  value={[duration]}
                  onValueChange={(value) => {
                    const next = DURATIONS.find((option) => option.id === value[0]);
                    if (next) setDuration(next.id);
                  }}
                >
                  {DURATIONS.map((option) => (
                    <Toggle key={option.id} value={option.id} className="px-2.5">
                      {option.label}
                    </Toggle>
                  ))}
                </ToggleGroup>
              </Field>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="file-share-password"
                    checked={passwordAvailable && withPassword}
                    disabled={!passwordAvailable}
                    onCheckedChange={(checked) => setWithPassword(checked === true)}
                  />
                  <Label
                    htmlFor="file-share-password"
                    className={cn("text-xs", !passwordAvailable && "text-muted-foreground")}
                  >
                    Require a password
                  </Label>
                  {passwordAvailable ? null : (
                    <span className="text-[11px] text-muted-foreground">
                      · not for Cloud storage links yet
                    </span>
                  )}
                </div>
                {passwordAvailable && withPassword ? (
                  <Input
                    size="sm"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="At least 4 characters"
                    autoComplete="off"
                    aria-label="Link password"
                  />
                ) : null}
              </div>
              {phase === "uploading" ? (
                <div
                  role="status"
                  data-testid="file-share-uploading"
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <CloudUploadIcon className="size-3.5 shrink-0 text-sky-500" />
                  <span className="min-w-0 flex-1 truncate">
                    Uploading to Cloud storage → {SHARED_COPIES_PREFIX}
                  </span>
                  <span className="relative h-1 w-14 shrink-0 overflow-hidden rounded-full bg-muted">
                    <span className="absolute inset-y-0 left-0 w-1/2 animate-pulse rounded-full bg-sky-500" />
                  </span>
                </div>
              ) : null}
              {create.error ? (
                <p className="text-xs text-destructive">{errorText(create.error)}</p>
              ) : null}
              <Button
                size="sm"
                disabled={create.isPending || passwordTooShort}
                onClick={() => create.mutate()}
                data-testid="file-share-create"
              >
                {create.isPending ? (
                  <Loader2Icon className="animate-spin" />
                ) : route === "cloud-copy" ? (
                  <CloudUploadIcon />
                ) : (
                  <LinkIcon />
                )}
                {route === "cloud-copy" ? "Upload copy & create link" : "Create link"}
              </Button>
              {preferredRoute === "computer-link" && base.isPublic ? (
                <button
                  type="button"
                  onClick={() => setRouteOverride(route === "cloud-copy" ? null : "cloud-copy")}
                  className="self-start text-left text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {route === "cloud-copy"
                    ? "Link to the file on the computer instead"
                    : "Turning the computer off? Share a Cloud storage copy"}
                </button>
              ) : null}
            </>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
