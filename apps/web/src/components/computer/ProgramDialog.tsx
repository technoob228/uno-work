/**
 * One program, up close: what it is, whether it runs, where it answers, and
 * the few things a person does with it — Open, Show on the internet / Hide,
 * Start / Stop, Remove (or, for a program the computer found by itself, Hide
 * from the home screen). "Show on the internet" is the only way a port gets
 * published, and it says plainly what it does before it does it. App Store
 * apps also carry how to sign in and, when they have their own AI key, what it
 * spent and its limit.
 */
import type {
  UnoComputerAppAccess,
  UnoComputerAppAiKey,
  UnoComputerAppCredential,
  UnoComputerInstalledApp,
  UnoMachineAppAction,
  UnoMachineApps,
} from "@t3tools/contracts";
import {
  CirclePlayIcon,
  CircleStopIcon,
  LoaderIcon,
  MoonIcon,
  WrenchIcon,
  EyeIcon,
  ExternalLinkIcon,
  EyeOffIcon,
  GlobeIcon,
  LayoutGridIcon,
  KeyRoundIcon,
  SparklesIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
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
import { Spinner } from "../ui/spinner";
import { appPrimaryAction, type AppPrimaryAction } from "./appPrimaryAction";
import { displayAddress } from "./computerFormat";
import { ProgramIcon } from "./ComputerPrograms";
import { CopyButton } from "./computerUi";
import {
  canHideProgram,
  programRemoval,
  type ProgramRemoval,
  type ProgramTile,
  type RemovalCloudFiles,
} from "./programModel";
import { RemoveProgramDialog } from "./RemoveProgramDialog";

const STATUS_WORD: Record<ProgramTile["status"], string> = {
  running: "Running",
  stopped: "Stopped",
  installing: "Installing…",
  failed: "Didn't start",
  asleep: "Asleep with the computer",
  unknown: "Status unknown",
};

function AddressRow({
  label,
  url,
  onOpen,
}: {
  label: string;
  url: string;
  /** Open differently (already signed in with Uno) instead of a plain link. */
  onOpen?: (() => void) | undefined;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-xl bg-muted/40 py-1.5 pr-1.5 pl-3">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="truncate font-mono text-xs" title={url}>
          {displayAddress(url)}
        </div>
      </div>
      <CopyButton value={url} label={label.toLowerCase()} />
      {onOpen ? (
        <Button size="xs" variant="outline" onClick={onOpen}>
          <ExternalLinkIcon />
          Open
        </Button>
      ) : (
        <Button
          size="xs"
          variant="outline"
          render={<a href={url} target="_blank" rel="noopener noreferrer" />}
        >
          <ExternalLinkIcon />
          Open
        </Button>
      )}
    </div>
  );
}

/**
 * How to sign in to an App Store app: the login, the password Uno generated at
 * install, an invite link for other people. Only the owner sees this (the
 * console answers it for this computer only). Secrets stay hidden until "Show".
 */
function SignInBlock({
  credentials,
  notes,
  sso,
}: {
  credentials: ReadonlyArray<UnoComputerAppCredential>;
  notes: string | null;
  sso: UnoComputerInstalledApp["sso"];
}) {
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  if (credentials.length === 0 && !notes && !sso) return null;
  return (
    <section
      className="flex flex-col gap-2 rounded-xl border border-border/60 p-3"
      aria-label="How to sign in"
    >
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <KeyRoundIcon className="size-3.5 text-muted-foreground" />
        How to sign in
      </div>
      {sso === "oidc" ? (
        <p className="text-xs leading-relaxed" data-sso="oidc">
          <span className="font-medium">With your Uno account.</span>{" "}
          <span className="text-muted-foreground">
            Open signs you in — no password to type.
            {credentials.length > 0 ? " The password below is a spare way in." : ""}
          </span>
        </p>
      ) : sso === "edge" ? (
        <p className="text-xs leading-relaxed" data-sso="edge">
          <span className="font-medium">Only you and people you share it with can reach it.</span>{" "}
          <span className="text-muted-foreground">
            Its address asks for the Uno account first, then the app's own sign-in.
          </span>
        </p>
      ) : null}
      {credentials.map((c, index) => {
        const visible = !c.secret || shown.has(c.label);
        // Uno only knows the password it generated: say so under the first one.
        const passwordNote =
          c.secret && !c.link && credentials.findIndex((x) => x.secret && !x.link) === index;
        return (
          <div key={c.label} className="flex flex-col gap-1">
            <div
              className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/40 py-1 pr-1 pl-2.5"
              data-credential={c.label}
            >
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-muted-foreground">{c.label}</div>
                <div className="truncate font-mono text-xs" title={visible ? c.value : undefined}>
                  {visible ? c.value : "•".repeat(12)}
                </div>
              </div>
              {c.secret ? (
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={visible ? `Hide ${c.label}` : `Show ${c.label}`}
                  onClick={() =>
                    setShown((prev) => {
                      const next = new Set(prev);
                      if (next.has(c.label)) next.delete(c.label);
                      else next.add(c.label);
                      return next;
                    })
                  }
                >
                  {visible ? <EyeOffIcon /> : <EyeIcon />}
                  {visible ? "Hide" : "Show"}
                </Button>
              ) : null}
              <CopyButton value={c.value} label={c.label.toLowerCase()} />
              {c.link ? (
                <Button
                  size="xs"
                  variant="outline"
                  render={<a href={c.value} target="_blank" rel="noopener noreferrer" />}
                >
                  <ExternalLinkIcon />
                  Open
                </Button>
              ) : null}
            </div>
            {passwordNote ? (
              <p className="pl-2.5 text-[11px] text-muted-foreground">
                If you changed the password inside the app, use your new one.
              </p>
            ) : null}
          </div>
        );
      })}
      {notes ? <p className="text-xs leading-relaxed text-muted-foreground">{notes}</p> : null}
    </section>
  );
}

/**
 * «Share app»: people (their Uno accounts) who can sign in to this app. They
 * sign in with their own Uno account — no passwords to hand over; everyone
 * else is refused. Only for apps that sign in with Uno.
 */
function ShareBlock({
  deploymentId,
  sso,
  sharedWith,
  controls,
}: {
  deploymentId: number;
  sso: "oidc" | "edge";
  sharedWith: number | null;
  controls: ProgramSignInControls;
}) {
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState<UnoComputerAppAccess | null>(null);
  const [login, setLogin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The parent re-creates `controls` on every poll; the list is read once per opening.
  const controlsRef = useRef(controls);
  controlsRef.current = controls;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    controlsRef.current
      .access(deploymentId)
      .then((a) => alive && setAccess(a))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [open, deploymentId]);

  const run = (p: Promise<UnoComputerAppAccess>, after?: () => void) => {
    setBusy(true);
    setError(null);
    p.then((a) => {
      setAccess(a);
      after?.();
    })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const count = access?.people.length ?? sharedWith ?? 0;
  return (
    <section
      className="flex flex-col gap-2 rounded-xl border border-border/60 p-3"
      aria-label="Share app"
    >
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <UsersIcon className="size-3.5 text-muted-foreground" />
        <span className="flex-1">
          {count > 0 ? `Shared with ${count} ${count === 1 ? "person" : "people"}` : "Only you"}
        </span>
        {!open ? (
          <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
            <UserPlusIcon />
            Share app
          </Button>
        ) : null}
      </div>
      {open ? (
        <>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {sso === "oidc"
              ? "They sign in with their own Uno account and get their own space in the app. Nobody else can sign in."
              : "They sign in with their own Uno account to reach it, then use the app's own sign-in. Nobody else can reach it."}
          </p>
          {access && !access.ready ? (
            <p className="text-[11px] text-warning-foreground">
              This app was installed before Sign in with Uno. Remove it (keep the data) and install
              it again to share it.
            </p>
          ) : null}
          {access?.people.map((p) => (
            <div
              key={p.userId}
              className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/40 py-1 pr-1 pl-2.5"
              data-person={p.email ?? p.name}
            >
              <span className="min-w-0 flex-1 truncate text-xs">{p.email ?? p.name}</span>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                aria-label={`Stop sharing with ${p.email ?? p.name}`}
                onClick={() => run(controls.unshare(deploymentId, p.userId))}
              >
                <XIcon />
              </Button>
            </div>
          ))}
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!login.trim()) return;
              run(controls.share(deploymentId, login.trim()), () => setLogin(""));
            }}
          >
            <Input
              type="email"
              value={login}
              placeholder="Their Uno account email"
              aria-label="Email of their Uno account"
              onChange={(e) => setLogin(e.target.value)}
              disabled={busy}
            />
            <Button type="submit" size="sm" disabled={busy || !login.trim()}>
              {busy ? <Spinner /> : null}
              Share
            </Button>
          </form>
          {error ? (
            <p className="text-xs text-destructive-foreground" role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function money(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

/**
 * What the app's own AI key spent, against its limit, and a small way to change
 * the limit or turn it off.
 */
function AiSpendingBlock({
  aiKey,
  pending,
  error,
  onSave,
}: {
  aiKey: UnoComputerAppAiKey;
  pending: boolean;
  error: string | null;
  onSave: (limitUsd: number | null) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const parsed = Number(draft.replace(",", ".").replace(/^\$/, ""));
  const valid = draft.trim().length > 0 && Number.isFinite(parsed) && parsed >= 0;
  const save = (limit: number | null) => {
    void onSave(limit).then(
      () => setEditing(false),
      () => undefined,
    );
  };
  return (
    <section
      className="flex flex-col gap-2 rounded-xl border border-border/60 p-3"
      aria-label="AI spending"
    >
      <div className="flex items-center gap-2 text-xs">
        <SparklesIcon className="size-3.5 text-muted-foreground" />
        <span className="flex-1">
          AI spending: <span className="font-medium">{money(aiKey.spentUsd)}</span>
          {aiKey.limitUsd !== null ? (
            <> of {money(aiKey.limitUsd)} limit</>
          ) : (
            <span className="text-muted-foreground"> · no limit</span>
          )}
        </span>
        {!editing ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setDraft(aiKey.limitUsd !== null ? String(aiKey.limitUsd) : "");
              setEditing(true);
            }}
          >
            Change limit
          </Button>
        ) : null}
      </div>
      {editing ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) save(Math.round(parsed * 100) / 100);
          }}
        >
          <span className="text-xs text-muted-foreground">$</span>
          <Input
            size="sm"
            className="w-24"
            type="number"
            inputMode="decimal"
            min={0}
            step="1"
            aria-label="AI spending limit in dollars"
            value={draft}
            disabled={pending}
            onChange={(event) => setDraft(event.target.value)}
            autoFocus
          />
          <Button size="xs" type="submit" disabled={pending || !valid}>
            {pending ? <Spinner className="size-3" /> : null}
            Save
          </Button>
          <Button
            size="xs"
            variant="outline"
            type="button"
            disabled={pending || aiKey.limitUsd === null}
            onClick={() => save(null)}
          >
            No limit
          </Button>
          <Button
            size="xs"
            variant="ghost"
            type="button"
            disabled={pending}
            onClick={() => setEditing(false)}
          >
            Cancel
          </Button>
        </form>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

const PRIMARY_ICON: Record<AppPrimaryAction["kind"], typeof ExternalLinkIcon> = {
  open: ExternalLinkIcon,
  start: CirclePlayIcon,
  setup: SparklesIcon,
  fix: WrenchIcon,
  installing: LoaderIcon,
  asleep: MoonIcon,
};

/** The app's one obvious button, first on its card. */
function PrimaryActionButton({
  action,
  busy,
  onRun,
}: {
  action: AppPrimaryAction;
  busy: boolean;
  onRun: () => void;
}) {
  const Icon = PRIMARY_ICON[action.kind];
  return (
    <Button
      className="w-full"
      variant={action.kind === "fix" ? "destructive" : "default"}
      disabled={action.disabled || busy}
      onClick={onRun}
      data-testid="program-primary-button"
      data-action={action.kind}
    >
      {busy || action.kind === "installing" ? <Spinner className="size-3.5" /> : <Icon />}
      {busy && action.kind === "start" ? "Starting…" : action.label}
    </Button>
  );
}

export interface ProgramRemoveControls {
  readonly pending: boolean;
  readonly error: string | null;
  readonly onRemove: (
    removal: ProgramRemoval,
    deleteData: boolean,
    deleteCloudFiles: boolean,
    deleteCode: boolean,
  ) => void;
  /** The app's folder in the account's cloud, when Remove may also delete it. */
  readonly cloudFiles?: (removal: ProgramRemoval) => RemovalCloudFiles | null;
  /** Clears a previous error when the confirmation opens again. */
  readonly onReset: () => void;
}

/** Sign in with Uno on the card: Open already signed in, and Share app. */
export interface ProgramSignInControls {
  readonly open: (deploymentId: number, fallbackUrl: string | null) => void;
  readonly access: (deploymentId: number) => Promise<UnoComputerAppAccess>;
  readonly share: (deploymentId: number, login: string) => Promise<UnoComputerAppAccess>;
  readonly unshare: (deploymentId: number, userId: number) => Promise<UnoComputerAppAccess>;
}

export interface ProgramAiLimitControls {
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSave: (deploymentId: number, limitUsd: number | null) => Promise<unknown>;
}

export function ProgramDialog({
  tile,
  machineApps,
  browserOnMachine,
  pendingAction,
  actionError,
  onAction,
  onClose,
  remove,
  aiLimit,
  signIn,
  onPrimaryAction,
}: {
  /**
   * Runs the app's one primary action (Open / Start / Set up with Uno / Fix
   * with Uno) — the big button first on the card. Absent = no such button.
   */
  onPrimaryAction?: ((tile: ProgramTile) => void) | undefined;
  tile: ProgramTile | null;
  machineApps: UnoMachineApps | undefined;
  browserOnMachine: boolean;
  pendingAction: UnoMachineAppAction | null;
  actionError: string | null;
  onAction: (appId: string, action: UnoMachineAppAction) => void;
  onClose: () => void;
  remove: ProgramRemoveControls;
  aiLimit: ProgramAiLimitControls;
  signIn?: ProgramSignInControls | undefined;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const tileKey = tile?.key ?? null;
  // A confirmation never carries over to the next program opened.
  useEffect(() => setConfirmRemove(false), [tileKey]);
  const removal = tile ? programRemoval(tile) : null;
  const aiKey = tile?.storeApp?.aiKey ?? null;
  const aiDeploymentId = tile?.storeApp?.deploymentId ?? null;
  const store = tile?.storeApp ?? null;
  const sso = store?.sso ?? null;
  const storeUrl = store?.url ?? tile?.install?.url ?? null;
  const app = tile?.machineApp ?? null;
  const publication = app?.publication ?? null;
  const publishable =
    app !== null &&
    app.status === "running" &&
    (app.port !== null || app.udpPorts.length > 0) &&
    !app.loopbackOnly;
  const blocked = machineApps?.publishBlockedReason ?? null;
  const busy = pendingAction !== null || remove.pending;
  const primary = tile && onPrimaryAction ? appPrimaryAction(tile) : null;
  // The big button starts it; the row below keeps only the other things.
  const startIsPrimary = primary?.kind === "start" && primary.machineAppId !== null;
  const nonWebForwards = publication?.forwards.filter(
    (f) => f.protocol !== "tcp" || !app?.http || publication.url === null,
  );

  return (
    <Dialog
      open={tile !== null}
      onOpenChange={(open) => {
        if (open || remove.pending) return;
        setConfirmRemove(false);
        onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        {tile ? (
          <>
            <DialogHeader>
              <div className="flex items-center gap-4">
                <ProgramIcon
                  name={tile.name}
                  icon={tile.icon}
                  iconImage={tile.iconImage}
                  templateId={tile.templateId}
                />
                <div className="min-w-0">
                  <DialogTitle className="truncate">
                    {tile.name}
                    {tile.product ? (
                      <span className="ml-2 text-sm font-normal text-muted-foreground">
                        {tile.product}
                      </span>
                    ) : null}
                  </DialogTitle>
                  <DialogDescription className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        tile.status === "running"
                          ? "bg-success"
                          : tile.status === "failed"
                            ? "bg-destructive"
                            : "bg-muted-foreground/60",
                      )}
                      aria-hidden
                    />
                    {STATUS_WORD[tile.status]}
                    {app?.detail ? <span className="truncate">· {app.detail}</span> : null}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-3">
              {primary && onPrimaryAction ? (
                <PrimaryActionButton
                  action={primary}
                  busy={primary.kind === "start" && pendingAction === "start"}
                  onRun={() => onPrimaryAction(tile)}
                />
              ) : null}
              {app?.description ? (
                <p className="text-sm leading-relaxed text-muted-foreground">{app.description}</p>
              ) : null}

              {app?.url ? <AddressRow label="Its address" url={app.url} /> : null}
              {storeUrl ? (
                <AddressRow
                  label="On the internet"
                  url={storeUrl}
                  onOpen={
                    sso && signIn && store?.deploymentId != null && store.state === "running"
                      ? () => signIn.open(store.deploymentId!, storeUrl)
                      : undefined
                  }
                />
              ) : null}
              {publication?.url ? (
                <AddressRow label="On the internet" url={publication.url} />
              ) : null}
              {tile.storeApp ? (
                <SignInBlock
                  credentials={tile.storeApp.credentials ?? []}
                  notes={tile.storeApp.notes ?? null}
                  sso={sso}
                />
              ) : null}
              {sso && signIn && store?.deploymentId != null ? (
                <ShareBlock
                  deploymentId={store.deploymentId}
                  sso={sso}
                  sharedWith={store.sharedWith ?? null}
                  controls={signIn}
                />
              ) : null}
              {aiKey && aiDeploymentId !== null ? (
                <AiSpendingBlock
                  aiKey={aiKey}
                  pending={aiLimit.pending}
                  error={aiLimit.error}
                  onSave={(limit) => aiLimit.onSave(aiDeploymentId, limit)}
                />
              ) : null}
              {nonWebForwards && nonWebForwards.length > 0 && publication?.host ? (
                <div className="rounded-xl bg-muted/40 px-3 py-2 text-xs">
                  <div className="text-[11px] text-muted-foreground">
                    Connect from outside with the app's own client
                  </div>
                  <ul className="mt-1 flex flex-col gap-0.5 font-mono">
                    {nonWebForwards.map((f) => (
                      <li key={f.forwardId}>
                        {publication.host}:{f.externalPort ?? "…"}{" "}
                        <span className="text-muted-foreground">
                          ({f.protocol.toUpperCase()}, port {f.internalPort} inside)
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {app?.localUrl && browserOnMachine && app.status === "running" ? (
                <AddressRow label="On this computer" url={app.localUrl} />
              ) : app && app.port !== null && app.status === "running" && !publication ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  It answers on port {app.port} inside this computer. To open it from anywhere —
                  this browser, your phone, a friend — show it on the internet.
                </p>
              ) : null}

              {app?.loopbackOnly && app.status === "running" ? (
                <p className="flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2 text-xs leading-relaxed">
                  <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  It only listens inside the computer (127.0.0.1), so it can't be shown on the
                  internet. Ask Uno to make it listen on all addresses (0.0.0.0).
                </p>
              ) : null}

              {app && !publication && publishable ? (
                blocked ? (
                  <p className="text-xs text-muted-foreground">{blocked}</p>
                ) : (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    <strong className="font-medium text-foreground">Show on the internet</strong>{" "}
                    gives it a public address. Anyone with the address can reach it, so do it for
                    things that have their own login or are meant to be public.
                  </p>
                )
              ) : null}

              {actionError ? (
                <p className="text-xs text-destructive" role="alert">
                  {actionError}
                </p>
              ) : null}

              {app ? (
                <div className="mt-1 flex flex-wrap gap-2">
                  {publication ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onAction(app.id, "unpublish")}
                    >
                      {pendingAction === "unpublish" ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <EyeOffIcon />
                      )}
                      Hide from the internet
                    </Button>
                  ) : publishable && !blocked ? (
                    <Button
                      size="sm"
                      variant={primary ? "outline" : "default"}
                      disabled={busy}
                      onClick={() => onAction(app.id, "publish")}
                    >
                      {pendingAction === "publish" ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <GlobeIcon />
                      )}
                      Show on the internet
                    </Button>
                  ) : null}
                  {app.canStop ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onAction(app.id, "stop")}
                    >
                      {pendingAction === "stop" ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <CircleStopIcon />
                      )}
                      Stop
                    </Button>
                  ) : null}
                  {app.canStart && !startIsPrimary ? (
                    <Button
                      size="sm"
                      variant={publication || primary ? "outline" : "default"}
                      disabled={busy}
                      onClick={() => onAction(app.id, "start")}
                    >
                      {pendingAction === "start" ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <CirclePlayIcon />
                      )}
                      Start
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {!removal && canHideProgram(app) && app ? (
                <div className="mt-1 flex items-center justify-between gap-3 border-t border-border/60 pt-3">
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Uno found it running here. Hiding takes it off the home screen only — it keeps
                    running, and you can show it again.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onAction(app.id, "hide")}
                  >
                    {pendingAction === "hide" ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <LayoutGridIcon />
                    )}
                    Hide from Home
                  </Button>
                </div>
              ) : null}
              {removal ? (
                <div className="mt-1 flex justify-end gap-2 border-t border-border/60 pt-3">
                  {canHideProgram(app) && app ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => onAction(app.id, "hide")}
                    >
                      {pendingAction === "hide" ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <LayoutGridIcon />
                      )}
                      Hide from Home
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    disabled={busy}
                    onClick={() => {
                      remove.onReset();
                      setConfirmRemove(true);
                    }}
                  >
                    {remove.pending ? <Spinner className="size-3.5" /> : <Trash2Icon />}
                    {remove.pending ? "Removing…" : "Remove"}
                  </Button>
                </div>
              ) : null}
              {app && !app.canStop && app.status === "running" && app.source === "systemd" ? (
                <p className="text-[11px] text-muted-foreground">
                  A system service: starting and stopping it needs an admin (the terminal with
                  sudo).
                </p>
              ) : null}
            </DialogPanel>
          </>
        ) : null}
      </DialogPopup>
      <RemoveProgramDialog
        open={confirmRemove}
        name={tile?.name ?? ""}
        removal={removal}
        cloudFiles={removal ? (remove.cloudFiles?.(removal) ?? null) : null}
        pending={remove.pending}
        error={remove.error}
        onOpenChange={setConfirmRemove}
        onConfirm={(deleteData, deleteCloudFiles, deleteCode) => {
          if (removal) remove.onRemove(removal, deleteData, deleteCloudFiles, deleteCode);
        }}
      />
    </Dialog>
  );
}
