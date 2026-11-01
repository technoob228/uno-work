/**
 * "Connect my computer": warning → one command → connected, and the manage
 * card (what the agents did, Disconnect). When the install fails, the helper's
 * script reports what it can, the rest the person pastes in, and
 * `diagnoseInstall` gives the next step. The dialog keeps watching through all
 * of it: a command that works on the second try turns it by itself.
 *
 * What a computer sent (`message`, `step`) and the journal are plain text here.
 */
import type { EnvironmentId, MyComputer } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronRightIcon,
  LaptopIcon,
  LifeBuoyIcon,
  Loader2Icon,
  ShieldAlertIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { localComputer, useLocalComputer } from "../../localComputer/localComputerStore";
import { useImportActions, useImportStatus } from "../../localComputer/useChatImport";
import {
  disconnectComputer,
  requestPairing,
  STATUS_POLL_CARD_MS,
  STATUS_POLL_PAIRING_MS,
  useMyComputerActivity,
  useMyComputers,
  usePairStatus,
  useRefreshMyComputers,
} from "../../localComputer/useMyComputers";
import { formatShortTimestamp } from "../../timestampFormat";
import { CopyButton } from "../computer/computerUi";
import { STATUS_DOT_CLASS } from "../computerSwitcher/useComputerSwitcher";
import { Button } from "../ui/button";
import { hasOffer, importedLine } from "./chatImport.logic";
import {
  activityLine,
  activityTimeLabel,
  computerStatusLine,
  diagnoseInstall,
  disconnectNote,
  type InstallFix,
  LOCAL_OS,
  LOCAL_OS_ORDER,
  type LocalOs,
  pairProgress,
  stepLabel,
} from "./connectComputer.logic";
import { Heading, Shell } from "./ConnectShell";
import { ImportDialog, ImportOfferBody, ImportSearching } from "./ImportScreens";

function PairError() {
  const pairError = useLocalComputer((state) => state.pairError);
  if (pairError === null) return null;
  return (
    <p role="alert" className="text-sm text-destructive" data-testid="connect-pair-error">
      {pairError}
    </p>
  );
}

function Warning({ environmentId }: { environmentId: EnvironmentId | null }) {
  const requesting = useLocalComputer((state) => state.requesting);
  return (
    <Shell testId="connect-warning">
      <Heading
        icon={<ShieldAlertIcon className="size-4" />}
        title="Agent gets full access to this computer"
        tone="warning"
      />
      <p className="text-sm text-muted-foreground">
        It can read and change your files and run programs. Don’t connect a computer with crypto
        wallets or anything you can’t afford to lose.
      </p>
      <PairError />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={localComputer.close}>
          Cancel
        </Button>
        <Button
          disabled={requesting}
          onClick={() => void requestPairing(environmentId)}
          data-testid="connect-accept"
        >
          {requesting ? "Getting a command…" : "Connect computer"}
        </Button>
      </div>
    </Shell>
  );
}

function CommandBox({ command }: { command: string }) {
  return (
    <div
      className="flex items-center gap-2 rounded-xl border bg-muted/40 py-1.5 pr-1.5 pl-3"
      onClickCapture={localComputer.markCopied}
      data-testid="connect-copy"
    >
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={command}>
        {command}
      </code>
      <CopyButton value={command} label="command" />
    </div>
  );
}

function Waiting({
  stuck = false,
  finishing = false,
  unreachable = false,
}: {
  stuck?: boolean;
  finishing?: boolean;
  unreachable?: boolean;
}) {
  const copied = useLocalComputer((state) => state.copied);
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2Icon className="size-3.5 animate-spin" />
      <span aria-live="polite">
        {unreachable
          ? "Can’t check right now. Still trying…"
          : finishing
            ? "Finishing setup…"
            : "Waiting for your computer…"}
      </span>
      {stuck && copied ? (
        <button
          type="button"
          onClick={localComputer.stuck}
          data-testid="connect-stuck"
          className="ml-auto cursor-pointer text-foreground underline-offset-2 hover:underline"
        >
          Something wrong?
        </button>
      ) : null}
    </div>
  );
}

function HowToOpen({ os }: { os: LocalOs }) {
  const [open, setOpen] = useState(false);
  const info = LOCAL_OS[os];
  useEffect(() => setOpen(false), [os]);
  return (
    <div className="text-sm">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        data-testid="connect-howto"
        className="inline-flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        How to open {info.terminal}
      </button>
      {open ? (
        <div
          className="mt-2 flex flex-col gap-1 rounded-xl bg-muted/40 px-3 py-2"
          data-testid="connect-howto-text"
        >
          {info.howTo.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Command({ finishing, unreachable }: { finishing: boolean; unreachable: boolean }) {
  const os = useLocalComputer((state) => state.os);
  const phone = useLocalComputer((state) => state.phone);
  const pairing = useLocalComputer((state) => state.pairing);
  if (!pairing) return null;
  return (
    <Shell testId="connect-command" closeButton>
      <Heading
        icon={<LaptopIcon className="size-4" />}
        title={`Paste this into ${LOCAL_OS[os].terminal}`}
      />
      <div role="tablist" aria-label="Your system" className="flex gap-1.5">
        {LOCAL_OS_ORDER.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === os}
            onClick={() => localComputer.setOs(id)}
            data-testid={`connect-os-${id}`}
            className={cn(
              "cursor-pointer rounded-full border px-3 py-1 text-sm transition-colors",
              id === os
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:bg-muted/60",
            )}
          >
            {LOCAL_OS[id].label}
          </button>
        ))}
      </div>
      <HowToOpen os={os} />
      <CommandBox command={pairing.commands[os]} />
      {phone ? (
        <p className="text-sm text-muted-foreground" data-testid="connect-phone-note">
          Run it on the computer you want to connect, not on this device.
        </p>
      ) : os === "mac" ? (
        <p className="text-sm text-muted-foreground" data-testid="connect-mac-note">
          macOS may block the paste. Press Paste Anyway.
        </p>
      ) : null}
      <Waiting stuck finishing={finishing} unreachable={unreachable} />
    </Shell>
  );
}

function Stuck() {
  const os = useLocalComputer((state) => state.os);
  const pairing = useLocalComputer((state) => state.pairing);
  const [text, setText] = useState("");
  if (!pairing) return null;
  const next = () =>
    localComputer.showFix(
      diagnoseInstall({
        text,
        step: null,
        os,
        commands: pairing.commands,
        codeUsable: true,
      }),
    );
  return (
    <Shell testId="connect-stuck-card">
      <Heading icon={<LifeBuoyIcon className="size-4" />} title="What does the window show?" />
      <p className="text-sm text-muted-foreground">Paste it here to get the next step.</p>
      <textarea
        value={text}
        rows={4}
        aria-label="What the terminal shows"
        onChange={(event) => setText(event.target.value)}
        data-testid="connect-stuck-text"
        className="w-full resize-none rounded-xl border bg-muted/40 p-3 font-mono text-xs outline-none focus:border-primary"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={localComputer.backToCommand}>
          Back
        </Button>
        <Button disabled={!text.trim()} onClick={next} data-testid="connect-stuck-send">
          Get next step
        </Button>
      </div>
    </Shell>
  );
}

function NewCodeButton({ environmentId }: { environmentId: EnvironmentId | null }) {
  const requesting = useLocalComputer((state) => state.requesting);
  return (
    <Button
      disabled={requesting}
      onClick={() => void requestPairing(environmentId)}
      data-testid="connect-new-code"
    >
      {requesting ? "Getting a code…" : "Get new code"}
    </Button>
  );
}

function Fix({
  fix,
  step = null,
  message = null,
  pasted = false,
  environmentId,
  unreachable,
}: {
  fix: InstallFix;
  step?: string | null;
  message?: string | null;
  pasted?: boolean;
  environmentId: EnvironmentId | null;
  unreachable: boolean;
}) {
  const showsButtons = pasted || fix.next !== "run";
  return (
    <Shell testId="connect-fix" closeButton={!showsButtons}>
      <Heading
        icon={
          fix.tone === "warning" ? (
            <ShieldAlertIcon className="size-4" />
          ) : (
            <LifeBuoyIcon className="size-4" />
          )
        }
        title={fix.title}
        tone={fix.tone === "warning" ? "warning" : "primary"}
      />
      <p className="text-sm text-muted-foreground" data-testid="connect-fix-body">
        {fix.body}
      </p>
      {fix.steps.length > 0 ? (
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
          {fix.steps.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      ) : null}
      {step !== null ? (
        <p className="text-xs text-muted-foreground" data-testid="connect-failed-step">
          Stopped at: {stepLabel(step)}
        </p>
      ) : null}
      {message !== null && fix.showMessage ? (
        <pre
          className="max-h-24 overflow-y-auto rounded-xl bg-muted/40 px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap"
          data-testid="connect-failed-message"
        >
          {message}
        </pre>
      ) : null}
      {fix.command !== null ? <CommandBox command={fix.command} /> : null}
      {fix.next === "run" || fix.next === "wait" ? <Waiting unreachable={unreachable} /> : null}
      <PairError />
      {showsButtons ? (
        <div className="flex justify-end gap-2">
          {pasted ? (
            <Button variant="ghost" onClick={localComputer.backToCommand}>
              Back
            </Button>
          ) : (
            <Button variant="ghost" onClick={localComputer.close} data-testid="connect-close">
              Close
            </Button>
          )}
          {fix.next === "new-code" ? <NewCodeButton environmentId={environmentId} /> : null}
        </div>
      ) : null}
    </Shell>
  );
}

function Expired({ environmentId }: { environmentId: EnvironmentId | null }) {
  return (
    <Shell testId="connect-expired">
      <Heading
        icon={<ShieldAlertIcon className="size-4" />}
        title="This code expired"
        tone="warning"
      />
      <p className="text-sm text-muted-foreground">Codes work for 15 minutes.</p>
      <PairError />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={localComputer.close}>
          Cancel
        </Button>
        <NewCodeButton environmentId={environmentId} />
      </div>
    </Shell>
  );
}

function Connected({ name, computerId }: { name: string | null; computerId: string | null }) {
  const environmentId = usePrimaryEnvironmentId();
  // The search starts on its own and goes on without this card. The offer comes
  // only once, and never after a no.
  const status = useImportStatus(environmentId, computerId, { watch: true }).data;
  const { scan } = useImportActions(environmentId, computerId);
  useEffect(() => {
    if (environmentId !== null && computerId !== null) scan().catch(() => undefined);
  }, [computerId, environmentId, scan]);
  const offer = computerId !== null && hasOffer(status) && status?.declined === false;
  return (
    <Shell testId="connect-done">
      <Heading
        icon={<CheckIcon className="size-4" />}
        title={`${name ?? "Your computer"} is connected`}
        tone="ok"
      />
      {offer ? (
        <ImportOfferBody
          environmentId={environmentId}
          computerId={computerId}
          onDone={localComputer.close}
        />
      ) : (
        <ConnectedPlain searching={status?.state === "scanning"} />
      )}
    </Shell>
  );
}

function ConnectedPlain({ searching }: { searching: boolean }) {
  return (
    <>
      <p className="text-sm text-muted-foreground">Your agents can use it while it’s on.</p>
      {searching ? <ImportSearching done={0} total={0} /> : null}
      <div className="flex justify-end">
        <Button onClick={localComputer.close} data-testid="connect-finish">
          Done
        </Button>
      </div>
    </>
  );
}

function ConnectFlow() {
  const environmentId = usePrimaryEnvironmentId();
  const step = useLocalComputer((state) => state.step);
  const os = useLocalComputer((state) => state.os);
  const pairing = useLocalComputer((state) => state.pairing);
  const pastedFix = useLocalComputer((state) => state.fix);
  const connectedId = useLocalComputer((state) => state.connectedId);
  const pairStatus = usePairStatus(environmentId, step === "connected" ? null : pairing);
  // Only once the code is taken is there a computer to watch.
  const computerId = pairStatus.data?.computerId ?? null;
  const watching = computerId !== null && step !== "connected";
  const { computers } = useMyComputers(environmentId, {
    pollMs: watching ? STATUS_POLL_PAIRING_MS : undefined,
  });
  const refresh = useRefreshMyComputers();

  const progress =
    pairing === null
      ? null
      : pairProgress({
          status: pairStatus.data,
          computers,
          expiresAt: pairing.expiresAt,
          nowMs: Date.now(),
        });

  const justConnected = progress?.kind === "connected" ? progress.computerId : null;
  useEffect(() => {
    if (justConnected === null) return;
    localComputer.connected(justConnected);
    void refresh();
  }, [justConnected, refresh]);

  if (step === "warning") return <Warning environmentId={environmentId} />;
  const doneId = connectedId ?? justConnected;
  if (doneId !== null) {
    const computer = computers.find((one) => one.id === doneId);
    return <Connected name={computer?.name ?? null} computerId={doneId} />;
  }
  if (progress === null || progress.kind === "connected") return null;
  if (progress.kind === "expired") return <Expired environmentId={environmentId} />;

  // What the person asked for stays until they leave it, even if a report lands.
  const unreachable = pairStatus.isError;
  if (step === "stuck") return <Stuck />;
  if (step === "fix" && pastedFix !== null) {
    return <Fix fix={pastedFix} pasted environmentId={environmentId} unreachable={unreachable} />;
  }
  if (progress.kind === "failed") {
    return (
      <Fix
        fix={diagnoseInstall({
          text: progress.message ?? "",
          step: progress.step,
          os,
          commands: pairing!.commands,
          codeUsable: progress.codeUsable,
        })}
        step={progress.step}
        message={progress.message}
        environmentId={environmentId}
        unreachable={unreachable}
      />
    );
  }
  return <Command finishing={progress.kind === "finishing"} unreachable={unreachable} />;
}

function Journal({
  environmentId,
  computerId,
}: {
  environmentId: EnvironmentId | null;
  computerId: string;
}) {
  const activity = useMyComputerActivity(environmentId, computerId);
  const timestampFormat = useSettings((settings) => settings.timestampFormat);
  const formatTime = (iso: string) => formatShortTimestamp(iso, timestampFormat);
  if (activity.data === undefined) {
    return activity.isError ? (
      <p className="text-sm text-muted-foreground">Couldn’t load what agents did.</p>
    ) : null;
  }
  if (activity.data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="connect-actions-empty">
        Agents haven’t used it yet.
      </p>
    );
  }
  const nowMs = activity.dataUpdatedAt;
  return (
    <ul
      className="flex max-h-56 flex-col gap-1.5 overflow-y-auto text-sm"
      aria-label="What agents did"
      data-testid="connect-actions"
    >
      {activity.data.map((entry) => {
        const line = activityLine(entry);
        return (
          <li key={`${entry.at}-${entry.kind}-${entry.summary}`} className="flex gap-3">
            <span className="w-16 shrink-0 text-muted-foreground tabular-nums">
              {activityTimeLabel(entry.at, nowMs, formatTime)}
            </span>
            <span className="min-w-0 truncate" title={line}>
              {line}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ConfirmDisconnect({
  computer,
  environmentId,
  onCancel,
}: {
  computer: MyComputer;
  environmentId: EnvironmentId | null;
  onCancel: () => void;
}) {
  const refresh = useRefreshMyComputers();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setPending(true);
    setError(null);
    const failure = await disconnectComputer(environmentId, computer.id);
    if (failure !== null) {
      setError(failure);
      setPending(false);
      return;
    }
    await refresh();
    localComputer.close();
  };
  return (
    <Shell testId="connect-disconnect-confirm" onEscape={onCancel}>
      <Heading
        icon={<ShieldAlertIcon className="size-4" />}
        title={`Disconnect ${computer.name}?`}
        tone="warning"
      />
      <p className="text-sm text-muted-foreground">{disconnectNote(computer)}</p>
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={pending}
          onClick={() => void confirm()}
          data-testid="connect-disconnect-confirm-button"
        >
          {pending ? "Disconnecting…" : "Disconnect computer"}
        </Button>
      </div>
    </Shell>
  );
}

/** The way back to the import, whatever the person answered before. */
function ImportRow({
  environmentId,
  computer,
}: {
  environmentId: EnvironmentId | null;
  computer: MyComputer;
}) {
  const status = useImportStatus(environmentId, computer.id).data;
  const imported = importedLine(status);
  return (
    <button
      type="button"
      disabled={!computer.online}
      onClick={() => localComputer.openImport(computer.id)}
      data-testid="manage-import"
      className="flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm enabled:cursor-pointer enabled:hover:bg-accent/60 disabled:opacity-60"
    >
      <span className="min-w-0 flex-1 truncate">
        {computer.online ? "Import chats" : "Turn it on to import chats"}
      </span>
      {imported !== null ? (
        <span className="shrink-0 text-muted-foreground tabular-nums">{imported}</span>
      ) : null}
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function Manage() {
  const environmentId = usePrimaryEnvironmentId();
  const manageId = useLocalComputer((state) => state.manageId);
  const { computers, settled, updatedAt } = useMyComputers(environmentId, {
    pollMs: STATUS_POLL_CARD_MS,
  });
  const [confirming, setConfirming] = useState(false);
  const computer = computers.find((one) => one.id === manageId);
  const gone = settled && computer === undefined;
  useEffect(() => {
    if (gone) localComputer.close();
  }, [gone]);
  if (computer === undefined) return null;
  if (confirming) {
    return (
      <ConfirmDisconnect
        computer={computer}
        environmentId={environmentId}
        onCancel={() => setConfirming(false)}
      />
    );
  }
  return (
    <Shell testId="connect-manage">
      <Heading icon={<LaptopIcon className="size-4" />} title={computer.name} />
      <div
        className="flex items-center gap-2 text-sm text-muted-foreground"
        data-testid="connect-manage-status"
      >
        <span
          className={cn(
            "size-2 rounded-full",
            STATUS_DOT_CLASS[computer.online ? "connected" : "disconnected"],
          )}
        />
        {computerStatusLine(computer, updatedAt)}
      </div>
      <ImportRow environmentId={environmentId} computer={computer} />
      <Journal environmentId={environmentId} computerId={computer.id} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={localComputer.close}>
          Close
        </Button>
        <Button
          variant="destructive-outline"
          onClick={() => setConfirming(true)}
          data-testid="connect-disconnect"
        >
          Disconnect computer
        </Button>
      </div>
    </Shell>
  );
}

/** One for the whole app; nothing runs while it's closed. */
export function ConnectComputerDialog() {
  const dialog = useLocalComputer((state) => state.dialog);
  if (dialog === "manage") return <Manage />;
  if (dialog === "import") return <ImportDialog />;
  if (dialog === "connect") return <ConnectFlow />;
  return null;
}
