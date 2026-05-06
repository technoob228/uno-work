import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  ChevronLeftIcon,
  ChevronsLeftRightEllipsisIcon,
  CloudIcon,
  GlobeIcon,
  PlusIcon,
  RefreshCwIcon,
  TerminalIcon,
} from "lucide-react";
import { type ReactNode, memo, useCallback, useEffect, useMemo, useState } from "react";
import type { DesktopDiscoveredSshHost, DesktopSshEnvironmentTarget } from "@t3tools/contracts";

import { readHostedPairingRequest } from "../hostedPairing";
import { cn } from "../lib/utils";
import { getPairingTokenFromUrl } from "../pairingUrl";
import type { SavedEnvironmentRecord } from "../environments/runtime";
import {
  addSavedEnvironment,
  connectDesktopSshEnvironment,
  useSavedEnvironmentRegistryStore,
} from "../environments/runtime";
import { AnimatedHeight } from "./AnimatedHeight";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogBackdrop, DialogPortal, DialogViewport } from "./ui/dialog";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { stackedThreadToast, toastManager } from "./ui/toast";

interface AddEnvModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = "choice" | "uno" | "custom";
type SavedBackendMode = "remote" | "ssh";

const ITEM_ROW_CLASSNAME = "border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5";
const ITEM_ROW_INNER_CLASSNAME =
  "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between";

function formatDesktopSshTarget(target: NonNullable<SavedEnvironmentRecord["desktopSsh"]>): string {
  const authority = target.username ? `${target.username}@${target.hostname}` : target.hostname;
  return target.port ? `${authority}:${target.port}` : authority;
}

function parseManualDesktopSshTarget(input: {
  readonly host: string;
  readonly username: string;
  readonly port: string;
}): DesktopSshEnvironmentTarget {
  const rawHost = input.host.trim();
  if (rawHost.length === 0) {
    throw new Error("SSH host or alias is required.");
  }

  let hostname = rawHost;
  let username = input.username.trim() || null;
  let port: number | null = null;

  const atIndex = hostname.lastIndexOf("@");
  if (atIndex > 0) {
    const inlineUsername = hostname.slice(0, atIndex).trim();
    hostname = hostname.slice(atIndex + 1).trim();
    if (!username && inlineUsername.length > 0) {
      username = inlineUsername;
    }
  }

  const bracketedHostMatch = /^\[([^\]]+)\](?::(\d+))?$/u.exec(hostname);
  if (bracketedHostMatch) {
    hostname = bracketedHostMatch[1]!.trim();
    if (bracketedHostMatch[2]) {
      port = Number.parseInt(bracketedHostMatch[2], 10);
    }
  } else {
    const colonSegments = hostname.split(":");
    if (colonSegments.length === 2 && /^\d+$/u.test(colonSegments[1] ?? "")) {
      hostname = colonSegments[0]!.trim();
      port = Number.parseInt(colonSegments[1]!, 10);
    }
  }

  const rawPort = input.port.trim();
  if (rawPort.length > 0) {
    port = Number.parseInt(rawPort, 10);
  }

  if (hostname.length === 0) {
    throw new Error("SSH host or alias is required.");
  }

  if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
    throw new Error("SSH port must be between 1 and 65535.");
  }

  return {
    alias: hostname,
    hostname,
    username,
    port,
  };
}

function parsePairingUrlFields(
  input: string,
): { readonly host: string; readonly pairingCode: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const urlLikeInput =
      /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(trimmed) || trimmed.startsWith("//")
        ? trimmed
        : `https://${trimmed}`;
    const url = new URL(urlLikeInput, window.location.origin);
    const hostedPairingRequest = readHostedPairingRequest(url);
    if (hostedPairingRequest) {
      return {
        host: hostedPairingRequest.host,
        pairingCode: hostedPairingRequest.token,
      };
    }

    const pairingCode = getPairingTokenFromUrl(url);
    if (!pairingCode) return null;
    return {
      host: url.origin,
      pairingCode,
    };
  } catch {
    return null;
  }
}

function parseRemotePairingFields(input: { readonly host: string; readonly pairingCode: string }): {
  readonly host: string;
  readonly pairingCode: string;
} {
  const parsedPairingUrl = parsePairingUrlFields(input.host);
  if (parsedPairingUrl) return parsedPairingUrl;

  const host = input.host.trim();
  const pairingCode = input.pairingCode.trim();
  if (!host) {
    throw new Error("Enter a backend host.");
  }
  if (!pairingCode) {
    throw new Error("Enter a pairing code.");
  }
  return { host, pairingCode };
}

function formatDesktopSshConnectionError(error: unknown): string {
  const fallback = "Failed to connect SSH host.";
  const rawMessage = error instanceof Error ? error.message : fallback;
  const withoutIpcPrefix = rawMessage.replace(
    /^Error invoking remote method 'desktop:ensure-ssh-environment':\s*/u,
    "",
  );
  const withoutTaggedErrorPrefix = withoutIpcPrefix.replace(/^Ssh[A-Za-z]+Error:\s*/u, "");
  return withoutTaggedErrorPrefix.trim() || fallback;
}

export function AddEnvModal({ open, onOpenChange }: AddEnvModalProps) {
  const [step, setStep] = useState<Step>("choice");

  const handleOpenChange = (next: boolean) => {
    if (!next) setStep("choice");
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogViewport>
          <DialogPrimitive.Popup
            data-slot="dialog-popup"
            className="-translate-y-[calc(1.25rem*var(--nested-dialogs))] relative row-start-2 flex max-h-full min-h-0 w-full min-w-0 max-w-xl scale-[calc(1-0.1*var(--nested-dialogs))] flex-col rounded-2xl border bg-popover text-popover-foreground opacity-[calc(1-0.1*var(--nested-dialogs))] shadow-lg/5 transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0"
          >
            {step === "choice" && (
              <ChoiceStep onClose={() => handleOpenChange(false)} setStep={setStep} />
            )}
            {step === "uno" && (
              <SubStep
                title="Spin up an Uno VPS"
                description="Pick a region and size - we'll have it ready in ~30s."
                primaryLabel="Provision"
                onBack={() => setStep("choice")}
              />
            )}
            {step === "custom" && (
              <CustomEnvironmentStep
                onBack={() => setStep("choice")}
                onClose={() => handleOpenChange(false)}
              />
            )}
          </DialogPrimitive.Popup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}

function ChoiceStep({ onClose, setStep }: { onClose: () => void; setStep: (step: Step) => void }) {
  return (
    <>
      <div className="flex flex-col gap-1 border-b border-border p-6">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-xl bg-primary/12 text-primary">
            <PlusIcon className="size-4" />
          </div>
          <div>
            <DialogPrimitive.Title className="font-heading font-semibold text-lg leading-none">
              Add a new environment
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="mt-1 text-muted-foreground text-sm">
              Where should the agent run?
            </DialogPrimitive.Description>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 p-6">
        <button
          type="button"
          onClick={() => setStep("uno")}
          className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-primary/4"
        >
          <div className="grid size-9 place-items-center rounded-lg bg-primary/12 text-primary">
            <CloudIcon className="size-4" />
          </div>
          <div className="font-medium text-sm">Uno VPS</div>
          <div className="text-muted-foreground text-xs leading-relaxed">
            Spin up a managed server in ~30s. Pre-installed harnesses, billed by Uno.
          </div>
          <Badge variant="outline" className="mt-auto self-start text-[10px]">
            Recommended
          </Badge>
        </button>
        <button
          type="button"
          onClick={() => setStep("custom")}
          className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-primary/4"
        >
          <div className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground">
            <GlobeIcon className="size-4" />
          </div>
          <div className="font-medium text-sm">Remote link / SSH</div>
          <div className="text-muted-foreground text-xs leading-relaxed">
            Pair an existing T3 Code backend or connect through an SSH-managed tunnel.
          </div>
          <Badge variant="outline" className="mt-auto self-start text-[10px] text-muted-foreground">
            Bring your own
          </Badge>
        </button>
      </div>
      <div className="flex justify-end gap-2 border-t border-border bg-muted/40 px-6 py-4">
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </>
  );
}

function CustomEnvironmentStep({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const desktopBridge = window.desktopBridge;
  const savedEnvironmentsById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedDesktopSshEnvironmentsByAlias = useMemo(
    () =>
      Object.values(savedEnvironmentsById).reduce<Record<string, SavedEnvironmentRecord>>(
        (accumulator, record) => {
          if (record.desktopSsh?.alias) {
            accumulator[record.desktopSsh.alias] = record;
          }
          return accumulator;
        },
        {},
      ),
    [savedEnvironmentsById],
  );
  const savedDesktopSshEnvironmentKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const record of Object.values(savedEnvironmentsById)) {
      const target = record.desktopSsh;
      if (!target) continue;
      keys.add(target.alias);
      keys.add(formatDesktopSshTarget(target));
    }
    return keys;
  }, [savedEnvironmentsById]);
  const [savedBackendMode, setSavedBackendMode] = useState<SavedBackendMode>("remote");
  const [savedBackendHost, setSavedBackendHost] = useState("");
  const [savedBackendPairingCode, setSavedBackendPairingCode] = useState("");
  const [savedBackendSshHost, setSavedBackendSshHost] = useState("");
  const [savedBackendSshUsername, setSavedBackendSshUsername] = useState("");
  const [savedBackendSshPort, setSavedBackendSshPort] = useState("");
  const [savedBackendError, setSavedBackendError] = useState<string | null>(null);
  const [isAddingSavedBackend, setIsAddingSavedBackend] = useState(false);
  const [discoveredSshHosts, setDiscoveredSshHosts] = useState<
    ReadonlyArray<DesktopDiscoveredSshHost>
  >([]);
  const [hasLoadedDiscoveredSshHosts, setHasLoadedDiscoveredSshHosts] = useState(false);
  const [isLoadingDiscoveredSshHosts, setIsLoadingDiscoveredSshHosts] = useState(false);
  const [discoveredSshHostsError, setDiscoveredSshHostsError] = useState<string | null>(null);
  const [connectingSshHostAlias, setConnectingSshHostAlias] = useState<string | null>(null);

  const unsavedDiscoveredSshHosts = useMemo(
    () =>
      discoveredSshHosts.filter((target) => {
        const address = formatDesktopSshTarget(target);
        return (
          !savedDesktopSshEnvironmentKeys.has(target.alias) &&
          !savedDesktopSshEnvironmentKeys.has(address)
        );
      }),
    [discoveredSshHosts, savedDesktopSshEnvironmentKeys],
  );

  const resetFields = useCallback(() => {
    setSavedBackendHost("");
    setSavedBackendPairingCode("");
    setSavedBackendSshHost("");
    setSavedBackendSshUsername("");
    setSavedBackendSshPort("");
    setSavedBackendError(null);
  }, []);

  const handleSavedBackendHostChange = useCallback((value: string) => {
    const parsedPairingUrl = parsePairingUrlFields(value);
    if (parsedPairingUrl) {
      setSavedBackendHost(parsedPairingUrl.host);
      setSavedBackendPairingCode(parsedPairingUrl.pairingCode);
      return;
    }
    setSavedBackendHost(value);
  }, []);

  const handleAddSavedBackend = useCallback(async () => {
    if (savedBackendMode === "ssh") {
      setIsAddingSavedBackend(true);
      setSavedBackendError(null);
      try {
        const target = parseManualDesktopSshTarget({
          host: savedBackendSshHost,
          username: savedBackendSshUsername,
          port: savedBackendSshPort,
        });
        const record = await connectDesktopSshEnvironment(target, { label: "" });
        resetFields();
        onClose();
        toastManager.add({
          type: "success",
          title: "Environment connected",
          description: `${record.label} is ready over an SSH-managed tunnel.`,
        });
      } catch (error) {
        setSavedBackendError(formatDesktopSshConnectionError(error));
      } finally {
        setIsAddingSavedBackend(false);
      }
      return;
    }

    setIsAddingSavedBackend(true);
    setSavedBackendError(null);
    try {
      const remotePairingInput = parseRemotePairingFields({
        host: savedBackendHost,
        pairingCode: savedBackendPairingCode,
      });
      const record = await addSavedEnvironment({
        label: "",
        ...remotePairingInput,
      });
      resetFields();
      onClose();
      toastManager.add({
        type: "success",
        title: "Backend added",
        description: `${record.label} is now saved and will reconnect on app startup.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add backend.";
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not add backend",
          description: message,
        }),
      );
    } finally {
      setIsAddingSavedBackend(false);
    }
  }, [
    onClose,
    resetFields,
    savedBackendHost,
    savedBackendMode,
    savedBackendPairingCode,
    savedBackendSshHost,
    savedBackendSshPort,
    savedBackendSshUsername,
  ]);

  const loadDiscoveredSshHosts = useCallback(async () => {
    if (!desktopBridge) {
      setDiscoveredSshHosts([]);
      setHasLoadedDiscoveredSshHosts(false);
      setDiscoveredSshHostsError(null);
      return;
    }

    setIsLoadingDiscoveredSshHosts(true);
    setDiscoveredSshHostsError(null);
    try {
      const hosts = await desktopBridge.discoverSshHosts();
      setDiscoveredSshHosts(hosts);
      setHasLoadedDiscoveredSshHosts(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to discover SSH hosts.";
      setDiscoveredSshHostsError(message);
      setHasLoadedDiscoveredSshHosts(true);
    } finally {
      setIsLoadingDiscoveredSshHosts(false);
    }
  }, [desktopBridge]);

  const handleConnectSshHost = useCallback(
    async (target: DesktopSshEnvironmentTarget, label?: string) => {
      setConnectingSshHostAlias(target.alias);
      if (savedBackendMode === "ssh") {
        setSavedBackendError(null);
      } else {
        setDiscoveredSshHostsError(null);
      }
      try {
        const record = await connectDesktopSshEnvironment(
          target,
          label === undefined ? undefined : { label },
        );
        resetFields();
        onClose();
        toastManager.add({
          type: "success",
          title: savedDesktopSshEnvironmentsByAlias[target.alias]
            ? "Environment reconnected"
            : "Environment connected",
          description: `${record.label} is ready over an SSH-managed tunnel.`,
        });
      } catch (error) {
        const message = formatDesktopSshConnectionError(error);
        if (savedBackendMode === "ssh") {
          setSavedBackendError(message);
        } else {
          setDiscoveredSshHostsError(message);
        }
      } finally {
        setConnectingSshHostAlias(null);
      }
    },
    [onClose, resetFields, savedBackendMode, savedDesktopSshEnvironmentsByAlias],
  );

  useEffect(() => {
    if (!desktopBridge || savedBackendMode !== "ssh") {
      return;
    }
    if (hasLoadedDiscoveredSshHosts || isLoadingDiscoveredSshHosts) {
      return;
    }
    void loadDiscoveredSshHosts();
  }, [
    desktopBridge,
    hasLoadedDiscoveredSshHosts,
    isLoadingDiscoveredSshHosts,
    loadDiscoveredSshHosts,
    savedBackendMode,
  ]);

  const renderConnectionModeCard = (input: {
    readonly mode: SavedBackendMode;
    readonly title: string;
    readonly description: string;
    readonly icon?: ReactNode;
  }) => {
    const selected = savedBackendMode === input.mode;
    return (
      <button
        type="button"
        aria-pressed={selected}
        className={cn(
          "group flex min-h-24 items-start gap-3 rounded-lg border p-4 text-left",
          selected ? "border-primary/50 bg-primary/5" : "border-border/60 hover:bg-muted/40",
        )}
        disabled={isAddingSavedBackend}
        onClick={() => {
          setSavedBackendMode(input.mode);
          setSavedBackendError(null);
        }}
      >
        {input.icon ? (
          <span
            className={cn(
              "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
              selected
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-border/70 bg-background text-muted-foreground group-hover:text-foreground",
            )}
          >
            {input.icon}
          </span>
        ) : null}
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{input.title}</span>
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            {input.description}
          </span>
        </span>
      </button>
    );
  };

  const renderRemoteFields = () => (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Host</span>
          <Input
            value={savedBackendHost}
            onChange={(event) => handleSavedBackendHostChange(event.target.value)}
            placeholder="backend.example.com"
            disabled={isAddingSavedBackend}
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Pairing code</span>
          <Input
            value={savedBackendPairingCode}
            onChange={(event) => setSavedBackendPairingCode(event.target.value)}
            placeholder="PAIRCODE"
            disabled={isAddingSavedBackend}
            spellCheck={false}
          />
        </label>
      </div>
      <span className="mt-1 block text-[11px] text-muted-foreground">
        Paste a full pairing URL here to fill both fields automatically.
      </span>
    </div>
  );

  const renderRemoteModeBody = () => (
    <div className="space-y-4">
      {renderRemoteFields()}
      {savedBackendError ? <p className="text-xs text-destructive">{savedBackendError}</p> : null}
      <Button
        variant="outline"
        className="w-full"
        disabled={isAddingSavedBackend}
        onClick={() => void handleAddSavedBackend()}
      >
        <PlusIcon className="size-3.5" />
        {isAddingSavedBackend ? "Adding..." : "Add environment"}
      </Button>
    </div>
  );

  const renderSshFields = () => (
    <div className="space-y-4">
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            SSH host or alias
          </span>
          <Input
            value={savedBackendSshHost}
            onChange={(event) => setSavedBackendSshHost(event.target.value)}
            placeholder="Search hosts or type devbox"
            disabled={isAddingSavedBackend}
            spellCheck={false}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Username</span>
            <Input
              value={savedBackendSshUsername}
              onChange={(event) => setSavedBackendSshUsername(event.target.value)}
              placeholder="root"
              disabled={isAddingSavedBackend}
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Port</span>
            <Input
              value={savedBackendSshPort}
              onChange={(event) => setSavedBackendSshPort(event.target.value)}
              placeholder="22"
              inputMode="numeric"
              disabled={isAddingSavedBackend}
              spellCheck={false}
            />
          </label>
        </div>
        {savedBackendError || discoveredSshHostsError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {savedBackendError ?? discoveredSshHostsError}
          </div>
        ) : null}
        <Button
          variant="outline"
          className="w-full"
          disabled={isAddingSavedBackend}
          onClick={() => void handleAddSavedBackend()}
        >
          <PlusIcon className="size-3.5" />
          {isAddingSavedBackend ? "Adding..." : "Add environment"}
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border/60">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/30 px-3 py-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">Suggested hosts</p>
            <p className="text-[11px] text-muted-foreground">From SSH config and known hosts</p>
          </div>
          <Button
            size="xs"
            variant="ghost"
            disabled={isLoadingDiscoveredSshHosts}
            onClick={() => void loadDiscoveredSshHosts()}
          >
            {isLoadingDiscoveredSshHosts ? (
              <RefreshCwIcon className="size-3 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3" />
            )}
            Refresh
          </Button>
        </div>
        <ScrollArea scrollFade className="max-h-56">
          <div>
            {unsavedDiscoveredSshHosts.map((target) => (
              <DesktopSshHostRow
                key={`${target.alias}:${target.hostname}:${target.port ?? ""}`}
                target={target}
                connectingHostAlias={connectingSshHostAlias}
                onConnect={(nextTarget) => void handleConnectSshHost(nextTarget)}
              />
            ))}
            {hasLoadedDiscoveredSshHosts &&
            !isLoadingDiscoveredSshHosts &&
            unsavedDiscoveredSshHosts.length === 0 ? (
              <div className={ITEM_ROW_CLASSNAME}>
                <p className="text-xs text-muted-foreground">No new SSH hosts were discovered.</p>
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </div>
  );

  return (
    <>
      <div className="flex flex-col gap-1 border-b border-border p-6">
        <DialogPrimitive.Title className="font-heading font-semibold text-lg leading-none">
          Add Environment
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="mt-1 text-muted-foreground text-sm">
          Pair another environment to this client.
        </DialogPrimitive.Description>
      </div>
      <ScrollArea className="min-h-0">
        <div className="space-y-4 p-6">
          <div className="grid gap-3 sm:grid-cols-2">
            {renderConnectionModeCard({
              mode: "remote",
              title: "Remote link",
              description: "Use a pairing link or host and pairing code from another backend.",
              icon: <ChevronsLeftRightEllipsisIcon className="size-4" />,
            })}
            {renderConnectionModeCard({
              mode: "ssh",
              title: "SSH",
              description: "Connect through an SSH-managed tunnel from this desktop app.",
              icon: <TerminalIcon className="size-4" />,
            })}
          </div>
          <AnimatedHeight>
            {savedBackendMode === "ssh" ? renderSshFields() : renderRemoteModeBody()}
          </AnimatedHeight>
        </div>
      </ScrollArea>
      <div className="flex justify-between gap-2 border-t border-border bg-muted/40 px-6 py-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeftIcon className="size-3.5" />
          Back
        </Button>
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </>
  );
}

function SubStep({
  title,
  description,
  primaryLabel,
  onBack,
}: {
  title: string;
  description: string;
  primaryLabel: string;
  onBack: () => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-1 border-b border-border p-6">
        <DialogPrimitive.Title className="font-heading font-semibold text-lg leading-none">
          {title}
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="mt-1 text-muted-foreground text-sm">
          {description}
        </DialogPrimitive.Description>
      </div>
      <div className="grid place-items-center px-6 py-12 text-center text-muted-foreground text-sm">
        <em>coming next</em>
      </div>
      <div className="flex justify-between gap-2 border-t border-border bg-muted/40 px-6 py-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeftIcon className="size-3.5" />
          Back
        </Button>
        <Button size="sm" disabled>
          {primaryLabel}
        </Button>
      </div>
    </>
  );
}

interface DesktopSshHostRowProps {
  target: DesktopDiscoveredSshHost;
  connectingHostAlias: string | null;
  onConnect: (target: DesktopDiscoveredSshHost) => void;
}

const DesktopSshHostRow = memo(function DesktopSshHostRow({
  target,
  connectingHostAlias,
  onConnect,
}: DesktopSshHostRowProps) {
  const address = formatDesktopSshTarget(target);
  const showAddress = address !== target.alias;
  const buttonLabel = connectingHostAlias === target.alias ? "Adding..." : "Add environment";

  return (
    <div className="border-t border-border/60 px-4 py-3 first:border-t-0 sm:px-5">
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-foreground">{target.alias}</h3>
          {showAddress ? <p className="truncate text-xs text-muted-foreground">{address}</p> : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Button
            size="xs"
            variant="outline"
            disabled={connectingHostAlias === target.alias}
            onClick={() => onConnect(target)}
          >
            {connectingHostAlias === target.alias ? (
              <RefreshCwIcon className="size-3 animate-spin" />
            ) : null}
            {buttonLabel}
          </Button>
        </div>
      </div>
    </div>
  );
});
