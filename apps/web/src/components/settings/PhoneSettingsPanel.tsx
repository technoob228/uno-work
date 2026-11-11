/**
 * Settings → Phone. Connects the T3 Code store app to the whole workspace:
 * every computer this Work is connected to, one QR each (the app pairs one
 * computer per code). Codes are minted on that computer's own daemon and
 * carry an address a phone can dial — the cloud computer's published
 * `*.app.uno4.dev`, never the Mac's 127.0.0.1 (Misha 11.11: desktop Work used
 * to hand the phone a loopback address and pairing failed).
 *
 * Flow: "Scan 1 of N", the dialog notices the phone arriving on that computer,
 * Next. Computers a phone cannot reach are listed with the reason instead of
 * a useless code. Connected phones are listed per computer, each with
 * Disconnect.
 *
 * Role: codes are `client` (see phoneComputerApi).
 *
 * @module components/settings/PhoneSettingsPanel
 */
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdvertisedEndpoint, EnvironmentId } from "@t3tools/contracts";
import {
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  RefreshCwIcon,
  SmartphoneIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePrimaryEnvironmentDescriptor } from "../../environments/primary";
import type { ServerClientSessionRecord } from "../../environments/primary/auth";
import { readPrimaryEnvironmentTarget } from "../../environments/primary/target";
import { useSavedEnvironmentRegistryStore } from "../../environments/runtime";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { boxDirectOrigin, isWorkProxyHost } from "../../hooks/useDirectMachineAddress";
import { unoCloudStateQueryOptions } from "../../lib/workspaceReactQuery";
import { Alert, AlertDescription } from "../ui/alert";
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
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import {
  disconnectPhoneComputerSession,
  listPhoneComputerSessions,
  mintPhoneComputerCode,
  retirePhoneComputerCode,
} from "./phoneComputerApi";
import {
  buildPhonePairUrl,
  dedupePhoneComputerSources,
  describePhoneSession,
  formatCountdown,
  formatPhoneCode,
  isPhoneSession,
  orderPhoneComputers,
  type PhoneComputer,
  type PhoneComputerSource,
  phonePairingLabel,
  resolvePhoneComputer,
  T3_APP_STORE_URL,
  T3_GOOGLE_PLAY_URL,
} from "./phonePairing";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";

const SESSION_POLL_MS = 2_500;
const LIST_REFRESH_MS = 15_000;

function formatWhen(value: string): string {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Where the desktop daemon listens beyond loopback (Network access); empty in the browser. */
function useDesktopEndpoints(): ReadonlyArray<AdvertisedEndpoint> {
  const [endpoints, setEndpoints] = useState<ReadonlyArray<AdvertisedEndpoint>>([]);
  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
    if (!bridge) return;
    let cancelled = false;
    void bridge
      .getAdvertisedEndpoints()
      .then((next) => {
        if (!cancelled) setEndpoints(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return endpoints;
}

/**
 * Every computer of the workspace this Work is connected to, in scan order.
 * `addressPending`: the account state (with the boxes' own addresses) has not
 * loaded yet, so a box may still show as unreachable for a moment.
 */
function usePhoneComputers(): {
  readonly computers: ReadonlyArray<PhoneComputer>;
  readonly addressPending: boolean;
} {
  const descriptor = usePrimaryEnvironmentDescriptor();
  const saved = useSavedEnvironmentRegistryStore((state) => state.byId);
  const cloud = useQuery(unoCloudStateQueryOptions(descriptor?.environmentId ?? null));
  const desktopEndpoints = useDesktopEndpoints();

  const computers = useMemo(() => {
    const boxes = cloud.data?.connected ? cloud.data.boxes : [];
    const originOfBox = (boxId: number | null) => {
      if (boxId === null) return null;
      const box = boxes.find((candidate) => candidate.id === boxId);
      return box ? boxDirectOrigin(box) : null;
    };
    const sources: PhoneComputerSource[] = [];
    if (descriptor) {
      const unoBoxId = descriptor.unoBoxId ?? null;
      sources.push({
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        isPrimary: true,
        unoBoxId,
        httpBaseUrl:
          readPrimaryEnvironmentTarget()?.target.httpBaseUrl ??
          (typeof window === "undefined" ? null : window.location.origin),
        boxDirectOrigin: originOfBox(unoBoxId),
        advertisedEndpoints: desktopEndpoints,
      });
    }
    for (const record of Object.values(saved)) {
      const unoBoxId = record.unoBoxId ?? null;
      sources.push({
        environmentId: record.environmentId,
        label: record.label,
        isPrimary: false,
        unoBoxId,
        httpBaseUrl: record.httpBaseUrl,
        boxDirectOrigin: originOfBox(unoBoxId),
      });
    }
    return orderPhoneComputers(
      dedupePhoneComputerSources(sources).map((source) =>
        resolvePhoneComputer(source, isWorkProxyHost),
      ),
    );
  }, [descriptor, saved, cloud.data, desktopEndpoints]);

  return { computers, addressPending: cloud.isPending && descriptor !== null };
}

const PHONE_SESSIONS_KEY_ROOT = ["settings", "phoneSessions"] as const;
const phoneSessionsKey = (environmentId: EnvironmentId) =>
  [...PHONE_SESSIONS_KEY_ROOT, environmentId] as const;

export function PhoneSettingsPanel() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { computers, addressPending } = usePhoneComputers();
  const [revoking, setRevoking] = useState<string | null>(null);

  const sessionQueries = useQueries({
    queries: computers.map((computer) => ({
      queryKey: phoneSessionsKey(computer.environmentId),
      queryFn: async () =>
        (await listPhoneComputerSessions(computer.environmentId)).filter(isPhoneSession),
      refetchInterval: LIST_REFRESH_MS,
      retry: 1,
    })),
  });
  const queryClient = useQueryClient();
  const refetchAll = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: PHONE_SESSIONS_KEY_ROOT });
  }, [queryClient]);

  const disconnect = useCallback(
    async (environmentId: EnvironmentId, session: ServerClientSessionRecord) => {
      setRevoking(session.sessionId);
      try {
        await disconnectPhoneComputerSession(environmentId, session.sessionId);
      } finally {
        setRevoking(null);
        refetchAll();
      }
    },
    [refetchAll],
  );

  const showComputerNames = computers.length > 1;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Phone" icon={<SmartphoneIcon className="size-3" />}>
        <SettingsRow
          title="Connect your phone"
          description="Chat with your computers from anywhere. Scan one code per computer with the free T3 Code app. (To use Work in the phone's browser instead, use Connections → Open on another device.)"
          control={
            <Button onClick={() => setDialogOpen(true)} data-testid="connect-phone">
              <SmartphoneIcon />
              Connect your phone
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Connected phones">
        {computers.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground sm:px-5">
            <Spinner className="size-3.5" /> Loading…
          </div>
        ) : (
          <ConnectedPhonesList
            computers={computers}
            sessionQueries={sessionQueries}
            showComputerNames={showComputerNames}
            revoking={revoking}
            onDisconnect={(environmentId, session) => void disconnect(environmentId, session)}
          />
        )}
      </SettingsSection>

      <ConnectPhoneDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        computers={computers}
        addressPending={addressPending}
        onPhoneConnected={refetchAll}
      />
    </SettingsPageContainer>
  );
}

function ConnectedPhonesList({
  computers,
  sessionQueries,
  showComputerNames,
  revoking,
  onDisconnect,
}: {
  computers: ReadonlyArray<PhoneComputer>;
  sessionQueries: ReadonlyArray<{
    readonly data?: ReadonlyArray<ServerClientSessionRecord> | undefined;
    readonly error: unknown;
    readonly isPending: boolean;
  }>;
  showComputerNames: boolean;
  revoking: string | null;
  onDisconnect: (environmentId: EnvironmentId, session: ServerClientSessionRecord) => void;
}) {
  const rows = computers.flatMap((computer, index) =>
    (sessionQueries[index]?.data ?? []).map((session) => ({ computer, session })),
  );
  const pending = sessionQueries.some((query) => query.isPending);
  const failed = computers.filter((_, index) => sessionQueries[index]?.error);

  return (
    <>
      {rows.map(({ computer, session }) => (
        <SettingsRow
          key={`${computer.environmentId}:${session.sessionId}`}
          title={describePhoneSession(session)}
          description={[
            showComputerNames ? computer.label : null,
            session.connected
              ? "Connected now"
              : session.lastConnectedAt
                ? `Last seen ${formatWhen(session.lastConnectedAt)}`
                : `Paired ${formatWhen(session.issuedAt)}`,
          ]
            .filter(Boolean)
            .join(" · ")}
          control={
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={revoking === session.sessionId}
              onClick={() => onDisconnect(computer.environmentId, session)}
            >
              {revoking === session.sessionId ? "Disconnecting…" : "Disconnect"}
            </Button>
          }
        />
      ))}
      {rows.length === 0 && pending ? (
        <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground sm:px-5">
          <Spinner className="size-3.5" /> Loading…
        </div>
      ) : null}
      {rows.length === 0 && !pending ? (
        <div className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
          No phones yet. Connected phones show up here, and you can cut any of them off.
        </div>
      ) : null}
      {failed.length > 0 ? (
        <div className="px-4 py-3 text-xs text-muted-foreground sm:px-5">
          Couldn&apos;t check {failed.map((computer) => computer.label).join(", ")} just now.
        </div>
      ) : null}
    </>
  );
}

function ConnectPhoneDialog({
  open,
  onOpenChange,
  computers,
  addressPending,
  onPhoneConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  computers: ReadonlyArray<PhoneComputer>;
  addressPending: boolean;
  onPhoneConnected: () => void;
}) {
  const steps = useMemo(
    () => computers.filter((computer) => computer.phoneBaseUrl !== null),
    [computers],
  );
  const unreachable = useMemo(
    () => computers.filter((computer) => computer.phoneBaseUrl === null),
    [computers],
  );
  const [stepIndex, setStepIndex] = useState(0);
  const [connected, setConnected] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setStepIndex(0);
    setConnected(new Set());
  }, [open]);

  const index = Math.min(stepIndex, Math.max(0, steps.length - 1));
  const current = steps[index] ?? null;
  const isLast = index >= steps.length - 1;
  const handleConnected = useCallback(
    (environmentId: EnvironmentId) => {
      setConnected((previous) => new Set(previous).add(environmentId));
      onPhoneConnected();
    },
    [onPhoneConnected],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md" data-testid="connect-phone-dialog">
        <DialogHeader>
          <DialogTitle>Connect your phone</DialogTitle>
          <DialogDescription>
            Open the T3 Code app, tap{" "}
            <span className="font-medium text-foreground">Add environment</span>, then the camera
            button, and point it at the code.
            {steps.length > 1 ? " One code per computer." : null}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {steps.length > 1 ? (
            <StepChips
              steps={steps}
              index={index}
              connected={connected}
              onPick={(next) => setStepIndex(next)}
            />
          ) : null}

          {current ? (
            <>
              {current.reach === "private" ? (
                <Alert variant="warning" data-testid="phone-reach-notice">
                  <TriangleAlertIcon />
                  <AlertDescription>
                    Your phone needs to be on the same Wi-Fi or VPN as {current.label}.
                  </AlertDescription>
                </Alert>
              ) : null}
              {open ? (
                <ComputerCodePane
                  key={current.environmentId}
                  computer={current}
                  stepLabel={steps.length > 1 ? `Scan ${index + 1} of ${steps.length}` : null}
                  alreadyConnected={connected.has(current.environmentId)}
                  onConnected={handleConnected}
                />
              ) : null}
            </>
          ) : addressPending ? (
            <div className="flex h-56 items-center justify-center">
              <Spinner className="size-5" />
            </div>
          ) : (
            <Alert variant="warning" data-testid="phone-reach-notice">
              <TriangleAlertIcon />
              <AlertDescription>
                A phone can&apos;t reach any of your computers from here. Connect a cloud computer
                in Work, or turn on Settings → Connections → Network access to use this one on the
                same Wi-Fi.
              </AlertDescription>
            </Alert>
          )}

          {unreachable.length > 0 && steps.length > 0 ? (
            <UnreachableNote computers={unreachable} />
          ) : null}

          <p className="text-xs text-muted-foreground">
            Don&apos;t have the app? Get T3 Code on the{" "}
            <a
              className="underline underline-offset-2"
              href={T3_APP_STORE_URL}
              target="_blank"
              rel="noreferrer"
            >
              App Store
            </a>{" "}
            or{" "}
            <a
              className="underline underline-offset-2"
              href={T3_GOOGLE_PLAY_URL}
              target="_blank"
              rel="noreferrer"
            >
              Google Play
            </a>
            .
          </p>
        </DialogPanel>
        <DialogFooter variant="bare">
          {index > 0 ? (
            <Button variant="outline" onClick={() => setStepIndex(index - 1)}>
              Back
            </Button>
          ) : null}
          {current && !isLast ? (
            <Button
              variant={connected.has(current.environmentId) ? "default" : "outline"}
              onClick={() => setStepIndex(index + 1)}
              data-testid="phone-next-computer"
            >
              {connected.has(current.environmentId) ? "Next" : "Skip"}
            </Button>
          ) : (
            <Button
              variant={current && connected.has(current.environmentId) ? "default" : "outline"}
              onClick={() => onOpenChange(false)}
            >
              {connected.size > 0 ? "Done" : "Close"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function StepChips({
  steps,
  index,
  connected,
  onPick,
}: {
  steps: ReadonlyArray<PhoneComputer>;
  index: number;
  connected: ReadonlySet<string>;
  onPick: (index: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="phone-computer-steps">
      {steps.map((computer, stepIndex) => {
        const done = connected.has(computer.environmentId);
        const active = stepIndex === index;
        return (
          <button
            key={computer.environmentId}
            type="button"
            onClick={() => onPick(stepIndex)}
            aria-current={active ? "step" : undefined}
            className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
              active
                ? "border-foreground/30 bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/60"
            }`}
          >
            {done ? (
              <CheckIcon className="size-3 text-success" />
            ) : (
              <span className="tabular-nums">{stepIndex + 1}</span>
            )}
            <span className="truncate">{computer.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function UnreachableNote({ computers }: { computers: ReadonlyArray<PhoneComputer> }) {
  return (
    <p className="text-xs text-muted-foreground" data-testid="phone-unreachable-note">
      Not reachable from a phone: {computers.map((computer) => computer.label).join(", ")}.
      {computers.some((computer) => computer.isPrimary)
        ? " For this one on the same Wi-Fi, turn on Settings → Connections → Network access."
        : null}
    </p>
  );
}

type IssuedCode = {
  readonly id: string;
  readonly credential: string;
  readonly expiresAt: string;
  readonly mintedAtMs: number;
};

type CodeState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly code: IssuedCode }
  | { readonly kind: "connected"; readonly phone: ServerClientSessionRecord | null };

/** One computer's code: minted on its daemon, retired if unused, watched for the phone. */
function ComputerCodePane({
  computer,
  stepLabel,
  alreadyConnected,
  onConnected,
}: {
  computer: PhoneComputer;
  stepLabel: string | null;
  alreadyConnected: boolean;
  onConnected: (environmentId: EnvironmentId) => void;
}) {
  const { environmentId } = computer;
  const baseUrl = computer.phoneBaseUrl ?? "";
  const [state, setState] = useState<CodeState>(() =>
    alreadyConnected ? { kind: "connected", phone: null } : { kind: "loading" },
  );
  const liveCodeRef = useRef<IssuedCode | null>(null);
  const knownSessionIdsRef = useRef<ReadonlySet<string>>(new Set());
  const nowMs = useRelativeTimeTick(1_000);

  // Retire a code nobody used, so stale codes do not pile up on the computer.
  const retireLiveCode = useCallback(() => {
    const live = liveCodeRef.current;
    liveCodeRef.current = null;
    if (live) void retirePhoneComputerCode(environmentId, live.id).catch(() => undefined);
  }, [environmentId]);

  const mint = useCallback(async () => {
    retireLiveCode();
    setState({ kind: "loading" });
    try {
      const existing = await listPhoneComputerSessions(environmentId).catch(() => []);
      knownSessionIdsRef.current = new Set(existing.map((session) => session.sessionId));
      const mintedAtMs = Date.now();
      const issued = await mintPhoneComputerCode(
        environmentId,
        phonePairingLabel(new Date(mintedAtMs)),
      );
      const code: IssuedCode = {
        id: issued.id,
        credential: issued.credential,
        expiresAt: String(issued.expiresAt),
        mintedAtMs,
      };
      liveCodeRef.current = code;
      setState({ kind: "ready", code });
    } catch (cause) {
      setState({
        kind: "error",
        message:
          cause instanceof Error
            ? `${computer.label}: ${cause.message}`
            : `Couldn't make a code on ${computer.label}. Try again in a moment.`,
      });
    }
  }, [computer.label, environmentId, retireLiveCode]);

  // Mint once per mounted computer (the pane is keyed by it); "New code"
  // mints again on demand. Back to a computer the phone already joined: no
  // new code.
  const mintRef = useRef(mint);
  mintRef.current = mint;
  const startConnectedRef = useRef(alreadyConnected);
  useEffect(() => {
    if (!startConnectedRef.current) void mintRef.current();
    return () => retireLiveCode();
  }, [retireLiveCode]);

  // Watch for the phone: a new phone session that did not exist when this
  // code was minted.
  const readyCode = state.kind === "ready" ? state.code : null;
  useEffect(() => {
    if (!readyCode) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const sessions = await listPhoneComputerSessions(environmentId);
        const arrived = sessions.find(
          (session) =>
            isPhoneSession(session) && !knownSessionIdsRef.current.has(session.sessionId),
        );
        if (arrived && !cancelled) {
          liveCodeRef.current = null; // consumed — nothing to retire
          setState({ kind: "connected", phone: arrived });
          onConnected(environmentId);
        }
      } catch {
        // Keep polling; a blip here is not worth interrupting the scan.
      }
    };
    const id = setInterval(() => void poll(), SESSION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [readyCode, environmentId, onConnected]);

  return (
    <div className="space-y-3" data-testid="phone-computer-pane" data-computer={computer.label}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="truncate font-medium" data-testid="phone-computer-name">
          {computer.label}
        </span>
        {stepLabel ? (
          <span className="shrink-0 text-xs text-muted-foreground">{stepLabel}</span>
        ) : null}
      </div>
      {state.kind === "connected" ? (
        <ConnectedNotice computer={computer} phone={state.phone} />
      ) : (
        <CodeView state={state} baseUrl={baseUrl} nowMs={nowMs} onNewCode={() => void mint()} />
      )}
    </div>
  );
}

function ConnectedNotice({
  computer,
  phone,
}: {
  computer: PhoneComputer;
  phone: ServerClientSessionRecord | null;
}) {
  return (
    <div
      className="flex flex-col items-center gap-2 py-6 text-center"
      data-testid="phone-connected"
    >
      <CircleCheckIcon className="size-10 text-success" />
      <p className="font-medium">Your phone is connected to {computer.label}</p>
      <p className="text-xs text-muted-foreground">
        {phone ? `${describePhoneSession(phone)} — ` : ""}you can disconnect it any time in Settings
        → Phone.
      </p>
    </div>
  );
}

function CodeView({
  state,
  baseUrl,
  nowMs,
  onNewCode,
}: {
  state: Exclude<CodeState, { kind: "connected" }>;
  baseUrl: string;
  nowMs: number;
  onNewCode: () => void;
}) {
  if (state.kind === "loading") {
    return (
      <div className="flex h-56 items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <Alert variant="error">
        <TriangleAlertIcon />
        <AlertDescription className="flex flex-col items-start gap-2">
          {state.message}
          <Button size="xs" variant="outline" onClick={onNewCode}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const { code } = state;
  const pairUrl = buildPhonePairUrl(baseUrl, code.credential);
  const msLeft = new Date(code.expiresAt).getTime() - nowMs;
  const expired = msLeft <= 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-3">
        <div
          className="relative rounded-xl border bg-white p-3"
          data-testid="phone-qr"
          data-pair-url={pairUrl}
        >
          <QRCodeSvg
            value={pairUrl}
            size={208}
            level="M"
            title="Pairing code for the T3 Code app"
          />
          {expired ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl bg-background/90">
              <p className="text-sm font-medium">This code expired</p>
              <Button size="sm" onClick={onNewCode}>
                <RefreshCwIcon />
                New code
              </Button>
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span data-testid="phone-code-timer">
            {expired ? "Expired" : `Works for ${formatCountdown(msLeft)} · one phone`}
          </span>
          <Button size="xs" variant="ghost" onClick={onNewCode}>
            <RefreshCwIcon />
            New code
          </Button>
        </div>
      </div>

      <details className="group rounded-xl border px-4 py-3 text-sm">
        <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">
          Can&apos;t scan? Type it in instead
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">
          On the app&apos;s <span className="font-medium text-foreground">Add environment</span>{" "}
          screen, fill in:
        </p>
        <div className="mt-3 space-y-3">
          <CopyField label="Host" value={baseUrl} display={baseUrl} className="text-sm" />
          <CopyField
            label="Pairing code"
            value={code.credential}
            display={formatPhoneCode(code.credential)}
            className="text-2xl tracking-[0.12em]"
            testId="phone-manual-code"
          />
        </div>
      </details>
    </div>
  );
}

function CopyField({
  label,
  value,
  display,
  className,
  testId,
}: {
  label: string;
  value: string;
  display: string;
  className?: string;
  testId?: string;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
        <div className={`truncate font-mono font-semibold ${className ?? ""}`} data-testid={testId}>
          {display}
        </div>
      </div>
      <Button
        size="xs"
        variant="outline"
        onClick={() => copyToClipboard(value, undefined)}
        aria-label={`Copy ${label.toLowerCase()}`}
      >
        {isCopied ? <CheckIcon /> : <CopyIcon />}
        {isCopied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
