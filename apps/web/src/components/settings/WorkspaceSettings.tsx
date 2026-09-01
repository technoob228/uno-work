/**
 * Workspace panel — the registry made visible: which machines are in this
 * workspace, which Uno account backs it, what is claimed right now, and the
 * rules under which one machine may act on another.
 *
 * Degradation is loud on purpose. A registry that cannot be reached looks
 * exactly like a healthy one unless the panel says otherwise, and silent
 * staleness is the failure we have already been bitten by with tunnels.
 */
import {
  deriveMachineMonogram,
  parseUnoBoxSshTarget,
  type EnvironmentId,
  type UnoBox,
  type WorkspaceCapability,
  type WorkspaceMachine,
  type WorkspacePolicy,
  type WorkspaceState,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { CloudIcon, MonitorIcon, RefreshCwIcon, ServerIcon, TrashIcon } from "lucide-react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useSavedEnvironmentRegistryStore } from "../../environments/runtime";
import {
  unoCloudBoxPowerMutationOptions,
  unoCloudStateQueryOptions,
  workspaceQueryKeys,
  workspaceDecideRequestMutationOptions,
  workspaceRemoveGrantMutationOptions,
  workspaceRenameMutationOptions,
  workspaceRemoveMachineMutationOptions,
  workspaceReleaseClaimMutationOptions,
  workspaceSetPolicyMutationOptions,
  workspaceStateQueryOptions,
  workspaceSyncMachinesMutationOptions,
  workspaceUpdateMachineMutationOptions,
  workspaceUpsertGrantMutationOptions,
} from "../../lib/workspaceReactQuery";
import { useFeatureFlag } from "../../hooks/useFeatureFlags";
import { FeatureDisabledPanel } from "./FeatureDisabledPanel";
import { MachineChip } from "../MachineChip";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { WorkspaceInstructionsSection } from "./WorkspaceInstructions";

const MACHINE_COLOR_CHOICES = [
  { slot: 0, label: "Neutral" },
  { slot: 1, label: "Hue 1" },
  { slot: 2, label: "Hue 2" },
  { slot: 3, label: "Hue 3" },
] as const;

const CAPABILITY_LABELS: Record<WorkspaceCapability, string> = {
  view_status: "see status",
  view_threads: "see chats",
  read_transcript: "read transcript",
  create_threads: "create chats",
  write: "write",
};

const WRITE_MODE_CHOICES: ReadonlyArray<{
  readonly value: WorkspacePolicy["crossEnvironmentWrite"];
  readonly label: string;
}> = [
  { value: "deny", label: "Never" },
  { value: "request", label: "By request" },
  { value: "allow", label: "Straight through" },
];

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "unknown";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * A machine is stale rather than offline when we have simply not heard from it
 * recently. The panel says which, because "old data" and "gone" call for
 * different reactions.
 */
function machinePresence(machine: WorkspaceMachine): "live" | "stale" | "unknown" {
  if (!machine.lastSeenAt) return "unknown";
  const age = Date.now() - new Date(machine.lastSeenAt).getTime();
  if (!Number.isFinite(age)) return "unknown";
  return age < 2 * 60_000 ? "live" : "stale";
}

function presenceLabel(presence: "live" | "stale" | "unknown"): string {
  return presence === "live" ? "live" : presence === "stale" ? "stale" : "not seen yet";
}

function StatusPill({
  tone,
  children,
}: {
  readonly tone: "ok" | "warn" | "bad" | "muted";
  readonly children: React.ReactNode;
}) {
  const className =
    tone === "ok"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      : tone === "warn"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
        : tone === "bad"
          ? "bg-destructive/15 text-destructive"
          : "bg-muted text-muted-foreground";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>
  );
}

export function WorkspaceSettings() {
  const workspaceEnabled = useFeatureFlag("workspace");
  const queryClient = useQueryClient();
  // The primary daemon is the registry client: the panel describes one
  // workspace regardless of which machine's chat is on screen.
  const registryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironments = useSavedEnvironmentRegistryStore((state) => state.byId);

  const stateQuery = useQuery(workspaceStateQueryOptions(registryEnvironmentId));
  const cloudQuery = useQuery(unoCloudStateQueryOptions(registryEnvironmentId));

  const syncMachines = useMutation(
    workspaceSyncMachinesMutationOptions(registryEnvironmentId, queryClient),
  );
  const updateMachine = useMutation(
    workspaceUpdateMachineMutationOptions(registryEnvironmentId, queryClient),
  );
  const removeMachine = useMutation(
    workspaceRemoveMachineMutationOptions(registryEnvironmentId, queryClient),
  );
  const releaseClaim = useMutation(
    workspaceReleaseClaimMutationOptions(registryEnvironmentId, queryClient),
  );
  const setPolicy = useMutation(
    workspaceSetPolicyMutationOptions(registryEnvironmentId, queryClient),
  );
  const upsertGrant = useMutation(
    workspaceUpsertGrantMutationOptions(registryEnvironmentId, queryClient),
  );
  const removeGrant = useMutation(
    workspaceRemoveGrantMutationOptions(registryEnvironmentId, queryClient),
  );
  const boxPower = useMutation(unoCloudBoxPowerMutationOptions(registryEnvironmentId, queryClient));
  const decideRequest = useMutation(
    workspaceDecideRequestMutationOptions(registryEnvironmentId, queryClient),
  );
  const renameWorkspace = useMutation(
    workspaceRenameMutationOptions(registryEnvironmentId, queryClient),
  );

  const state = stateQuery.data;
  const cloud = cloudQuery.data;

  const knownMachineIds = useMemo(
    () => new Set((state?.machines ?? []).map((machine) => machine.environmentId)),
    [state],
  );

  const connectionCandidates = useMemo(
    () =>
      Object.values(savedEnvironments).map((record) => ({
        environmentId: record.environmentId,
        label: record.label,
        lastConnectedAt: record.lastConnectedAt,
      })),
    [savedEnvironments],
  );

  const handleSyncConnections = useCallback(() => {
    if (!registryEnvironmentId) return;
    syncMachines.mutate({
      machines: [
        {
          environmentId: registryEnvironmentId,
          label: "This machine",
          kind: "local" as const,
          lastSeenAt: new Date().toISOString(),
        },
        ...connectionCandidates
          .filter((candidate) => candidate.environmentId !== registryEnvironmentId)
          .map((candidate) => ({
            environmentId: candidate.environmentId,
            label: candidate.label,
            kind: "ssh" as const,
            lastSeenAt: candidate.lastConnectedAt,
          })),
      ],
      registryEnvironmentId,
    });
  }, [connectionCandidates, registryEnvironmentId, syncMachines]);

  const handleAddBox = useCallback(
    (box: UnoBox) => {
      if (!registryEnvironmentId) return;
      // A box joins the registry under its control-plane identity, so the row
      // survives the box being re-paired later under a different SSH endpoint.
      syncMachines.mutate({
        machines: [
          {
            environmentId: `uno-box-${box.id}` as EnvironmentId,
            label: box.name,
            kind: "uno_box" as const,
            unoBoxId: box.id,
            // Null, even for a running box: "the control plane says it is up"
            // is not "this workspace has heard from it". Presence starts at
            // "not seen yet" and only a real connection moves it.
            lastSeenAt: null,
          },
        ],
      });
    },
    [registryEnvironmentId, syncMachines],
  );

  if (!workspaceEnabled) {
    return <FeatureDisabledPanel feature="Workspaces" />;
  }

  if (!registryEnvironmentId) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Workspace">
          <p className="px-1 text-sm text-muted-foreground">
            No daemon connection yet — the workspace registry lives on a daemon, so there is nothing
            to show until one is connected.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  const unreachableMachines = (state?.machines ?? []).filter(
    (machine) => machinePresence(machine) !== "live",
  ).length;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Workspace">
        <SettingsRow
          title="Name"
          description="Shown in the sidebar switcher. Every machine in the workspace reads the same one."
          control={
            <Input
              aria-label="Workspace name"
              className="w-full sm:w-64"
              // Uncontrolled with a key, so a rename from another client
              // replaces the field instead of fighting the text being typed.
              key={state?.identity.name ?? "workspace"}
              defaultValue={state?.identity.name ?? ""}
              placeholder="UNO"
              onBlur={(event) => {
                const next = event.currentTarget.value.trim();
                if (next.length === 0 || next === state?.identity.name) return;
                renameWorkspace.mutate({ name: next });
              }}
            />
          }
        />

        <SettingsRow
          title={state?.identity.name ?? "Workspace"}
          description={
            stateQuery.isError
              ? "The registry could not be read. Everything below is unavailable, not empty."
              : `Revision ${state?.identity.epoch ?? 0} · updated ${formatRelative(state?.identity.updatedAt ?? null)}`
          }
          control={
            <div className="flex items-center gap-2">
              {stateQuery.isError ? (
                <StatusPill tone="bad">registry unreachable</StatusPill>
              ) : unreachableMachines > 0 ? (
                <StatusPill tone="warn">
                  degraded: {unreachableMachines} of {state?.machines.length ?? 0} not live
                </StatusPill>
              ) : (
                <StatusPill tone="ok">healthy</StatusPill>
              )}
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all });
                }}
              >
                <RefreshCwIcon className="size-3.5" />
                Refresh
              </Button>
            </div>
          }
        />

        <SettingsRow
          title="Uno account"
          description={
            cloud?.connected
              ? `${cloud.account?.username ?? "account"}${cloud.account?.email ? ` · ${cloud.account.email}` : ""} · balance $${(cloud.account?.balance ?? 0).toFixed(2)} · LLM $${(cloud.account?.llmBalance ?? 0).toFixed(2)}`
              : cloudQuery.isPending
                ? "Asking the control plane who this account is…"
                : "Not linked. Add an Uno API key in Settings → General to see this account's boxes here."
          }
          control={
            cloud?.error ? (
              <StatusPill tone="warn">{cloud.error.slice(0, 40)}</StatusPill>
            ) : cloud?.connected ? (
              <StatusPill tone="ok">linked</StatusPill>
            ) : cloudQuery.isPending ? (
              // An unanswered first request is not evidence of an unlinked
              // account, and saying "not linked" here sends the user off to
              // paste a key they already have.
              <StatusPill tone="muted">checking…</StatusPill>
            ) : (
              <StatusPill tone="muted">not linked</StatusPill>
            )
          }
        />
      </SettingsSection>

      <SettingsSection title="Machines">
        <SettingsRow
          title="Machines in this workspace"
          description="Connections this client knows about can be adopted into the registry, so every machine reads the same rules."
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={syncMachines.isPending}
              onClick={handleSyncConnections}
            >
              Adopt connections
            </Button>
          }
        />

        <div className="flex flex-col gap-2 px-1 pb-2">
          {(state?.machines ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No machines yet. “Adopt connections” registers this daemon and every saved connection.
            </p>
          ) : null}
          {(state?.machines ?? []).map((machine) => {
            const presence = machinePresence(machine);
            return (
              <div
                key={machine.environmentId}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2"
              >
                <MachineChip
                  identity={{
                    environmentId: machine.environmentId,
                    label: machine.label,
                    monogram: machine.monogram,
                    colorSlot: machine.colorSlot,
                    isMonogramOverridden: true,
                  }}
                  size="lg"
                  detail={presenceLabel(presence)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{machine.label}</span>
                    {machine.kind === "uno_box" ? (
                      <CloudIcon className="size-3.5 text-muted-foreground" />
                    ) : machine.kind === "local" ? (
                      <MonitorIcon className="size-3.5 text-muted-foreground" />
                    ) : (
                      <ServerIcon className="size-3.5 text-muted-foreground" />
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {machine.environmentId} · seen {formatRelative(machine.lastSeenAt)}
                  </p>
                </div>

                <Input
                  aria-label={`Monogram for ${machine.label}`}
                  className="w-16"
                  defaultValue={machine.monogram}
                  maxLength={2}
                  onBlur={(event) => {
                    const next = event.currentTarget.value.trim();
                    if (next.length === 0 || next === machine.monogram) return;
                    updateMachine.mutate({
                      environmentId: machine.environmentId,
                      monogram: next,
                    });
                  }}
                />

                <div className="flex items-center gap-1">
                  {MACHINE_COLOR_CHOICES.map((choice) => {
                    const taken = (state?.machines ?? []).some(
                      (other) =>
                        other.environmentId !== machine.environmentId &&
                        other.colorSlot === choice.slot &&
                        choice.slot !== 0,
                    );
                    return (
                      <button
                        key={choice.slot}
                        type="button"
                        // Colliding hues are flagged, never blocked: the user
                        // decides whether two machines they can tell apart by
                        // name need different colours.
                        title={
                          taken ? `${choice.label} — already used by another machine` : choice.label
                        }
                        aria-label={choice.label}
                        aria-pressed={machine.colorSlot === choice.slot}
                        className={`size-5 rounded-md border ${
                          machine.colorSlot === choice.slot
                            ? "border-foreground"
                            : "border-transparent"
                        } ${
                          choice.slot === 0
                            ? "bg-muted"
                            : choice.slot === 1
                              ? "bg-machine-1/40"
                              : choice.slot === 2
                                ? "bg-machine-2/40"
                                : "bg-machine-3/40"
                        } ${taken ? "opacity-60 ring-1 ring-amber-500/60" : ""}`}
                        onClick={() =>
                          updateMachine.mutate({
                            environmentId: machine.environmentId,
                            colorSlot: choice.slot,
                          })
                        }
                      />
                    );
                  })}
                </div>

                <StatusPill
                  tone={presence === "live" ? "ok" : presence === "stale" ? "warn" : "muted"}
                >
                  {presenceLabel(presence)}
                </StatusPill>

                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Remove ${machine.label}`}
                  onClick={() => removeMachine.mutate({ environmentId: machine.environmentId })}
                >
                  <TrashIcon className="size-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection title="Uno boxes">
        <SettingsRow
          title="Boxes on this account"
          description="A box is a machine this app can wake. Adopting one adds it to the registry; connecting it is done from Settings → Connections with the SSH endpoint shown here."
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() => void cloudQuery.refetch()}
              disabled={cloudQuery.isFetching}
            >
              <RefreshCwIcon className="size-3.5" />
              Refresh
            </Button>
          }
        />
        <div className="flex flex-col gap-2 px-1 pb-2">
          {!cloud?.connected ? (
            <p className="text-sm text-muted-foreground">
              {cloudQuery.isPending ? "Loading boxes…" : "Link an Uno account to list boxes."}
            </p>
          ) : cloud.boxes.length === 0 ? (
            <p className="text-sm text-muted-foreground">This account has no boxes yet.</p>
          ) : null}
          {(cloud?.boxes ?? []).map((box) => {
            const sshTarget = parseUnoBoxSshTarget(box.ssh);
            const adopted = knownMachineIds.has(`uno-box-${box.id}` as EnvironmentId);
            return (
              <div
                key={box.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2"
              >
                <MachineChip
                  identity={{
                    environmentId: `uno-box-${box.id}` as EnvironmentId,
                    label: box.name,
                    monogram: deriveMachineMonogram(box.name),
                    colorSlot: 0,
                    isMonogramOverridden: false,
                  }}
                  size="lg"
                  withoutTooltip
                />
                <div className="min-w-0 flex-1">
                  <span className="truncate text-sm font-medium">{box.name}</span>
                  <p className="truncate text-xs text-muted-foreground">
                    {box.vcpu} vCPU · {box.ramMb} MB · {box.diskGb} GB
                    {sshTarget
                      ? ` · ssh ${sshTarget.user}@${sshTarget.host}:${sshTarget.port}`
                      : " · no SSH endpoint yet"}
                  </p>
                </div>
                <StatusPill
                  tone={box.status === "running" ? "ok" : box.status === "error" ? "bad" : "muted"}
                >
                  {box.status}
                </StatusPill>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={boxPower.isPending}
                  onClick={() =>
                    boxPower.mutate({
                      boxId: box.id,
                      action: box.status === "running" ? "sleep" : "wake",
                    })
                  }
                >
                  {box.status === "running" ? "Sleep" : "Wake"}
                </Button>
                <Button
                  size="xs"
                  variant={adopted ? "ghost" : "outline"}
                  disabled={adopted || syncMachines.isPending}
                  onClick={() => handleAddBox(box)}
                >
                  {adopted ? "In workspace" : "Adopt"}
                </Button>
              </div>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection title="Claims and budget">
        <SettingsRow
          title="Cross-environment budget"
          description="Budgets are per workspace, not per token: a loop is made of individually authorised calls."
          control={
            <div className="flex items-center gap-2 text-sm">
              <StatusPill tone="muted">
                {state?.usage.crossEnvironmentTurnsLastHour ?? 0} /{" "}
                {state?.policy.crossEnvironmentTurnsPerHour ?? 0} per hour
              </StatusPill>
              <StatusPill tone="muted">
                {state?.usage.concurrentCrossEnvironment ?? 0} /{" "}
                {state?.policy.maxConcurrentCrossEnvironment ?? 0} at once
              </StatusPill>
            </div>
          }
        />
        <div className="flex flex-col gap-2 px-1 pb-2">
          {(state?.claims ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing is claimed right now.</p>
          ) : null}
          {(state?.claims ?? []).map((claim) => (
            <div
              key={claim.claimId}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <span className="truncate text-sm font-medium">{claim.claimKey}</span>
                <p className="truncate text-xs text-muted-foreground">
                  held by {claim.holderEnvironmentId} · expires {formatRelative(claim.expiresAt)}
                  {claim.reason ? ` · ${claim.reason}` : ""}
                </p>
              </div>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  releaseClaim.mutate({ claimKey: claim.claimKey, holderEnvironmentId: null })
                }
              >
                Take back
              </Button>
            </div>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="Requests from other machines">
        <SettingsRow
          title="Pending"
          description="Each one is approved separately. A standing permission is a grant, not a button on this dialog — the moment you are deciding a single request is the worst moment to widen a permission permanently."
          control={
            <StatusPill tone={(state?.pendingRequests ?? []).length > 0 ? "warn" : "muted"}>
              {(state?.pendingRequests ?? []).length} waiting
            </StatusPill>
          }
        />
        <div className="flex flex-col gap-2 px-1 pb-2">
          {(state?.pendingRequests ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing is waiting for a decision.</p>
          ) : null}
          {(state?.pendingRequests ?? []).map((request) => (
            <div
              key={request.requestId}
              className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">
                  {request.fromEnvironmentId} wants to{" "}
                  {request.kind === "post_message"
                    ? "post a message"
                    : request.kind === "create_thread"
                      ? "create a chat"
                      : "read a transcript"}
                </span>
                <StatusPill tone="muted">
                  {request.hops} of {state?.policy.maxForwardHops ?? 0} forwards
                </StatusPill>
                <StatusPill tone="muted">expires {formatRelative(request.expiresAt)}</StatusPill>
              </div>
              <p className="text-xs text-muted-foreground">
                {request.repositoryKey}
                {request.threadId ? ` · ${request.threadId}` : ""}
                {request.reason ? ` · “${request.reason}”` : ""}
              </p>
              {request.payloadPreview.trim().length > 0 ? (
                <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
                  {request.payloadPreview}
                </pre>
              ) : null}
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  disabled={decideRequest.isPending}
                  onClick={() =>
                    decideRequest.mutate({ requestId: request.requestId, decision: "approve" })
                  }
                >
                  Allow once
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={decideRequest.isPending}
                  onClick={() =>
                    decideRequest.mutate({ requestId: request.requestId, decision: "reject" })
                  }
                >
                  Refuse
                </Button>
              </div>
            </div>
          ))}
        </div>
      </SettingsSection>

      <WorkspaceRulesSection
        state={state ?? null}
        onSetPolicy={(policy) => setPolicy.mutate({ policy })}
        onRemoveGrant={(grantId) => removeGrant.mutate({ grantId })}
        onAddGrant={(input) => upsertGrant.mutate(input)}
      />

      <WorkspaceInstructionsSection
        registryEnvironmentId={registryEnvironmentId}
        state={state ?? null}
      />
    </SettingsPageContainer>
  );
}

function WorkspaceRulesSection({
  state,
  onSetPolicy,
  onRemoveGrant,
  onAddGrant,
}: {
  readonly state: WorkspaceState | null;
  readonly onSetPolicy: (policy: WorkspacePolicy) => void;
  readonly onRemoveGrant: (grantId: string) => void;
  readonly onAddGrant: (input: {
    readonly fromEnvironmentId: string;
    readonly toEnvironmentId: string;
    readonly repositoryKey: string;
    readonly capabilities: readonly WorkspaceCapability[];
    readonly transport: "direct" | "registry";
    readonly mode: WorkspacePolicy["crossEnvironmentWrite"];
    readonly requiresClaim: boolean;
  }) => void;
}) {
  const policy = state?.policy;
  const [draftFrom, setDraftFrom] = useState("*");
  const [draftTo, setDraftTo] = useState("*");
  const [draftRepository, setDraftRepository] = useState("*");
  const [draftMode, setDraftMode] = useState<WorkspacePolicy["crossEnvironmentWrite"]>("request");
  const [draftCapabilities, setDraftCapabilities] = useState<readonly WorkspaceCapability[]>([
    "view_status",
  ]);

  if (!policy) return null;

  return (
    <SettingsSection title="Rules">
      <SettingsRow
        title="How another machine may write here"
        description="The default is a request a human approves. A standing permission is a grant below — the approval dialog never offers “always”."
        control={
          <div className="flex items-center gap-1">
            {WRITE_MODE_CHOICES.map((choice) => (
              <Button
                key={choice.value}
                size="xs"
                variant={policy.crossEnvironmentWrite === choice.value ? "default" : "outline"}
                onClick={() => onSetPolicy({ ...policy, crossEnvironmentWrite: choice.value })}
              >
                {choice.label}
              </Button>
            ))}
          </div>
        }
      />

      <SettingsRow
        title="Accept commands from other machines"
        description="Master switch. Off refuses every peer command before any grant is consulted."
        control={
          <Switch
            checked={policy.acceptPeerCommands}
            onCheckedChange={(checked) =>
              onSetPolicy({ ...policy, acceptPeerCommands: checked === true })
            }
          />
        }
      />

      <SettingsRow
        title="Chain limits"
        description="Guards against “HK pushes CM, CM pushes HK” running all night."
        control={
          <div className="flex items-center gap-2">
            <Input
              aria-label="Maximum forwards"
              className="w-20"
              type="number"
              min={0}
              defaultValue={policy.maxForwardHops}
              onBlur={(event) => {
                const next = Number.parseInt(event.currentTarget.value, 10);
                if (!Number.isFinite(next) || next === policy.maxForwardHops) return;
                onSetPolicy({ ...policy, maxForwardHops: Math.max(next, 0) });
              }}
            />
            <span className="text-xs text-muted-foreground">forwards</span>
            <Input
              aria-label="Cross-environment turns per hour"
              className="w-24"
              type="number"
              min={0}
              defaultValue={policy.crossEnvironmentTurnsPerHour}
              onBlur={(event) => {
                const next = Number.parseInt(event.currentTarget.value, 10);
                if (!Number.isFinite(next) || next === policy.crossEnvironmentTurnsPerHour) return;
                onSetPolicy({ ...policy, crossEnvironmentTurnsPerHour: Math.max(next, 0) });
              }}
            />
            <span className="text-xs text-muted-foreground">turns / hour</span>
          </div>
        }
      />

      <div className="flex flex-col gap-2 px-1 pb-2">
        {(state?.grants ?? []).map((grant) => (
          <div
            key={grant.grantId}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <span className="truncate text-sm font-medium">
                {grant.fromEnvironmentId} → {grant.toEnvironmentId}
              </span>
              <p className="truncate text-xs text-muted-foreground">
                {grant.repositoryKey === "*" ? "all repositories" : grant.repositoryKey} ·{" "}
                {grant.transport === "registry" ? "through the registry" : "direct"} ·{" "}
                {grant.capabilities.map((capability) => CAPABILITY_LABELS[capability]).join(", ") ||
                  "no capabilities"}
                {grant.requiresClaim ? " · needs the claim" : ""}
              </p>
            </div>
            <StatusPill
              tone={grant.mode === "deny" ? "bad" : grant.mode === "allow" ? "ok" : "warn"}
            >
              {grant.mode === "deny"
                ? "denied"
                : grant.mode === "allow"
                  ? "straight through"
                  : "by request"}
            </StatusPill>
            <Button size="xs" variant="ghost" onClick={() => onRemoveGrant(grant.grantId)}>
              <TrashIcon className="size-3.5" />
            </Button>
          </div>
        ))}

        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-border px-3 py-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            From
            <Input
              className="w-40"
              value={draftFrom}
              onChange={(e) => setDraftFrom(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            To
            <Input className="w-40" value={draftTo} onChange={(e) => setDraftTo(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Repository
            <Input
              className="w-40"
              value={draftRepository}
              onChange={(e) => setDraftRepository(e.target.value)}
            />
          </label>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            Capabilities
            <div className="flex flex-wrap gap-1">
              {(Object.keys(CAPABILITY_LABELS) as WorkspaceCapability[]).map((capability) => (
                <Button
                  key={capability}
                  size="xs"
                  variant={draftCapabilities.includes(capability) ? "default" : "outline"}
                  onClick={() =>
                    setDraftCapabilities((current) =>
                      current.includes(capability)
                        ? current.filter((entry) => entry !== capability)
                        : [...current, capability],
                    )
                  }
                >
                  {CAPABILITY_LABELS[capability]}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            Mode
            <div className="flex gap-1">
              {WRITE_MODE_CHOICES.map((choice) => (
                <Button
                  key={choice.value}
                  size="xs"
                  variant={draftMode === choice.value ? "default" : "outline"}
                  onClick={() => setDraftMode(choice.value)}
                >
                  {choice.label}
                </Button>
              ))}
            </div>
          </div>
          <Button
            size="xs"
            onClick={() =>
              onAddGrant({
                fromEnvironmentId: draftFrom.trim() || "*",
                toEnvironmentId: draftTo.trim() || "*",
                repositoryKey: draftRepository.trim() || "*",
                capabilities: draftCapabilities,
                transport: "direct",
                mode: draftMode,
                requiresClaim: draftMode !== "deny" && draftCapabilities.includes("write"),
              })
            }
          >
            Add grant
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}
