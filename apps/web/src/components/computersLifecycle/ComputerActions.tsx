/**
 * The one computer menu's actions (Misha 02.11, SPEC "Удаление"): for the
 * person's own computer — what it is for and "Remove computer"; for a cloud
 * computer — "Delete computer" (type its name; the plan's last computer can
 * only be turned off). Replaces the two removals there were (the helper's
 * Manage card and Settings → My machines); those stay in Dev Mode.
 *
 * Remove is the existing `myComputer.disconnect`; what it is for is
 * `computers.setPurpose`; Delete goes to the console (`DELETE
 * /api/v1/boxes/{id}`, CONTRACT.md §4.2) — until the console allows it from
 * Work, the dialog points to the console instead.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, LaptopIcon, Loader2Icon, WrenchIcon } from "lucide-react";
import { useState } from "react";

import { fetchComputerApps } from "../../account/accountOverview";
import { AccountHttpError } from "../../account/unoAccount";
import { deleteRefusal, lifecycleBackend } from "../../computersLifecycle/backend";
import { type ComputerPurpose, lifecycle, useLifecycle } from "../../computersLifecycle/store";
import {
  errorText,
  type OwnComputer,
  useComputerPurpose,
  useComputersHostId,
  useRefreshComputersState,
  useSetComputerPurpose,
} from "../../computersLifecycle/useComputers";
import { removeSavedEnvironment } from "../../environments/runtime";
import { cn } from "../../lib/utils";
import { workspaceQueryKeys } from "../../lib/workspaceReactQuery";
import { useImportStatus } from "../../localComputer/useChatImport";
import { disconnectComputer, useRefreshMyComputers } from "../../localComputer/useMyComputers";
import { selectEnvironmentState, useStore } from "../../store";
import { StopAllAgentsDialog } from "../localComputer/StopAllAgents";
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
import { toastManager } from "../ui/toast";

/** Where a cloud computer is deleted while Work may not do it (CONTRACT.md §4.2). */

/** Chats on a cloud computer (not archived): they stay after it goes. */
function useChatsOnEnvironment(environmentId: string | null): number {
  return useStore((state) => {
    if (environmentId === null) return 0;
    const env = selectEnvironmentState(state, environmentId as EnvironmentId);
    return env.threadIds.filter((id) => !env.sidebarThreadSummaryById[id]?.archivedAt).length;
  });
}

/** Chats that ran on one of the person's own computers (its folders, on the cloud computer). */
function useChatsOnComputer(hostId: EnvironmentId | null, computerId: string): number {
  return useStore((state) => {
    if (hostId === null) return 0;
    const env = selectEnvironmentState(state, hostId);
    return env.threadIds.filter((id) => {
      const summary = env.sidebarThreadSummaryById[id];
      if (!summary || summary.archivedAt) return false;
      return env.projectById[summary.projectId]?.computer?.computerId === computerId;
    }).length;
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  computerId: string;
}) {
  const hostId = useComputersHostId();
  const refresh = useRefreshMyComputers();
  const refreshState = useRefreshComputersState();
  const navigate = useNavigate();
  const ranHere = useChatsOnComputer(hostId, computerId);
  const imported = useImportStatus(hostId, computerId).data?.importedChats ?? 0;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setPending(true);
    setError(null);
    try {
      const failure = await disconnectComputer(hostId, computerId);
      if (failure !== null) throw new Error(failure);
      await Promise.all([refresh(), refreshState()]);
      onOpenChange(false);
      void navigate({ to: "/computer" } as never);
      toastManager.add({ type: "success", title: `${name} removed` });
    } catch (cause) {
      setError(errorText(cause, "Couldn’t remove it. Try again."));
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
  boxId: number;
  environmentId: string | null;
  lastOnPlan: boolean;
}) {
  const queryClient = useQueryClient();
  const ranHere = useChatsOnEnvironment(environmentId);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The console may know better than the menu: it refuses the plan's last one.
  const [refused, setRefused] = useState<"last-on-plan" | null>(null);
  const apps = useQuery({
    queryKey: ["computers", "delete", "apps", boxId],
    queryFn: () => fetchComputerApps(boxId),
    enabled: open && !lastOnPlan,
    staleTime: 30_000,
    retry: false,
  });
  const close = (next: boolean) => {
    if (!next) {
      setTyped("");
      setError(null);
      setRefused(null);
    }
    onOpenChange(next);
  };
  const run = async (what: "delete" | "sleep") => {
    setPending(true);
    setError(null);
    try {
      if (what === "delete") {
        await lifecycleBackend.deleteBox(boxId);
        if (environmentId !== null) {
          await removeSavedEnvironment(environmentId as EnvironmentId).catch(() => undefined);
        }
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
      const refusal = what === "delete" ? deleteRefusal(cause) : null;
      if (refusal !== null) setRefused(refusal);
      // The console's answer is a code, not a sentence: say it plainly.
      else if (cause instanceof AccountHttpError) {
        setError(
          what === "delete"
            ? `Couldn’t delete ${name}. Try again.`
            : `Couldn’t turn off ${name}. Try again.`,
        );
      } else setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  if (lastOnPlan || refused === "last-on-plan") {
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

  const appNames = (apps.data ?? []).map((app) => app.name);
  const lost = [
    "Files outside synced projects",
    apps.isPending ? "Apps on it" : appNames.length > 0 ? `Apps: ${appNames.join(", ")}` : null,
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
            <Bullets lines={["Synced projects and keys", "Your sites", chatsLine(ranHere, name)]} />
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
  const purpose = useComputerPurpose(computerId) ?? "tool";
  const setPurpose = useSetComputerPurpose();
  const [busy, setBusy] = useState<ComputerPurpose | null>(null);
  const pick = async (next: ComputerPurpose) => {
    if (next === purpose || busy) return;
    setBusy(next);
    try {
      await setPurpose(computerId, next);
    } catch (cause) {
      toastManager.add({ type: "error", title: errorText(cause, "Couldn’t change it.") });
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

/** Own computer: what it is for, its agents' permissions, Stop all agents, Remove. */
export function OwnComputerActions({
  computer,
  onBeforeDialog,
}: {
  computer: Pick<OwnComputer, "id" | "name" | "trustsThisComputer">;
  onBeforeDialog?: () => void;
}) {
  return (
    <div className="flex flex-col gap-2.5" data-testid="lc-own-actions">
      <PurposeSwitch computerId={computer.id} />
      {computer.trustsThisComputer === false ? (
        <p className="text-[11px] text-muted-foreground" data-testid="lc-not-trusted">
          {computer.name} doesn’t trust this cloud computer yet — connect it again from here (same
          command).
        </p>
      ) : null}
      <Link
        to="/settings/my-computer"
        onClick={() => onBeforeDialog?.()}
        data-testid="lc-permissions"
        className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Agent permissions
      </Link>
      <button
        type="button"
        onClick={() => {
          onBeforeDialog?.();
          lifecycle.confirm({ kind: "stop-all" });
        }}
        data-testid="lc-stop-all"
        className="self-start text-xs text-destructive/90 underline-offset-2 hover:text-destructive hover:underline"
      >
        Stop all agents on my computer
      </button>
      <button
        type="button"
        onClick={() => {
          onBeforeDialog?.();
          lifecycle.confirm({ kind: "remove", name: computer.name, computerId: computer.id });
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
      {lastOnPlan ? "Turn off" : "Delete computer"}
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
  if (confirm.kind === "stop-all") return <StopAllAgentsDialog open onOpenChange={close} />;
  return confirm.kind === "remove" ? (
    <RemoveComputerDialog
      open
      onOpenChange={close}
      name={confirm.name}
      computerId={confirm.computerId}
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

/** One of the person's own computers in the computers menu: what it's for, Remove. */
export function OwnComputerRow({
  computer,
  open,
  onToggle,
  onClose,
}: {
  computer: OwnComputer;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const Icon = computer.purpose === "full" ? LaptopIcon : WrenchIcon;
  return (
    <li className="list-none" data-testid="lc-own-row">
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
            <Icon className="size-3 shrink-0" />
            {computer.purpose === "full" ? "Full computer" : "Tool for your agents"}
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
          <OwnComputerActions computer={computer} onBeforeDialog={onClose} />
        </div>
      ) : null}
    </li>
  );
}
