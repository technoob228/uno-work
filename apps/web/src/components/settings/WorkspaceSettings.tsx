/**
 * "My machines" — the plain list of every computer and box this app can send
 * work to, with the two things a person actually does here: add a box, or
 * connect their own computer.
 *
 * Underneath sits the workspace registry: which machines are adopted, which
 * Uno account backs it, what is claimed right now, and the rules under which
 * one machine may act on another. That is real and stays — but it is folded
 * into "Advanced sharing" at the bottom, because a first-time user opening
 * this page should see machines, not grants.
 *
 * Degradation is still loud. A registry that cannot be reached looks exactly
 * like a healthy one unless the panel says otherwise, and silent staleness is
 * the failure we have already been bitten by with tunnels.
 */
import { isAssistantProjectId, parseUnoBoxSshTarget, type UnoBox } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import {
  ChevronDownIcon,
  CloudIcon,
  LaptopIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  RefreshCwIcon,
  StarIcon,
  SunIcon,
  TrashIcon,
  XIcon,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { usePrimaryEnvironmentDescriptor } from "../../environments/primary";
import {
  removeSavedEnvironment,
  useSavedEnvironmentRegistryStore,
} from "../../environments/runtime";
import { useDefaultEnvironment } from "../../hooks/useDefaultEnvironment";
import { useMachineRows } from "../../hooks/useMachineRows";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { deriveMachineKind, registryKindForMachineKind } from "../../machineKind";
import {
  unoCloudBoxPowerMutationOptions,
  unoCloudStateQueryOptions,
  workspaceQueryKeys,
  workspaceRenameMutationOptions,
  workspaceRemoveMachineMutationOptions,
  workspaceStateQueryOptions,
  workspaceSyncMachinesMutationOptions,
  workspaceUpdateMachineMutationOptions,
} from "../../lib/workspaceReactQuery";
import { useFeatureFlag } from "../../hooks/useFeatureFlags";
import {
  localDaemonEnvironmentLabel,
  useLocalDaemonDiscovery,
  useUseThisComputer,
} from "../../hooks/useLocalDaemon";
import { useSwitchEnvironment } from "../../hooks/useSwitchEnvironment";
import { readLocalApi } from "../../localApi";
import { MACHINE_KIND_LABELS, MACHINE_STATUS_LABELS, plainExplanation } from "../../plainLanguage";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { AddEnvModal } from "../AddEnvModal";
import { Explain } from "../Explain";
import { MachineChip } from "../MachineChip";
import { MACHINE_KIND_ICON } from "../machineKindIcons";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Input } from "../ui/input";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { formatRelativeTime, registryIdForBox, type MachineRow } from "./machineRows";
import { WorkspaceInstructionsSection } from "./WorkspaceInstructions";

const MACHINE_COLOR_CHOICES = [
  { slot: 0, label: "Neutral" },
  { slot: 1, label: "Hue 1" },
  { slot: 2, label: "Hue 2" },
  { slot: 3, label: "Hue 3" },
] as const;

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

function MachineStatusPill({ status }: { readonly status: MachineRow["status"] }) {
  const tone =
    status === "online"
      ? "ok"
      : status === "sleeping"
        ? "warn"
        : status === "offline"
          ? "bad"
          : "muted";
  return <StatusPill tone={tone}>{MACHINE_STATUS_LABELS[status]}</StatusPill>;
}

function formatProjects(projects: ReadonlyArray<string>): string {
  if (projects.length === 0) return "No projects yet";
  const shown = projects.slice(0, 3).join(", ");
  const more = projects.length - 3;
  return more > 0 ? `Projects: ${shown} +${more}` : `Projects: ${shown}`;
}

export function WorkspaceSettings() {
  // The advanced registry (grants, claims, requests, instruction layers) is
  // still behind the Labs flag. The machines list itself is always on.
  const advancedEnabled = useFeatureFlag("workspace");
  const queryClient = useQueryClient();
  // The primary daemon is the registry client: the panel describes one
  // workspace regardless of which machine's chat is on screen.
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const registryEnvironmentId = primaryDescriptor?.environmentId ?? null;
  const savedEnvironments = useSavedEnvironmentRegistryStore((state) => state.byId);
  const now = useRelativeTimeTick(30_000);
  const {
    explicitDefaultId,
    candidates: defaultCandidates,
    shouldOfferChoice,
    setDefaultEnvironment,
  } = useDefaultEnvironment();
  const defaultPromptDismissed = useSettings(
    (settings) => settings.defaultEnvironmentPromptDismissed,
  );
  const { updateSettings } = useUpdateSettings();

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
  const boxPower = useMutation(unoCloudBoxPowerMutationOptions(registryEnvironmentId, queryClient));
  const renameWorkspace = useMutation(
    workspaceRenameMutationOptions(registryEnvironmentId, queryClient),
  );

  const state = stateQuery.data;
  const cloud = cloudQuery.data;

  const [addModal, setAddModal] = useState<{
    readonly open: boolean;
    readonly step: "uno" | "custom";
  }>({ open: false, step: "uno" });
  const [removingKey, setRemovingKey] = useState<string | null>(null);

  // Which machine the chats on screen belong to; the switch button is hidden
  // on that row. Falls back to the primary daemon before anything is chosen.
  const activeEnvironmentId = useStore((store) => store.activeEnvironmentId);
  const currentEnvironmentId = activeEnvironmentId ?? registryEnvironmentId;
  const switchEnvironment = useSwitchEnvironment();

  // Browser build only: a Uno Work desktop running on this very computer.
  // Probed once per session when this page opens, and again on Refresh.
  const localDaemonDiscovery = useLocalDaemonDiscovery();
  const useThisComputer = useUseThisComputer();
  const localDaemon = localDaemonDiscovery.daemon;
  const unlinkedLocalDaemon =
    localDaemon && !savedEnvironments[localDaemon.environmentId] ? localDaemon : null;

  const allProjects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const projectNamesByEnvironmentId = useMemo(() => {
    const next = new Map<string, string[]>();
    for (const project of allProjects) {
      // The assistant's home project is plumbing, not something the user put there.
      if (isAssistantProjectId(project.id)) continue;
      const existing = next.get(project.environmentId);
      if (existing) existing.push(project.name);
      else next.set(project.environmentId, [project.name]);
    }
    return next;
  }, [allProjects]);

  const connectionCandidates = useMemo(
    () =>
      Object.values(savedEnvironments).map((record) => ({
        environmentId: record.environmentId,
        label: record.label,
        lastConnectedAt: record.lastConnectedAt,
      })),
    [savedEnvironments],
  );

  // The same fold the sidebar switcher and Settings "Applies to" read, so a
  // machine is the same kind everywhere; this page adds project names.
  const rows = useMachineRows({ projectNamesByEnvironmentId, now });

  const handleSyncConnections = useCallback(() => {
    if (!registryEnvironmentId) return;
    // The daemon registers as what it says it is (a box as a box), never as
    // "local" merely because it is the one doing the registering.
    const primaryKind = registryKindForMachineKind(
      deriveMachineKind({ descriptor: primaryDescriptor }),
    );
    syncMachines.mutate({
      machines: [
        {
          environmentId: registryEnvironmentId,
          label: primaryDescriptor?.label ?? "This machine",
          kind: primaryKind,
          ...(primaryKind === "uno_box" && primaryDescriptor?.unoBoxId != null
            ? { unoBoxId: primaryDescriptor.unoBoxId }
            : {}),
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
  }, [connectionCandidates, primaryDescriptor, registryEnvironmentId, syncMachines]);

  const handleAddBox = useCallback(
    (box: UnoBox) => {
      if (!registryEnvironmentId) return;
      // A box joins the registry under its control-plane identity, so the row
      // survives the box being re-paired later under a different SSH endpoint.
      syncMachines.mutate({
        machines: [
          {
            environmentId: registryIdForBox(box.id),
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

  const handleRemove = useCallback(
    async (row: MachineRow) => {
      if (row.isPrimary || !row.environmentId) return;
      const message = [
        `Remove ${row.label} from your machines?`,
        "Nothing on the machine is deleted. You can connect it again later.",
      ].join("\n");
      const api = readLocalApi();
      const confirmed = api ? await api.dialogs.confirm(message) : window.confirm(message);
      if (!confirmed) return;
      setRemovingKey(row.key);
      try {
        if (row.inRegistry) {
          await removeMachine.mutateAsync({ environmentId: row.environmentId });
        }
        if (row.isSavedConnection) {
          await removeSavedEnvironment(row.environmentId);
        }
      } finally {
        setRemovingKey(null);
      }
    },
    [removeMachine],
  );

  const openAddBox = () => setAddModal({ open: true, step: "uno" });
  const openConnectComputer = () => setAddModal({ open: true, step: "custom" });

  const addModalElement = (
    <AddEnvModal
      open={addModal.open}
      initialStep={addModal.step}
      onOpenChange={(open) => setAddModal((current) => ({ ...current, open }))}
    />
  );

  if (!registryEnvironmentId) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="My machines" titleAddon={<Explain term="myMachines" technical />}>
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <p className="text-sm text-foreground">No machine connected yet.</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              A machine is {plainExplanation("machine").replace(/\.$/u, "").toLowerCase()}. Connect
              one and it appears here.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button size="sm" onClick={openAddBox}>
                <CloudIcon className="size-3.5" />
                Add a box
              </Button>
              <Button size="sm" variant="outline" onClick={openConnectComputer}>
                <LaptopIcon className="size-3.5" />
                Connect my computer
              </Button>
            </div>
          </div>
        </SettingsSection>
        {addModalElement}
      </SettingsPageContainer>
    );
  }

  const unreachableMachines = rows.filter((row) => row.status !== "online").length;

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="My machines"
        titleAddon={<Explain term="myMachines" technical />}
        headerAction={
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all });
              void cloudQuery.refetch();
              void localDaemonDiscovery.refresh();
            }}
            disabled={
              stateQuery.isFetching || cloudQuery.isFetching || localDaemonDiscovery.isProbing
            }
          >
            <RefreshCwIcon
              className={`size-3.5 ${stateQuery.isFetching || cloudQuery.isFetching || localDaemonDiscovery.isProbing ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        }
      >
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              Where your agents run
              <Explain term="machine" />
            </span>
          }
          description="Your own computer, an Uno box, or any other machine you connect. Each one keeps its own projects and agents."
          control={
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={openAddBox}>
                <CloudIcon className="size-3.5" />
                Add a box
              </Button>
              <Button size="sm" variant="outline" onClick={openConnectComputer}>
                <LaptopIcon className="size-3.5" />
                Connect my computer
              </Button>
            </div>
          }
        />

        {stateQuery.isError ? (
          <div className="border-t border-border/60 px-4 py-3 sm:px-5">
            <StatusPill tone="bad">machine list unreachable</StatusPill>
            <span className="ml-2 text-xs text-muted-foreground">
              The list could not be read from this computer. What you see below may be incomplete,
              not empty.
            </span>
          </div>
        ) : null}

        <div className="flex flex-col gap-2 border-t border-border/60 px-4 py-3 sm:px-5">
          {shouldOfferChoice && !defaultPromptDismissed ? (
            <div
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2"
              data-testid="choose-default-machine-banner"
              role="status"
            >
              <StarIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Choose your default machine</div>
                <p className="text-xs text-muted-foreground">
                  The app opens on it and offers it first for new projects and chats. Until you pick
                  one, it uses an online computer of yours, or the machine serving this page.
                </p>
              </div>
              <Menu>
                <MenuTrigger render={<Button size="xs" />}>
                  <StarIcon className="size-3.5" />
                  Pick
                </MenuTrigger>
                <MenuPopup align="end" className="min-w-56">
                  {defaultCandidates.map((candidate) => {
                    const KindIcon = MACHINE_KIND_ICON[candidate.kind];
                    return (
                      <MenuItem
                        key={candidate.environmentId}
                        onClick={() => setDefaultEnvironment(candidate.environmentId)}
                      >
                        <KindIcon className="size-4 text-muted-foreground" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">{candidate.label}</span>
                          <span className="truncate text-[11px] text-muted-foreground">
                            {MACHINE_KIND_LABELS[candidate.kind]}
                            {candidate.online ? "" : " · offline"}
                          </span>
                        </span>
                      </MenuItem>
                    );
                  })}
                </MenuPopup>
              </Menu>
              <Button
                size="xs"
                variant="ghost"
                aria-label="Dismiss"
                title="Not now"
                onClick={() => updateSettings({ defaultEnvironmentPromptDismissed: true })}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          ) : null}
          {unlinkedLocalDaemon ? (
            <div
              className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2"
              data-testid="use-this-computer-row"
            >
              <LaptopIcon className="size-5 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">This computer</span>
                  <span className="text-[11px] text-muted-foreground">
                    {MACHINE_KIND_LABELS.computer}
                  </span>
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  Uno Work is running here ({unlinkedLocalDaemon.label}). Use it and this browser
                  can run projects and agents on this computer — after you press Allow in the app.
                </p>
              </div>
              {useThisComputer.isBusy ? (
                <>
                  <span className="text-xs text-muted-foreground">
                    {useThisComputer.phase.kind === "waiting-for-approval"
                      ? "Waiting for Allow in Uno Work on this computer…"
                      : "Connecting…"}
                  </span>
                  <Button size="xs" variant="ghost" onClick={useThisComputer.cancel}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button size="xs" onClick={() => void useThisComputer.run(unlinkedLocalDaemon)}>
                  <LaptopIcon className="size-3.5" />
                  Use this computer
                </Button>
              )}
            </div>
          ) : null}
          {rows.length === 0 && !unlinkedLocalDaemon ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <p className="text-sm text-foreground">No machines yet.</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                A machine is {plainExplanation("machine").replace(/\.$/u, "").toLowerCase()}. Add a
                box to get one in about a minute.
              </p>
              <Button size="sm" onClick={openAddBox}>
                <CloudIcon className="size-3.5" />
                Add a box
              </Button>
            </div>
          ) : null}
          {rows.map((row) => {
            const KindIcon = MACHINE_KIND_ICON[row.kind];
            const canWake = row.box !== null;
            const isRunning = row.status === "online";
            return (
              <div
                key={row.key}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2"
              >
                <MachineChip
                  identity={row.identity}
                  size="lg"
                  detail={row.detail}
                  kind={row.kind}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{row.label}</span>
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                      <KindIcon className="size-3.5" />
                      {MACHINE_KIND_LABELS[row.kind]}
                    </span>
                    {row.isDefault ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-primary">
                        <StarIcon className="size-3 fill-current" aria-hidden="true" />
                        Default
                      </span>
                    ) : null}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {row.detail} · {formatProjects(row.projects)}
                  </p>
                </div>

                <MachineStatusPill status={row.status} />

                {row.environmentId && (row.isPrimary || row.isSavedConnection) ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-pressed={row.isDefault}
                    aria-label={
                      row.isDefault
                        ? `Stop using ${row.label} as the default machine`
                        : `Make ${row.label} the default machine`
                    }
                    title={row.isDefault ? "Default machine" : "Make this the default machine"}
                    className={row.isDefault ? "text-primary" : "text-muted-foreground"}
                    onClick={() =>
                      setDefaultEnvironment(
                        explicitDefaultId === row.environmentId ? null : row.environmentId!,
                      )
                    }
                  >
                    <StarIcon className={`size-3.5 ${row.isDefault ? "fill-current" : ""}`} />
                    {row.isDefault ? "Default" : "Set as default"}
                  </Button>
                ) : null}

                {row.environmentId &&
                row.environmentId !== currentEnvironmentId &&
                (row.isPrimary || row.isSavedConnection) ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => switchEnvironment(row.environmentId!)}
                    title={
                      localDaemon && row.environmentId === localDaemon.environmentId
                        ? localDaemonEnvironmentLabel(localDaemon)
                        : `Show ${row.label}'s projects and chats`
                    }
                  >
                    <MonitorIcon className="size-3.5" />
                    Switch to this machine
                  </Button>
                ) : null}

                {canWake && row.box ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={boxPower.isPending}
                    onClick={() =>
                      boxPower.mutate({
                        boxId: row.box!.id,
                        action: isRunning ? "sleep" : "wake",
                      })
                    }
                  >
                    {isRunning ? (
                      <MoonIcon className="size-3.5" />
                    ) : (
                      <SunIcon className="size-3.5" />
                    )}
                    {isRunning ? "Sleep" : "Wake"}
                  </Button>
                ) : null}

                {!row.environmentId && row.box ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={syncMachines.isPending}
                    onClick={() => handleAddBox(row.box!)}
                  >
                    <PlusIcon className="size-3.5" />
                    Add to my machines
                  </Button>
                ) : null}

                {row.isPrimary || !row.environmentId ? null : (
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Remove ${row.label}`}
                    title="Remove from my machines"
                    disabled={removingKey === row.key}
                    onClick={() => void handleRemove(row)}
                  >
                    <TrashIcon className="size-3.5" />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </SettingsSection>

      {advancedEnabled ? (
        <AdvancedSharingSection
          unreachableMachines={unreachableMachines}
          machineCount={rows.length}
        >
          <SettingsSection title="Shared list">
            <SettingsRow
              title="Name"
              description="Shown in the sidebar switcher. Every machine in the list reads the same one."
              control={
                <Input
                  aria-label="Machine list name"
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
              title={state?.identity.name ?? "Shared list"}
              description={
                stateQuery.isError
                  ? "The list could not be read. Everything below is unavailable, not empty."
                  : `Revision ${state?.identity.epoch ?? 0} · updated ${formatRelativeTime(state?.identity.updatedAt ?? null, now)}`
              }
              control={
                stateQuery.isError ? (
                  <StatusPill tone="bad">unreachable</StatusPill>
                ) : unreachableMachines > 0 ? (
                  <StatusPill tone="warn">
                    {unreachableMachines} of {rows.length} not online
                  </StatusPill>
                ) : (
                  <StatusPill tone="ok">healthy</StatusPill>
                )
              }
            />

            <SettingsRow
              title="Uno account"
              description={
                cloud?.connected
                  ? `${cloud.account?.username ?? "account"}${cloud.account?.email ? ` · ${cloud.account.email}` : ""} · balance $${(cloud.account?.balance ?? 0).toFixed(2)} · LLM $${(cloud.account?.llmBalance ?? 0).toFixed(2)}`
                  : cloudQuery.isPending
                    ? "Asking Uno who this account is…"
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

            <SettingsRow
              title="Share this computer's connections"
              description="Machines this computer knows about can be added to the shared list, so every machine reads the same rules."
              control={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={syncMachines.isPending}
                  onClick={handleSyncConnections}
                >
                  Add my connections
                </Button>
              }
            />

            <div className="flex flex-col gap-2 px-4 pb-3 sm:px-5">
              {(state?.machines ?? []).map((machine) => (
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
                    withoutTooltip
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{machine.label}</span>
                      {(() => {
                        const RegistryKindIcon =
                          MACHINE_KIND_ICON[deriveMachineKind({ registryKind: machine.kind })];
                        return <RegistryKindIcon className="size-3.5 text-muted-foreground" />;
                      })()}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {machine.environmentId} · seen {formatRelativeTime(machine.lastSeenAt, now)}
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
                            taken
                              ? `${choice.label} — already used by another machine`
                              : choice.label
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
                </div>
              ))}
            </div>
          </SettingsSection>

          <SettingsSection title="Uno boxes">
            <SettingsRow
              title="Boxes on this account"
              description="A box is a machine this app can wake. Adding one puts it in the shared list; connecting it is done from Settings → Connections with the SSH endpoint shown here."
            />
            <div className="flex flex-col gap-2 px-4 pb-3 sm:px-5">
              {!cloud?.connected ? (
                <p className="text-sm text-muted-foreground">
                  {cloudQuery.isPending ? "Loading boxes…" : "Link an Uno account to list boxes."}
                </p>
              ) : cloud.boxes.length === 0 ? (
                <p className="text-sm text-muted-foreground">This account has no boxes yet.</p>
              ) : null}
              {(cloud?.boxes ?? []).map((box) => {
                const sshTarget = parseUnoBoxSshTarget(box.ssh);
                return (
                  <div
                    key={box.id}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2"
                  >
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
                      tone={
                        box.status === "running" ? "ok" : box.status === "error" ? "bad" : "muted"
                      }
                    >
                      {box.status}
                    </StatusPill>
                  </div>
                );
              })}
            </div>
          </SettingsSection>

          <WorkspaceInstructionsSection
            registryEnvironmentId={registryEnvironmentId}
            state={state ?? null}
          />
        </AdvancedSharingSection>
      ) : null}

      {addModalElement}
    </SettingsPageContainer>
  );
}

/**
 * Everything a first-time user does not need: the shared machine list, the
 * Uno boxes on the account and the instruction layers. Collapsed by default.
 */
function AdvancedSharingSection({
  unreachableMachines,
  machineCount,
  children,
}: {
  readonly unreachableMachines: number;
  readonly machineCount: number;
  readonly children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-8">
      <CollapsibleTrigger
        className="group flex w-full items-center justify-between gap-3 rounded-2xl border border-dashed border-border px-4 py-3 text-left transition-colors hover:bg-muted/40 sm:px-5"
        aria-label={open ? "Hide advanced sharing" : "Show advanced sharing"}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
            Advanced sharing
            {unreachableMachines > 0 && machineCount > 0 ? (
              <StatusPill tone="muted">
                {unreachableMachines} of {machineCount} not online
              </StatusPill>
            ) : null}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">
            The shared machine list, the Uno boxes on this account and the written instructions
            every agent gets on every machine. Most people never need to open this.
          </p>
        </div>
        <ChevronDownIcon
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel className="flex flex-col gap-8">{children}</CollapsiblePanel>
    </Collapsible>
  );
}
