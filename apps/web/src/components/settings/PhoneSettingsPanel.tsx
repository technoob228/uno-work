/**
 * Settings → Phone. One button that pairs the T3 Code store app with this
 * computer: mint a one-time code on the daemon, show it as a QR (plus a
 * type-it-in fallback), notice when the phone arrives, and list paired phones
 * with a way to cut them off. No terminal involved.
 *
 * Role: the code is minted as `client` (the HTTP route's default). Through the
 * mobile-compat shim that role gets chats, the terminal and reviews — all a
 * phone needs — but not access management, so a lost phone cannot mint more
 * codes or disconnect other devices.
 *
 * @module components/settings/PhoneSettingsPanel
 */
import {
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  RefreshCwIcon,
  SmartphoneIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createServerPairingCredential,
  listServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  type ServerClientSessionRecord,
} from "../../environments/primary/auth";
import { readPrimaryEnvironmentTarget } from "../../environments/primary/target";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
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
  buildPhonePairUrl,
  classifyPhoneHostReach,
  describePhoneSession,
  formatCountdown,
  formatPhoneCode,
  isPhoneSession,
  normalizePhoneHost,
  phonePairingLabel,
  T3_APP_STORE_URL,
  T3_GOOGLE_PLAY_URL,
  type PhoneHostReach,
} from "./phonePairing";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";

const SESSION_POLL_MS = 2_500;
const LIST_REFRESH_MS = 15_000;

/**
 * The address a phone should dial: the daemon's own HTTP origin. In the
 * browser build the daemon serves this page, so it equals the page origin;
 * in dev/desktop it is the daemon, not the Vite server in front of it.
 */
function resolvePhoneBaseUrl(): string {
  const target = readPrimaryEnvironmentTarget();
  return normalizePhoneHost(target?.target.httpBaseUrl ?? window.location.origin);
}

function formatWhen(value: string): string {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function usePhoneSessions() {
  const [sessions, setSessions] = useState<ReadonlyArray<ServerClientSessionRecord> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const all = await listServerClientSessions();
      setSessions(all.filter(isPhoneSession));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load your phones.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), LIST_REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { sessions, error, refresh };
}

export function PhoneSettingsPanel() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { sessions, error, refresh } = usePhoneSessions();
  const [revoking, setRevoking] = useState<string | null>(null);
  const handlePhoneConnected = useCallback(() => void refresh(), [refresh]);

  const disconnect = useCallback(
    async (session: ServerClientSessionRecord) => {
      setRevoking(session.sessionId);
      try {
        await revokeServerClientSession(session.sessionId);
      } finally {
        setRevoking(null);
        await refresh();
      }
    },
    [refresh],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title="Phone" icon={<SmartphoneIcon className="size-3" />}>
        <SettingsRow
          title="Connect your phone"
          description="Keep chatting with your computer from anywhere. Scan a code with the free T3 Code app — no setup on the phone beyond that."
          control={
            <Button onClick={() => setDialogOpen(true)} data-testid="connect-phone">
              <SmartphoneIcon />
              Connect your phone
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Connected phones">
        {error ? (
          <div className="px-4 py-4 text-xs text-destructive sm:px-5">{error}</div>
        ) : sessions === null ? (
          <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground sm:px-5">
            <Spinner className="size-3.5" /> Loading…
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
            No phones yet. Connected phones show up here, and you can cut any of them off.
          </div>
        ) : (
          sessions.map((session) => (
            <SettingsRow
              key={session.sessionId}
              title={describePhoneSession(session)}
              description={
                session.connected
                  ? "Connected now"
                  : session.lastConnectedAt
                    ? `Last seen ${formatWhen(session.lastConnectedAt)}`
                    : `Paired ${formatWhen(session.issuedAt)}`
              }
              control={
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={revoking === session.sessionId}
                  onClick={() => void disconnect(session)}
                >
                  {revoking === session.sessionId ? "Disconnecting…" : "Disconnect"}
                </Button>
              }
            />
          ))
        )}
      </SettingsSection>

      <ConnectPhoneDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onPhoneConnected={handlePhoneConnected}
      />
    </SettingsPageContainer>
  );
}

type IssuedCode = {
  readonly id: string;
  readonly credential: string;
  readonly expiresAt: string;
  readonly mintedAtMs: number;
};

type DialogState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly code: IssuedCode }
  | { readonly kind: "connected"; readonly phone: ServerClientSessionRecord };

function ConnectPhoneDialog({
  open,
  onOpenChange,
  onPhoneConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPhoneConnected: () => void;
}) {
  const [state, setState] = useState<DialogState>({ kind: "loading" });
  const [baseUrl, setBaseUrl] = useState<string>(() => resolvePhoneBaseUrl());
  const liveCodeRef = useRef<IssuedCode | null>(null);
  const knownSessionIdsRef = useRef<ReadonlySet<string>>(new Set());
  const nowMs = useRelativeTimeTick(1_000);

  // Retire a code nobody used, so stale codes do not pile up on the machine.
  const retireLiveCode = useCallback(() => {
    const live = liveCodeRef.current;
    liveCodeRef.current = null;
    if (live) void revokeServerPairingLink(live.id).catch(() => undefined);
  }, []);

  const mint = useCallback(async () => {
    retireLiveCode();
    setState({ kind: "loading" });
    try {
      const existing = await listServerClientSessions().catch(() => []);
      knownSessionIdsRef.current = new Set(existing.map((session) => session.sessionId));
      const mintedAtMs = Date.now();
      const issued = await createServerPairingCredential(phonePairingLabel(new Date(mintedAtMs)));
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
          cause instanceof Error ? cause.message : "Could not make a code. Try again in a moment.",
      });
    }
  }, [retireLiveCode]);

  useEffect(() => {
    if (!open) return;
    setBaseUrl(resolvePhoneBaseUrl());
    void mint();
    return () => retireLiveCode();
  }, [open, mint, retireLiveCode]);

  // Watch for the phone to arrive: a new phone session that did not exist
  // when this code was minted.
  const readyCode = state.kind === "ready" ? state.code : null;
  useEffect(() => {
    if (!readyCode) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const sessions = await listServerClientSessions();
        const arrived = sessions.find(
          (session) =>
            isPhoneSession(session) && !knownSessionIdsRef.current.has(session.sessionId),
        );
        if (arrived && !cancelled) {
          liveCodeRef.current = null; // consumed — nothing to retire
          setState({ kind: "connected", phone: arrived });
          onPhoneConnected();
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
  }, [readyCode, onPhoneConnected]);

  const reach = classifyPhoneHostReach(baseUrl);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md" data-testid="connect-phone-dialog">
        <DialogHeader>
          <DialogTitle>Connect your phone</DialogTitle>
          <DialogDescription>
            Open the T3 Code app, tap{" "}
            <span className="font-medium text-foreground">Add environment</span>, then the camera
            button, and point it at this code.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {state.kind === "connected" ? null : <ReachNotice reach={reach} />}
          {state.kind === "connected" ? (
            <ConnectedNotice phone={state.phone} />
          ) : (
            <CodeView state={state} baseUrl={baseUrl} nowMs={nowMs} onNewCode={() => void mint()} />
          )}
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
          <Button
            variant={state.kind === "connected" ? "default" : "outline"}
            onClick={() => onOpenChange(false)}
          >
            {state.kind === "connected" ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ReachNotice({ reach }: { reach: PhoneHostReach }) {
  if (reach === "public") return null;
  return (
    <Alert variant="warning" data-testid="phone-reach-notice">
      <TriangleAlertIcon />
      <AlertDescription>
        {reach === "loopback"
          ? "This address only works on this computer, so a phone can't reach it. Open Work from your computer's web address and connect from there."
          : "Your phone needs to be on the same Wi-Fi or VPN as this computer."}
      </AlertDescription>
    </Alert>
  );
}

function ConnectedNotice({ phone }: { phone: ServerClientSessionRecord }) {
  return (
    <div
      className="flex flex-col items-center gap-2 py-6 text-center"
      data-testid="phone-connected"
    >
      <CircleCheckIcon className="size-10 text-success" />
      <p className="font-medium">Your phone is connected</p>
      <p className="text-xs text-muted-foreground">
        {describePhoneSession(phone)} — you can disconnect it any time in Settings → Phone.
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
  state: Exclude<DialogState, { kind: "connected" }>;
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
