import { ArchiveIcon, ArchiveX } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { type DesktopUpdateChannel, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { DEFAULT_UNIFIED_SETTINGS, UNO_GATEWAY_BASE_URL } from "@t3tools/contracts/settings";
import { Equal } from "effect";
import { APP_BASE_NAME, APP_VERSION } from "../../branding";
import { isLoopbackHostname } from "../../environments/primary";
import { isWebApp } from "../../webMode";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { isElectron } from "../../env";
import { useTheme } from "../../hooks/useTheme";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../../lib/desktopUpdateReactQuery";
import { useDesktopUnoCodeInstallState } from "../../lib/desktopUnoCodeReactQuery";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { useShallow } from "zustand/react/shallow";
import {
  selectProjectsAcrossEnvironments,
  selectThreadShellsAcrossEnvironments,
  useStore,
} from "../../store";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { formatAiMinutes } from "../../account/aiHours";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AppearanceLayoutSection } from "./AppearanceLayoutSection";
import { NotificationsSection } from "./NotificationsSection";
import { DRIVER_OPTIONS } from "./providerDriverMeta";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { ProjectFavicon } from "../ProjectFavicon";
import { OFFICE_SOURCE_LABEL, OFFICE_SOURCE_URL } from "../office/officeLinks";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
  },
  {
    value: "light",
    label: "Light",
  },
  {
    value: "dark",
    label: "Dark",
  },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const PROVIDER_SETTINGS = DRIVER_OPTIONS.map((definition) => ({
  provider: definition.value,
}));

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const queryClient = useQueryClient();
  const updateStateQuery = useDesktopUpdateState();
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);

  const updateState = updateStateQuery.data ?? null;
  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";

  const handleUpdateChannelChange = useCallback(
    (channel: DesktopUpdateChannel) => {
      const bridge = window.desktopBridge;
      if (
        !bridge ||
        typeof bridge.setUpdateChannel !== "function" ||
        channel === selectedUpdateChannel
      ) {
        return;
      }

      setIsChangingUpdateChannel(true);
      void bridge
        .setUpdateChannel(channel)
        .then((state) => {
          setDesktopUpdateStateQueryData(queryClient, state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not change update track",
              description: error instanceof Error ? error.message : "Update track change failed.",
            }),
          );
        })
        .finally(() => {
          setIsChangingUpdateChannel(false);
        });
    },
    [queryClient, selectedUpdateChannel],
  );

  const handleButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: error instanceof Error ? error.message : "Download failed.",
            }),
          );
        });
      return;
    }

    if (action === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(
          updateState ?? { availableVersion: null, downloadedVersion: null },
        ),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "Install failed.",
            }),
          );
        });
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        setDesktopUpdateStateQueryData(queryClient, result.state);
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check for updates",
              description:
                result.state.message ?? "Automatic updates are not available in this build.",
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      });
  }, [queryClient, updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = { download: "Download", install: "Install" };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    action === "download" || action === "install"
      ? "Update available."
      : "Current version of the application.";

  return (
    <>
      <SettingsRow
        title={<AboutVersionTitle />}
        description={description}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant={action === "install" ? "default" : "outline"}
                  disabled={buttonDisabled}
                  onClick={handleButtonClick}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      <SettingsRow
        title="Update track"
        description="Stable follows full releases. Nightly follows the nightly desktop channel and can switch back to stable immediately."
        control={
          <Select
            value={selectedUpdateChannel}
            onValueChange={(value) => {
              handleUpdateChannelChange(value as DesktopUpdateChannel);
            }}
          >
            <SelectTrigger
              className="w-full sm:w-40"
              aria-label="Update track"
              disabled={!hasDesktopBridge || isChangingUpdateChannel}
            >
              <SelectValue>
                {selectedUpdateChannel === "nightly" ? "Nightly" : "Stable"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="latest">
                Stable
              </SelectItem>
              <SelectItem hideIndicator value="nightly">
                Nightly
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </>
  );
}

const UNO_CODE_PHASE_LABEL: Record<string, string> = {
  "fetching-release": "Fetching release…",
  downloading: "Downloading…",
  extracting: "Extracting…",
  verifying: "Verifying…",
  done: "Finishing…",
};

/**
 * Uno AI hours of the key's account (`GET /v1/ai/status`); null when the
 * gateway has none (404 on an older backend) — then only credits are shown.
 */
export function useGatewayAiHours(apiKey: string) {
  return useQuery({
    queryKey: ["uno-gateway-ai-status", apiKey],
    queryFn: async () => {
      const response = await fetch(`${UNO_GATEWAY_BASE_URL}/ai/status`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) return null;
      const body = (await response.json().catch(() => null)) as {
        readonly hours_left_minutes?: unknown;
        readonly unlimited?: unknown;
      } | null;
      if (body?.unlimited === true) return { unlimited: true, leftMinutes: null };
      return typeof body?.hours_left_minutes === "number"
        ? { unlimited: false, leftMinutes: body.hours_left_minutes }
        : null;
    },
    enabled: apiKey.length > 0,
    staleTime: 60_000,
    retry: false,
  });
}

export function UnoGatewayBalance({ apiKey }: { readonly apiKey: string }) {
  const hours = useGatewayAiHours(apiKey).data ?? null;
  const query = useQuery({
    queryKey: ["uno-gateway-credits", apiKey],
    queryFn: async () => {
      const response = await fetch(`${UNO_GATEWAY_BASE_URL}/credits`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) {
        throw new Error(`credits request failed: ${response.status}`);
      }
      return (await response.json()) as { readonly llm_balance?: number };
    },
    staleTime: 60_000,
    retry: 1,
  });

  const topUpLink = (
    <a
      href="https://console.uno4.dev/llm"
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
    >
      Top up ↗
    </a>
  );

  if (query.isPending) {
    return <span className="text-xs text-muted-foreground">Loading…</span>;
  }
  const hoursLabel = hours
    ? hours.unlimited || hours.leftMinutes === null
      ? "Unlimited AI"
      : `${formatAiMinutes(hours.leftMinutes)} left · never expire`
    : null;
  if (query.isError || typeof query.data?.llm_balance !== "number") {
    return hoursLabel ? (
      <span className="flex items-center gap-2">
        <span className="text-sm font-semibold tabular-nums">{hoursLabel}</span>
        {topUpLink}
      </span>
    ) : (
      topUpLink
    );
  }
  return (
    <span className="flex items-center gap-2">
      {hoursLabel ? <span className="text-sm font-semibold tabular-nums">{hoursLabel}</span> : null}
      {!hoursLabel || query.data.llm_balance > 0 ? (
        <span
          className={cn(
            "tabular-nums",
            hoursLabel ? "text-xs text-muted-foreground" : "text-sm font-semibold",
          )}
        >
          ${query.data.llm_balance.toFixed(2)}
          {hoursLabel ? " premium credit" : ""}
        </span>
      ) : null}
      {topUpLink}
    </span>
  );
}

function UnoCodeInstallSection() {
  const stateQuery = useDesktopUnoCodeInstallState();
  const state = stateQuery.data ?? null;
  const [isRetrying, setIsRetrying] = useState(false);

  const handleRetry = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.retryUnoCodeInstall !== "function") return;
    setIsRetrying(true);
    void bridge
      .retryUnoCodeInstall()
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start install",
            description: error instanceof Error ? error.message : "Install request failed.",
          }),
        );
      })
      .finally(() => {
        setIsRetrying(false);
      });
  }, []);

  const status = state?.status ?? "idle";

  let description: string;
  let statusNode: React.ReactNode = null;
  let control: React.ReactNode = null;

  if (status === "installed" && state?.status === "installed") {
    description = "The Uno agent is ready.";
    statusNode = (
      <>
        <span className="font-mono tabular-nums">v{state.version}</span>
        <span className="block break-all font-mono text-[11px] text-muted-foreground/80">
          {state.binaryPath}
        </span>
      </>
    );
  } else if (status === "installing" && state?.status === "installing") {
    const percent =
      typeof state.percent === "number" ? Math.max(0, Math.min(100, state.percent)) : null;
    const phaseLabel = UNO_CODE_PHASE_LABEL[state.phase] ?? "Installing…";
    description = "Setting up the Uno agent in the background.";
    statusNode = (
      <span>
        {phaseLabel}
        {percent !== null ? ` ${percent}%` : null}
      </span>
    );
  } else if (status === "failed" && state?.status === "failed") {
    description = state.willRetry
      ? "Install failed — retrying automatically. You can also retry now."
      : "Install failed. You can retry below.";
    statusNode = (
      <span className="text-destructive">
        {state.error}
        {state.willRetry ? (
          <span className="mt-0.5 block text-[11px] text-muted-foreground">
            Automatic retry scheduled.
          </span>
        ) : null}
      </span>
    );
    control = (
      <Button size="xs" variant="outline" disabled={isRetrying} onClick={handleRetry}>
        {isRetrying ? "Starting…" : "Retry"}
      </Button>
    );
  } else {
    description = "Not installed yet. It is fetched in the background on first launch.";
    control = (
      <Button size="xs" variant="outline" disabled={isRetrying} onClick={handleRetry}>
        {isRetrying ? "Starting…" : "Install now"}
      </Button>
    );
  }

  return (
    <SettingsRow title="Uno Code" description={description} status={statusNode} control={control} />
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { resetSettings } = useUpdateSettings();

  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  // A provider surface is "dirty" if either the legacy per-kind
  // `settings.providers[kind]` struct differs from defaults (for users
  // on pre-migration data) or the new `settings.providerInstances` map
  // has any entries (every edit to a default slot promotes it into an
  // explicit entry, so any key in that map represents user intent to
  // diverge from factory defaults). Checking both keeps the Restore
  // Defaults chip accurate throughout the legacy→instance migration.
  const areProviderSettingsDirty =
    PROVIDER_SETTINGS.some((providerSettings) => {
      type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
      const currentProviders = settings.providers as Record<
        string,
        LegacyProviderSettings | undefined
      >;
      const defaultProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
        string,
        LegacyProviderSettings | undefined
      >;
      const currentSettings = currentProviders[providerSettings.provider];
      const defaultSettings = defaultProviders[providerSettings.provider];
      return !Equal.equals(currentSettings, defaultSettings);
    }) ||
    Object.keys(settings.providerInstances ?? {}).length > 0 ||
    Object.keys(settings.providerModelPreferences ?? {}).length > 0 ||
    (settings.favorites ?? []).length > 0;

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap
        ? ["Diff line wrapping"]
        : []),
      ...(settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace
        ? ["Diff whitespace changes"]
        : []),
      ...(settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar
        ? ["Auto-open task panel"]
        : []),
      ...(settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
        ? ["Assistant output"]
        : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New chat mode"]
        : []),
      ...(settings.agentThreadsScope !== DEFAULT_UNIFIED_SETTINGS.agentThreadsScope
        ? ["Cross-project chats"]
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ["Add project base directory"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(isGitWritingModelDirty ? ["Git writing model"] : []),
      ...(areProviderSettingsDirty ? ["Providers"] : []),
    ],
    [
      areProviderSettingsDirty,
      isGitWritingModelDirty,
      settings.autoOpenPlanSidebar,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.addProjectBaseDirectory,
      settings.agentThreadsScope,
      settings.defaultThreadEnvMode,
      settings.diffIgnoreWhitespace,
      settings.diffWordWrap,
      settings.enableAssistantStreaming,
      settings.timestampFormat,
      theme,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;

    setTheme("system");
    resetSettings();
    onRestored?.();
  }, [changedSettingLabels, onRestored, resetSettings, setTheme]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

export function GeneralSettingsPanel() {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const navigate = useNavigate();
  const showWebLogout = isWebApp && !isLoopbackHostname(window.location.hostname);

  return (
    <SettingsPageContainer>
      {showWebLogout ? (
        <SettingsSection title="Uno account">
          <SettingsRow
            title="Session"
            description="Signed in through the Uno console. Logging out returns you to the console."
            control={
              <Button
                variant="outline"
                onClick={() => {
                  window.location.href = "/logout";
                }}
              >
                Log out
              </Button>
            }
          />
        </SettingsSection>
      ) : null}
      <SettingsSection title="General">
        <SettingsRow
          title="Start screen"
          description="Pick what you want to do again: assistant, website, bot, your agent, server."
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                updateSettings({ onboardingCompleted: false });
                void navigate({ to: "/onboarding" });
              }}
            >
              Show again
            </Button>
          }
        />
        <SettingsRow
          title="Full setup"
          description="Default AI, instructions, skills, connectors, Telegram and Slack, your files."
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() => void navigate({ to: "/setup", search: { step: "ai" } })}
            >
              Open
            </Button>
          }
        />

        <SettingsRow
          title="Theme"
          description={`Choose how ${APP_BASE_NAME} looks across the app.`}
          resetAction={
            theme !== "system" ? (
              <SettingResetButton label="theme" onClick={() => setTheme("system")} />
            ) : null
          }
          control={
            <Select
              value={theme}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark") {
                  setTheme(value);
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
                <SelectValue>
                  {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {THEME_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Time format"
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Diff line wrapping"
          description="Set the default wrap state when the diff panel opens."
          resetAction={
            settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
              <SettingResetButton
                label="diff line wrapping"
                onClick={() =>
                  updateSettings({
                    diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffWordWrap}
              onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
              aria-label="Wrap diff lines by default"
            />
          }
        />

        <SettingsRow
          title="Hide whitespace changes"
          description="Set whether the diff panel ignores whitespace-only edits by default."
          resetAction={
            settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
              <SettingResetButton
                label="diff whitespace changes"
                onClick={() =>
                  updateSettings({
                    diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffIgnoreWhitespace}
              onCheckedChange={(checked) =>
                updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
              }
              aria-label="Hide whitespace changes by default"
            />
          }
        />

        <SettingsRow
          title="Auto-open task panel"
          description="Open the right-side plan and task panel automatically when steps appear."
          resetAction={
            settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar ? (
              <SettingResetButton
                label="auto-open task panel"
                onClick={() =>
                  updateSettings({
                    autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.autoOpenPlanSidebar}
              onCheckedChange={(checked) =>
                updateSettings({ autoOpenPlanSidebar: Boolean(checked) })
              }
              aria-label="Open the task panel automatically"
            />
          }
        />

        <SettingsRow
          title="Archive confirmation"
          description="Require a second click on the inline archive action before a chat is archived."
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label="archive confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label="Confirm chat archiving"
            />
          }
        />

        <SettingsRow
          title="Delete confirmation"
          description="Ask before deleting a chat and its history."
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="delete confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="Confirm chat deletion"
            />
          }
        />
      </SettingsSection>

      <AppearanceLayoutSection />

      <NotificationsSection />

      <SettingsSection title="About">
        {isElectron ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow
            title={<AboutVersionTitle />}
            description="Current version of the application."
          />
        )}
        {isElectron ? <UnoCodeInstallSection /> : null}
        <SettingsRow
          title="Office editor"
          description="Word, Excel and PowerPoint files open in ONLYOFFICE, which is AGPL-3.0. Our changes to it are published."
          control={
            <a
              href={OFFICE_SOURCE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary underline-offset-4 hover:underline"
              data-testid="about-office-source"
            >
              {OFFICE_SOURCE_LABEL}
            </a>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function ArchivedThreadsPanel() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectThreadShellsAcrossEnvironments));
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const archivedGroups = useMemo(() => {
    return projects
      .map((project) => ({
        project,
        threads: threads
          .filter((thread) => thread.projectId === project.id && thread.archivedAt !== null)
          .toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
      }))
      .filter((group) => group.threads.length > 0);
  }, [projects, threads]);

  const handleArchivedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        try {
          await unarchiveThread(threadRef);
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to unarchive chat",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (clicked === "delete") {
        await confirmAndDeleteThread(threadRef);
      }
    },
    [confirmAndDeleteThread, unarchiveThread],
  );

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection title="Archived chats">
          <Empty className="min-h-88">
            <EmptyMedia variant="icon">
              <ArchiveIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No archived chats</EmptyTitle>
              <EmptyDescription>Archived chats will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }) => (
          <SettingsSection
            key={project.id}
            title={project.name}
            icon={<ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />}
          >
            {projectThreads.map((thread) => (
              <div
                key={thread.id}
                className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:px-5"
                onContextMenu={(event) => {
                  event.preventDefault();
                  void handleArchivedThreadContextMenu(
                    scopeThreadRef(thread.environmentId, thread.id),
                    {
                      x: event.clientX,
                      y: event.clientY,
                    },
                  );
                }}
              >
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-medium text-foreground">{thread.title}</h3>
                  <p className="text-xs text-muted-foreground">
                    Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                    {" \u00b7 Created "}
                    {formatRelativeTimeLabel(thread.createdAt)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                  onClick={() =>
                    void unarchiveThread(scopeThreadRef(thread.environmentId, thread.id)).catch(
                      (error) => {
                        toastManager.add(
                          stackedThreadToast({
                            type: "error",
                            title: "Failed to unarchive chat",
                            description:
                              error instanceof Error ? error.message : "An error occurred.",
                          }),
                        );
                      },
                    )
                  }
                >
                  <ArchiveX className="size-3.5" />
                  <span>Unarchive</span>
                </Button>
              </div>
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
