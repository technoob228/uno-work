/**
 * The one computer menu's actions (Misha 02.11, SPEC "Удаление"): for the
 * person's own computer — what it is for, "Remove computer", and (variant a)
 * "Advanced → Run agents on this computer itself"; for a cloud computer —
 * "Delete computer" (type its name; the plan's last computer can only be
 * turned off). Replaces the two removals there were (the helper's Manage card
 * and Settings → My machines); those stay in Dev Mode.
 */
import type { EnvironmentId, MyComputer } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, LaptopIcon, Loader2Icon, WrenchIcon } from "lucide-react";
import { useState } from "react";

import { lifecycleBackend } from "../../computersLifecycle/backend";
import { type ComputerPurpose, lifecycle, useLifecycle } from "../../computersLifecycle/store";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { removeSavedEnvironment } from "../../environments/runtime";
import { cn } from "../../lib/utils";
import { workspaceQueryKeys } from "../../lib/workspaceReactQuery";
import { useImportStatus } from "../../localComputer/useChatImport";
import { disconnectComputer, useRefreshMyComputers } from "../../localComputer/useMyComputers";
import { selectEnvironmentState, useStore } from "../../store";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";

/** Chats that ran on a computer (not archived): they stay after it goes. */
function useChatsOn(environmentId: string | null): number {
  return useStore((state) => {
    if (environmentId === null) return 0;
    const env = selectEnvironmentState(state, environmentId as EnvironmentId);
    return env.threadIds.filter((id) => !env.sidebarThreadSummaryById[id]?.archivedAt).length;
  });
}

function chatsLine(count: number, name: string): string | null {
  if (count === 0) return null;
  return `${count} ${count === 1 ? "chat" : "chats"} ran on ${name} — they stay, read-only until you continue them in the cloud.`;
}

function Bullets({ lines }: { lines: ReadonlyArray<string | null> }) {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
      {lines.filter(Boolean).map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

// ── Remove (own computer) ───────────────────────────────────────────────

export function RemoveComputerDialog({
  open,
  onOpenChange,
  name,
  computerId,
  environmentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  computerId: string | null;
  environmentId: string | null;
}) {
  const primaryId = usePrimaryEnvironmentId();
  const refresh = useRefreshMyComputers();
  const navigate = useNavigate();
  const ranHere = useChatsOn(environmentId);
  const imported = useImportStatus(primaryId, computerId).data?.importedChats ?? 0;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setPending(true);
    setError(null);
    try {
      if (computerId !== null) {
        const failure = await disconnectComputer(primaryId, computerId);
        if (failure !== null) throw new Error(failure);
        await lifecycleBackend.removeComputer(computerId);
        lifecycle.forget(computerId);
      }
      if (environmentId !== null) {
        await removeSavedEnvironment(environmentId as EnvironmentId);
      }
      await refresh();
      onOpenChange(false);
      void navigate({ to: "/computer" } as never);
      toastManager.add({ type: "success", title: `${name} removed` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t remove it. Try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md" data-testid="lc-remove-dialog">
        <DialogHeader>
          <DialogTitle className="text-lg">Remove {name}?</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <Bullets
            lines={[
              "Agents lose access right away.",
              `Uno’s helper removes itself. Your files on ${name} stay.`,
              "Chats and synced projects stay on your other computers.",
              chatsLine(ranHere + imported, name),
            ]}
          />
          {error !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => void remove()}
            data-testid="lc-remove-confirm"
          >
            {pending ? "Removing…" : "Remove computer"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ── Delete (cloud computer) ─────────────────────────────────────────────

export function DeleteComputerDialog({
  open,
  onOpenChange,
  name,
  boxId,
  environmentId,
  lastOnPlan,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  boxId: number | null;
  environmentId: string | null;
  lastOnPlan: boolean;
}) {
  const queryClient = useQueryClient();
  const ranHere = useChatsOn(environmentId);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contents = lifecycleBackend.cloudContents(boxId);
  const close = (next: boolean) => {
    if (!next) {
      setTyped("");
      setError(null);
    }
    onOpenChange(next);
  };
  const run = async (what: "delete" | "sleep") => {
    if (boxId === null) return;
    setPending(true);
    setError(null);
    try {
      if (what === "delete") {
        await lifecycleBackend.deleteBox(boxId);
        if (environmentId !== null) await removeSavedEnvironment(environmentId as EnvironmentId);
      } else {
        await lifecycleBackend.sleepBox(boxId);
      }
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all });
      close(false);
      toastManager.add({
        type: "success",
        title: what === "delete" ? `${name} deleted` : `${name} is turning off`,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Uno didn’t answer. Try again.");
    } finally {
      setPending(false);
    }
  };

  if (lastOnPlan) {
    return (
      <Dialog open={open} onOpenChange={close}>
        <DialogPopup className="max-w-md" data-testid="lc-delete-last">
          <DialogHeader>
            <DialogTitle className="text-lg">{name} is your plan’s last computer</DialogTitle>
            <DialogDescription>
              It can be turned off, not deleted. Files and apps on it stay.
            </DialogDescription>
          </DialogHeader>
          {error !== null ? (
            <DialogPanel>
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            </DialogPanel>
          ) : null}
          <DialogFooter variant="bare">
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void run("sleep")}
              data-testid="lc-delete-turn-off"
            >
              Turn off
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    );
  }

  const lost = [
    "Files outside synced projects",
    contents && contents.apps.length > 0
      ? `Apps: ${contents.apps.join(", ")}`
      : contents
        ? null
        : "Apps on it",
    contents && contents.sites.length > 0
      ? `Sites: ${contents.sites.join(", ")}`
      : contents
        ? null
        : "Sites on it",
  ];
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogPopup className="max-w-md" data-testid="lc-delete-dialog">
        <DialogHeader>
          <DialogTitle className="text-lg">Delete {name}?</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Lost for good</p>
            <Bullets lines={lost} />
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Stays</p>
            <Bullets lines={["Synced projects and keys", chatsLine(ranHere, name)]} />
          </div>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">
              Type <span className="font-mono text-foreground">{name}</span> to delete
            </span>
            <Input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={name}
              aria-label="Computer name"
              data-testid="lc-delete-name"
            />
          </label>
          {error !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending || typed.trim() !== name}
            onClick={() => void run("delete")}
            data-testid="lc-delete-confirm"
          >
            {pending ? "Deleting…" : "Delete computer"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ── In the computer's row ───────────────────────────────────────────────

const PURPOSE_LABEL: Record<ComputerPurpose, string> = {
  tool: "Tool for agents",
  full: "Full computer",
};

function PurposeSwitch({ computerId }: { computerId: string }) {
  const purpose = useLifecycle((state) => state.purposes[computerId] ?? "tool");
  const [busy, setBusy] = useState<ComputerPurpose | null>(null);
  const pick = async (next: ComputerPurpose) => {
    if (next === purpose || busy) return;
    setBusy(next);
    try {
      if (next === "full") {
        lifecycle.linkEnvironment(computerId, await lifecycleBackend.makeFull(computerId));
      } else {
        await lifecycleBackend.makeTool(computerId);
        lifecycle.linkEnvironment(computerId, null);
      }
      lifecycle.setPurpose(computerId, next);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex items-center gap-2 text-xs" data-testid="lc-purpose-switch">
      <span className="text-muted-foreground">Used as</span>
      <div className="flex rounded-md border border-border p-0.5">
        {(["tool", "full"] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => void pick(id)}
            aria-pressed={purpose === id}
            data-testid={`lc-purpose-switch-${id}`}
            className={cn(
              "flex items-center gap-1 rounded px-2 py-0.5 transition-colors",
              purpose === id
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {busy === id ? <Loader2Icon className="size-3 animate-spin" /> : null}
            {PURPOSE_LABEL[id]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Variant (a) of the secondary path: in the computer's menu, under Advanced. */
function RunHereAdvanced({ computerId, name }: { computerId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const on = useLifecycle((state) => state.runsHere[computerId] === true);
  return (
    <div className="flex flex-col gap-1.5" data-testid="lc-advanced">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        data-testid="lc-advanced-toggle"
        className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
        Advanced
      </button>
      {open ? (
        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 p-2.5">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-xs font-medium">Run agents on this computer itself</span>
            <span className="text-[11px] text-muted-foreground">
              Works offline and with {name}’s own AI plans.
            </span>
          </span>
          <Switch
            checked={on}
            onCheckedChange={(value) => lifecycle.setRunsHere(computerId, value)}
            data-testid="lc-run-here"
          />
        </label>
      ) : null}
    </div>
  );
}

/** Own computer: what it is for, Advanced (variant a), Remove. */
export function OwnComputerActions({
  computerId,
  environmentId,
  name,
  onBeforeDialog,
}: {
  computerId: string | null;
  environmentId: string | null;
  name: string;
  onBeforeDialog?: () => void;
}) {
  const fallback = useLifecycle((state) => state.fallback);
  const runsHere = useLifecycle((state) =>
    computerId === null ? false : state.runsHere[computerId] === true,
  );
  return (
    <div className="flex flex-col gap-2.5" data-testid="lc-own-actions">
      {computerId !== null ? <PurposeSwitch computerId={computerId} /> : null}
      {runsHere ? (
        <p className="text-[11px] text-muted-foreground" data-testid="lc-runs-here-line">
          Agents run on {name} itself.
        </p>
      ) : null}
      {computerId !== null && fallback === "a" ? (
        <RunHereAdvanced computerId={computerId} name={name} />
      ) : null}
      <button
        type="button"
        onClick={() => {
          onBeforeDialog?.();
          lifecycle.confirm({ kind: "remove", name, computerId, environmentId });
        }}
        data-testid="lc-remove"
        className="self-start text-xs text-destructive/90 underline-offset-2 hover:text-destructive hover:underline"
      >
        Remove computer
      </button>
    </div>
  );
}

/** Cloud computer: Delete (or, for the plan's last one, Turn off). */
export function CloudComputerActions({
  boxId,
  environmentId,
  name,
  lastOnPlan,
  onBeforeDialog,
}: {
  boxId: number | null;
  environmentId: string | null;
  name: string;
  lastOnPlan: boolean;
  onBeforeDialog?: () => void;
}) {
  if (boxId === null) return null;
  return (
    <button
      type="button"
      onClick={() => {
        onBeforeDialog?.();
        lifecycle.confirm({ kind: "delete", name, boxId, environmentId, lastOnPlan });
      }}
      data-testid="lc-delete"
      className="self-start text-xs text-destructive/90 underline-offset-2 hover:text-destructive hover:underline"
    >
      Delete computer
    </button>
  );
}

/** The open confirmation, if any (mounted once, in the root). */
export function LifecycleConfirmDialogs() {
  const confirm = useLifecycle((state) => state.confirm);
  const close = (open: boolean) => {
    if (!open) lifecycle.confirm(null);
  };
  if (confirm === null) return null;
  return confirm.kind === "remove" ? (
    <RemoveComputerDialog
      open
      onOpenChange={close}
      name={confirm.name}
      computerId={confirm.computerId}
      environmentId={confirm.environmentId}
    />
  ) : (
    <DeleteComputerDialog
      open
      onOpenChange={close}
      name={confirm.name}
      boxId={confirm.boxId}
      environmentId={confirm.environmentId}
      lastOnPlan={confirm.lastOnPlan}
    />
  );
}

/** A tool-mode computer in the computers menu: not a place for chats, so not a computer of its own. */
export function ToolComputerRow({
  computer,
  open,
  onToggle,
  onClose,
}: {
  computer: MyComputer;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const runsHere = useLifecycle((state) => state.runsHere[computer.id] === true);
  return (
    <li className="list-none" data-testid="lc-tool-row">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/60",
          open && "bg-accent/40",
        )}
      >
        <span className="relative mt-0.5">
          <LaptopIcon className="size-4 text-muted-foreground" />
          <span
            className={cn(
              "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-popover",
              computer.online ? "bg-success" : "bg-muted-foreground/50",
            )}
            aria-hidden
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{computer.name}</span>
          <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
            <WrenchIcon className="size-3 shrink-0" />
            {runsHere ? "Agents run here" : "Tool for your agents"}
            {computer.online ? "" : " · asleep"}
          </span>
        </span>
        <ChevronRightIcon
          className={cn(
            "mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open ? (
        <div className="mb-1 ml-8 flex flex-col gap-2.5 border-l border-border/60 py-1 pr-2 pl-3">
          <OwnComputerActions
            computerId={computer.id}
            environmentId={null}
            name={computer.name}
            onBeforeDialog={onClose}
          />
        </div>
      ) : null}
    </li>
  );
}
