/**
 * Providers, for one named environment.
 *
 * A provider is a CLI, a binary path and an authentication state on a
 * particular machine, so "which providers are configured" has no answer until
 * you say *where*. The panel therefore takes an `environmentId` and reads and
 * writes only that environment: its provider snapshots come from that
 * daemon's config, and edits go over that daemon's connection.
 *
 * Model visibility, order and favourites are still device-local preferences
 * (they live in client settings), so they are shown here but labelled as
 * belonging to this device rather than to the environment.
 *
 * @module components/settings/EnvironmentProvidersPanel
 */
import {
  CUSTOM_HARNESS_DRIVER_KIND,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { Equal } from "effect";
import { LoaderIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  refreshEnvironmentProviders,
  useEnvironmentProviders,
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "~/environments/settings/serverSettings";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderSetupAction } from "../harness/ProviderSetupAction";
import { useHarnessSetup } from "../harness/useHarnessSetup";
import { Explain } from "../Explain";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";
import {
  buildProviderInstanceUpdatePatch,
  withoutProviderInstanceFavorites,
  withoutProviderInstanceKey,
} from "./SettingsPanels.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";

const PROVIDER_DRIVERS = DRIVER_OPTIONS.map((definition) => definition.value);

interface InstanceRow {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly isDirty?: boolean;
}

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  // Subscribe to the tick so the label re-renders as it ages.
  useRelativeTimeTick(30_000);
  if (!lastCheckedAt) return null;
  return (
    <span className="text-[11px] text-muted-foreground">
      Checked {formatRelativeTimeLabel(lastCheckedAt)}
    </span>
  );
}

export function EnvironmentProvidersPanel({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const serverSettings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders(environmentId);
  const { updateSettings, canMutate, mutationBlockedReason } =
    useUpdateEnvironmentSettings(environmentId);
  const harnessSetup = useHarnessSetup(environmentId);
  const clientSettings = useSettings();
  const { updateSettings: updateClientSettings } = useUpdateSettings();

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [openInstanceDetails, setOpenInstanceDetails] = useState<Record<string, boolean>>({});
  const refreshingRef = useRef(false);

  const refresh = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    void refreshEnvironmentProviders(environmentId)
      .catch((error: unknown) => {
        toastManager.add({
          title: "Could not refresh providers",
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        refreshingRef.current = false;
        setIsRefreshing(false);
      });
  }, [environmentId]);

  const save = useCallback(
    (patch: Parameters<typeof updateSettings>[0], description: string) => {
      void updateSettings(patch).catch((error: unknown) => {
        toastManager.add({
          title: description,
          description: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [updateSettings],
  );

  const visibleDrivers = useMemo(
    () =>
      PROVIDER_DRIVERS.filter(
        (driver) =>
          driver !== "cursor" ||
          providers.some(
            (provider) =>
              provider.instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("cursor")),
          ),
      ),
    [providers],
  );

  const rows = useMemo<ReadonlyArray<InstanceRow>>(() => {
    if (!serverSettings) return [];
    const instancesByDriver = new Map<
      ProviderDriverKind,
      Array<[ProviderInstanceId, ProviderInstanceConfig]>
    >();
    for (const [rawId, instance] of Object.entries(serverSettings.providerInstances ?? {})) {
      const list = instancesByDriver.get(instance.driver) ?? [];
      list.push([rawId as ProviderInstanceId, instance]);
      instancesByDriver.set(instance.driver, list);
    }

    type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];
    const legacyProviders = serverSettings.providers as Record<string, LegacyProviderSettings>;
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings
    >;

    const next: InstanceRow[] = [];
    const visibleDriverKinds = new Set<ProviderDriverKind>(visibleDrivers);
    const defaultSlotIds = new Set<string>(
      visibleDrivers.map((driver) => String(defaultInstanceIdForDriver(driver))),
    );

    for (const driver of visibleDrivers) {
      const defaultInstanceId = defaultInstanceIdForDriver(driver);
      const explicitInstance = serverSettings.providerInstances?.[defaultInstanceId];
      const legacyConfig = legacyProviders[driver]!;
      const defaultLegacyConfig = defaultLegacyProviders[driver]!;
      next.push({
        instanceId: defaultInstanceId,
        instance:
          explicitInstance ??
          ({
            driver,
            enabled: legacyConfig.enabled,
            config: legacyConfig,
          } satisfies ProviderInstanceConfig),
        driver,
        isDefault: true,
        isDirty: explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig),
      });
      for (const [id, instance] of instancesByDriver.get(driver) ?? []) {
        if (id === defaultInstanceId) continue;
        next.push({ instanceId: id, instance, driver: instance.driver, isDefault: false });
      }
    }

    for (const [driver, list] of instancesByDriver) {
      if (visibleDriverKinds.has(driver)) continue;
      // Custom (ACP) harnesses have their own page: Settings → Harnesses.
      if (driver === CUSTOM_HARNESS_DRIVER_KIND) continue;
      for (const [id, instance] of list) {
        next.push({
          instanceId: id,
          instance,
          driver: instance.driver,
          isDefault: defaultSlotIds.has(String(id)),
        });
      }
    }

    return next;
  }, [serverSettings, visibleDrivers]);

  const lastCheckedAt =
    providers.length > 0
      ? providers.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          providers[0]!.checkedAt,
        )
      : null;

  const updateProviderInstance = (row: InstanceRow, next: ProviderInstanceConfig) => {
    if (!serverSettings) return;
    save(
      buildProviderInstanceUpdatePatch({
        settings: serverSettings,
        instanceId: row.instanceId,
        instance: next,
        driver: row.driver,
        isDefault: row.isDefault,
      }),
      "Could not save agent settings",
    );
  };

  const deleteProviderInstance = (id: ProviderInstanceId) => {
    if (!serverSettings) return;
    save(
      { providerInstances: withoutProviderInstanceKey(serverSettings.providerInstances, id) },
      "Could not remove agent setup",
    );
    // Preferences and favourites are device-local, so they are cleaned up
    // through client settings rather than sent to the daemon.
    updateClientSettings({
      providerModelPreferences: withoutProviderInstanceKey(
        clientSettings.providerModelPreferences,
        id,
      ),
      favorites: withoutProviderInstanceFavorites(clientSettings.favorites ?? [], id),
    });
  };

  const resetDefaultInstance = (driverKind: ProviderDriverKind) => {
    if (!serverSettings) return;
    type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings | undefined
    >;
    const defaultLegacyProvider = defaultLegacyProviders[driverKind];
    if (defaultLegacyProvider === undefined) return;
    save(
      {
        providers: {
          ...serverSettings.providers,
          [driverKind]: defaultLegacyProvider,
        } as ServerSettings["providers"],
        providerInstances: withoutProviderInstanceKey(
          serverSettings.providerInstances,
          defaultInstanceIdForDriver(driverKind),
        ),
      },
      "Could not reset agent settings",
    );
  };

  const updateProviderModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>;
      readonly modelOrder: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutProviderInstanceKey(clientSettings.providerModelPreferences, instanceId);
    updateClientSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : { ...rest, [instanceId]: { hiddenModels, modelOrder } },
    });
  };

  const updateProviderFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavoriteModels: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(nextFavoriteModels.map((slug) => slug.trim()).filter((slug) => slug.length > 0)),
    ];
    updateClientSettings({
      favorites: [
        ...withoutProviderInstanceFavorites(clientSettings.favorites ?? [], instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  return (
    <SettingsPageContainer>
      {mutationBlockedReason ? (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-400">
          {mutationBlockedReason}
        </p>
      ) : null}

      <SettingsSection
        title="Agents"
        titleAddon={<Explain term="agent" technical />}
        headerAction={
          <div className="flex items-center gap-1.5">
            <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={!canMutate}
                    onClick={() => setIsAddInstanceDialogOpen(true)}
                    aria-label="Add agent setup"
                  >
                    <PlusIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Add agent setup (provider instance)</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={isRefreshing || !canMutate}
                    onClick={refresh}
                    aria-label="Refresh agent status"
                  >
                    {isRefreshing ? (
                      <LoaderIcon className="size-3 animate-spin" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh agent status</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {rows.map((row) => {
          const driverOption = getDriverOption(row.driver);
          const liveProvider = providers.find(
            (candidate) => candidate.instanceId === row.instanceId,
          );
          const modelPreferences = clientSettings.providerModelPreferences?.[row.instanceId] ?? {
            hiddenModels: [],
            modelOrder: [],
          };
          const favoriteModels = (clientSettings.favorites ?? [])
            .filter((favorite) => favorite.provider === row.instanceId)
            .map((favorite) => favorite.model);
          return (
            <ProviderInstanceCard
              key={row.instanceId}
              instanceId={row.instanceId}
              instance={row.instance}
              driverOption={driverOption}
              liveProvider={liveProvider}
              isExpanded={openInstanceDetails[row.instanceId] ?? false}
              onExpandedChange={(open) =>
                setOpenInstanceDetails((existing) => ({ ...existing, [row.instanceId]: open }))
              }
              onUpdate={(next) => updateProviderInstance(row, next)}
              onDelete={row.isDefault ? undefined : () => deleteProviderInstance(row.instanceId)}
              setupAction={
                row.isDefault ? (
                  <ProviderSetupAction
                    driver={row.driver}
                    provider={liveProvider}
                    providersLoaded={providers.length > 0}
                    setup={harnessSetup}
                    enabled={canMutate}
                  />
                ) : null
              }
              headerAction={
                row.isDefault && row.isDirty ? (
                  <SettingResetButton
                    label={`${driverOption?.label ?? String(row.driver)} agent settings`}
                    onClick={() => resetDefaultInstance(row.driver)}
                  />
                ) : null
              }
              hiddenModels={modelPreferences.hiddenModels}
              favoriteModels={favoriteModels}
              modelOrder={modelPreferences.modelOrder}
              onHiddenModelsChange={(hiddenModels) =>
                updateProviderModelPreferences(row.instanceId, {
                  ...modelPreferences,
                  hiddenModels,
                })
              }
              onFavoriteModelsChange={(favoriteModels) =>
                updateProviderFavoriteModels(row.instanceId, favoriteModels)
              }
              onModelOrderChange={(modelOrder) =>
                updateProviderModelPreferences(row.instanceId, { ...modelPreferences, modelOrder })
              }
            />
          );
        })}
      </SettingsSection>

      <AddProviderInstanceDialog
        open={isAddInstanceDialogOpen}
        onOpenChange={setIsAddInstanceDialogOpen}
        environmentId={environmentId}
      />
    </SettingsPageContainer>
  );
}
