/**
 * Settings in five (simplification 01.10): Account & plan, AI, Assistants &
 * phone, Computer, Developer. They are made of the pieces the old pages
 * already had; the old pages are all still there and come back in the nav
 * with Dev mode (Settings → Developer).
 */
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  LayersIcon,
  LockIcon,
} from "lucide-react";
import {
  ASSISTANT_PROJECT_ID,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { CONSOLE_URL } from "../../account/accountOverview";
import { accountTransport } from "../../account/unoAccount";
import { useAssistantChannels } from "../../assistant/useAssistantChannels";
import { useAssistantLlm } from "../../assistant/useAssistantLlm";
import { setDevMode, useDevMode } from "../../devMode";
import { isElectron } from "../../env";
import {
  refreshEnvironmentProviders,
  useEnvironmentProviders,
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "../../environments/settings/serverSettings";
import { resolveFeatureFlag } from "../../featureFlags";
import { useActiveMachine } from "../../hooks/useActiveMachine";
import { useFeatureFlagOverrides } from "../../hooks/useFeatureFlags";
import { useMachineRows } from "../../hooks/useMachineRows";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { setAssistantDefaultModel } from "../../lib/managerApi";
import { selectProjectByRef, useStore } from "../../store";
import { isWebApp } from "../../webMode";
import { ConnectChannelDialog, type ConnectChannel } from "../assistant/ConnectChannelDialog";
import { AssistantModelPicker } from "../chat/AssistantEngine";
import { AssistantPowerPicker } from "../assistant/AssistantPowerPicker";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { ProviderSetupPane } from "../chat/ProviderSetupPane";
import { resolveProviderPaneKind } from "../chat/modelPickerProviderPane";
import { EconomyCard, useComputerEconomy } from "../computer/EconomyControl";
import { useHomeModelPicker } from "../computer/home/HomeComposer";
import { newChatModelSelection } from "../computer/home/homeStartModel";
import { openInstallDocs } from "../onboarding/harnessInstallLinks";
import { OpenCodeKeyForm } from "../harness/OpenCodeKeyForm";
import { useHarnessSetup } from "../harness/useHarnessSetup";
import { runsOnUnoAi } from "../harness/harnessSetupState";
import { subscriptionActionLabel, subscriptionRowState } from "./simpleSubscriptionRow.logic";
import { SlackBrandMark, TelegramMark } from "../setup/brandMarks";
import { Button } from "../ui/button";
import { QRCodeSvg } from "../ui/qr-code";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { AiProviderKeysSection } from "./AiProviderKeysSection";
import { AppsAiDefaultRows } from "./AppsAiSettingsPanel";
import { HarnessesSettingsPanel } from "./HarnessesSettingsPanel";
import { MachineAccessSections } from "./MachineAccessSettings";
import { GeneralSettingsPanel, UnoGatewayBalance } from "./SettingsPanels";
import { buildProviderInstanceUpdatePatch } from "./SettingsPanels.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { buildSettingsNavGroups } from "./settingsNavGroups";

/** Where Uno Work opens in a phone's browser. */
const PHONE_WORK_URL = "https://app.uno4.work";

function openExternal(url: string) {
  if (isElectron) openInstallDocs(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

function useActiveUnoKey(): string {
  const { environmentId } = useActiveMachine();
  return useEnvironmentSettings(environmentId)?.uno?.apiKey ?? "";
}

function LinkRow({
  icon,
  title,
  description,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-3 border-t border-border/60 px-4 py-3.5 text-left transition-colors first:border-t-0 hover:bg-accent/40 sm:px-5"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold">{title}</span>
        <span className="block text-xs text-muted-foreground/80">{description}</span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/60" />
    </button>
  );
}

// ── Account & plan ───────────────────────────────────────────────────

export function AccountPlanSettings() {
  const navigate = useNavigate();
  const apiKey = useActiveUnoKey();
  const hasAccount = accountTransport() !== "none";
  return (
    <GeneralSettingsPanel
      simple
      before={
        <SettingsSection title="Plan and AI">
          {apiKey ? (
            <SettingsRow
              title="AI time and balance"
              description="Smart and Fast come from your AI time; Premium models from premium credit, then your balance."
              control={<UnoGatewayBalance apiKey={apiKey} />}
            />
          ) : null}
          <SettingsRow
            title="Your plan"
            description="Plan, payments and invoices live in the Uno console."
            control={
              <div className="flex flex-wrap gap-2">
                {hasAccount ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void navigate({ to: "/my-uno", search: { tab: "billing" } })}
                  >
                    Plan &amp; billing
                  </Button>
                ) : null}
                <Button size="xs" variant="outline" onClick={() => openExternal(CONSOLE_URL)}>
                  Open console
                  <ArrowUpRightIcon className="size-3.5" />
                </Button>
              </div>
            }
          />
        </SettingsSection>
      }
    />
  );
}

// ── AI ───────────────────────────────────────────────────────────────

/**
 * The agents a person can use, as rows of Settings → AI. Claude and ChatGPT
 * sign in here (their own subscription); OpenCode and Cursor are installed
 * here and take a key or a terminal login. Anything else is a custom harness.
 */
const AGENTS = [
  {
    driver: "claudeAgent",
    label: "Claude",
    plans: "Claude Pro or Max",
    description: "Claude Code on your Claude Pro or Max subscription",
  },
  {
    driver: "codex",
    label: "ChatGPT",
    plans: "ChatGPT Plus or Pro",
    description: "Codex on your ChatGPT Plus or Pro subscription",
  },
  {
    driver: "opencode",
    label: "OpenCode",
    plans: null,
    description:
      "The open-source agent. On a computer signed in to Uno it runs on Uno AI as soon as it is installed; or give it your own key, or sign in to OpenCode's plan with `opencode auth login` in the Terminal.",
  },
  {
    driver: "cursor",
    label: "Cursor",
    plans: null,
    description:
      "Cursor's agent on your Cursor subscription. Turn it on, install it, then sign in with `agent login` in the Terminal.",
  },
] as const;

/** While a row waits for a sign-in, re-check the computer this often. */
const AGENTS_RECHECK_MS = 10_000;

/**
 * "Default AI": what the assistant and the apps run on when nobody picked
 * something for one chat or one app (Misha 13.10). The assistant's AI moved
 * here from the Uno chat's header.
 */
function DefaultAiSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const picker = useHomeModelPicker(environmentId);
  const assistantLlm = useAssistantLlm(environmentId);
  const assistantProject = useStore((state) =>
    selectProjectByRef(state, scopeProjectRef(environmentId, ASSISTANT_PROJECT_ID)),
  );
  // Hermes is the assistant itself, not something its work is handed to.
  const workAgents = useMemo(
    () => picker.instanceEntries.filter((entry) => entry.driverKind !== "hermes"),
    [picker.instanceEntries],
  );
  const work = assistantProject?.defaultModelSelection ?? null;
  const workEntry = work ? workAgents.find((entry) => entry.instanceId === work.instanceId) : null;
  return (
    <SettingsSection title="Default AI for your assistant and apps">
      {assistantLlm.supported ? (
        <>
          <SettingsRow
            title="Assistant"
            description="What Uno, your assistant, thinks with: Uno AI, your own Claude or ChatGPT plan, or a key of your own from “AI provider keys” below."
            control={
              <AssistantModelPicker environmentId={environmentId} testId="settings-ai-uno" />
            }
          />
          <AssistantPowerPicker environmentId={environmentId} className="px-4 pb-3 sm:px-5" />
        </>
      ) : null}
      {assistantProject && work ? (
        <SettingsRow
          title="Work the assistant starts"
          description="The chats the assistant opens to do a task run on this agent: Uno AI, your Claude or ChatGPT subscription, OpenCode, Cursor or an agent you added."
          control={
            <ProviderModelPicker
              compact
              activeInstanceId={
                workEntry ? work.instanceId : (workAgents[0]?.instanceId ?? work.instanceId)
              }
              model={work.model}
              lockedProvider={null}
              instanceEntries={workAgents}
              environmentId={environmentId}
              modelOptionsByInstance={picker.modelOptionsByInstance}
              onInstanceModelChange={(instanceId, model) =>
                void setAssistantDefaultModel({
                  environmentId,
                  projectId: ASSISTANT_PROJECT_ID,
                  instanceId,
                  model,
                }).catch((error: unknown) =>
                  toastManager.add({
                    type: "error",
                    title: "Couldn't change the assistant's agent",
                    description: error instanceof Error ? error.message : String(error),
                  }),
                )
              }
              triggerVariant="outline"
            />
          }
        />
      ) : null}
      <AppsAiDefaultRows environmentId={environmentId} />
    </SettingsSection>
  );
}

const NEW_CHAT_START_LAST = "last";
const NEW_CHAT_START_FIXED = "fixed";

/**
 * "New chats start on" (Misha 15.10: "I must be the one who chooses"). Unset —
 * the model last picked in any chat, as before. Set — every new chat starts on
 * it, wherever it is started; a pick inside a chat changes only that chat.
 */
function NewChatModelRow({ environmentId }: { readonly environmentId: EnvironmentId | null }) {
  const picker = useHomeModelPicker(environmentId);
  const providers = useEnvironmentProviders(environmentId);
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const chosen = settings.newChatModelSelection;
  const usable = chosen !== null && newChatModelSelection({ providers, settings }) !== null;
  const save = (next: ModelSelection | null) =>
    void updateSettings({ newChatModelSelection: next }).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Couldn't save the model for new chats",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  const shown = chosen ?? picker.selection;
  return (
    <SettingsRow
      title="New chats start on"
      description={
        chosen
          ? "Every new chat starts on this model. Picking another one inside a chat changes only that chat."
          : "The model you picked last, in any chat. Or choose one that every new chat starts on."
      }
      status={
        chosen && !usable
          ? "Not available on this computer now, so new chats start on the last one you picked."
          : null
      }
      control={
        shown ? (
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <Select
              value={chosen ? NEW_CHAT_START_FIXED : NEW_CHAT_START_LAST}
              onValueChange={(value) => {
                if (value === NEW_CHAT_START_LAST) save(null);
                // Starts on what a new chat gets now; the effort stays the chat's.
                else if (!chosen && picker.selection)
                  save({
                    instanceId: picker.selection.instanceId,
                    model: picker.selection.model,
                  });
              }}
            >
              <SelectTrigger
                className="w-full sm:w-44"
                aria-label="New chats start on"
                data-testid="settings-new-chat-start"
              >
                <SelectValue>{chosen ? "Always this model" : "The last one I picked"}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value={NEW_CHAT_START_LAST}>
                  The last one I picked
                </SelectItem>
                <SelectItem hideIndicator value={NEW_CHAT_START_FIXED}>
                  Always this model
                </SelectItem>
              </SelectPopup>
            </Select>
            {chosen ? (
              <ProviderModelPicker
                compact
                activeInstanceId={chosen.instanceId}
                model={chosen.model}
                lockedProvider={null}
                instanceEntries={picker.instanceEntries}
                environmentId={environmentId}
                modelOptionsByInstance={picker.modelOptionsByInstance}
                onInstanceModelChange={(instanceId, model) => save({ instanceId, model })}
                triggerVariant="outline"
              />
            ) : null}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">No AI on this computer yet</span>
        )
      }
    />
  );
}

export function AiSettings() {
  const { environmentId } = useActiveMachine();
  const apiKey = useActiveUnoKey();
  const picker = useHomeModelPicker(environmentId);
  const setup = useHarnessSetup(environmentId);
  const [open, setOpen] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState<string | null>(null);
  const [signOutError, setSignOutError] = useState<{
    readonly driver: string;
    readonly message: string;
  } | null>(null);
  const serverSettings = useEnvironmentSettings(environmentId);
  const { updateSettings: updateEnvironmentSettings } = useUpdateEnvironmentSettings(environmentId);
  const [turningOn, setTurningOn] = useState<string | null>(null);
  // Cursor ships switched off: the row turns it on, then offers Install / Connect.
  const turnOn = async (driverName: string) => {
    if (!environmentId || !serverSettings) return;
    const driver = ProviderDriverKind.make(driverName);
    const instanceId = defaultInstanceIdForDriver(driver);
    const legacy = (serverSettings.providers as Record<string, { readonly enabled: boolean }>)[
      driverName
    ];
    const existing: ProviderInstanceConfig = serverSettings.providerInstances?.[instanceId] ?? {
      driver,
      enabled: legacy?.enabled ?? false,
      config: legacy,
    };
    setTurningOn(driverName);
    try {
      await updateEnvironmentSettings(
        buildProviderInstanceUpdatePatch({
          settings: serverSettings,
          instanceId,
          instance: { ...existing, enabled: true },
          driver,
          isDefault: true,
        }),
      );
      await refreshEnvironmentProviders(environmentId, instanceId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't turn the agent on",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTurningOn(null);
    }
  };

  const agents = AGENTS.map((agent) => {
    const entry =
      picker.instanceEntries.find(
        (candidate) => candidate.driverKind === agent.driver && candidate.isDefault,
      ) ?? picker.instanceEntries.find((candidate) => candidate.driverKind === agent.driver);
    const row = subscriptionRowState({
      kind: entry ? resolveProviderPaneKind(entry) : "blocked",
      onUnoAi: entry ? runsOnUnoAi(entry.snapshot) : false,
      accountLabel: entry?.snapshot.auth.label ?? null,
      email: entry?.snapshot.auth.email ?? null,
    });
    return { agent, entry, row };
  });

  // Signed in from a terminal, or the sign-in page was closed: the computer
  // knows first. While a row still asks for a sign-in, ask it again every few
  // seconds and whenever the window comes back — not on the 5-minute schedule.
  const waitsForSignIn = agents.some(({ row }) => row.paneKind === "signin");
  useEffect(() => {
    if (!environmentId || !waitsForSignIn) return;
    const recheck = () => {
      if (document.visibilityState !== "visible") return;
      void refreshEnvironmentProviders(environmentId).catch(() => {});
    };
    const timer = window.setInterval(recheck, AGENTS_RECHECK_MS);
    window.addEventListener("focus", recheck);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", recheck);
    };
  }, [environmentId, waitsForSignIn]);

  return (
    <SettingsPageContainer>
      <SettingsSection title="AI">
        <NewChatModelRow environmentId={environmentId} />
        {apiKey ? (
          <SettingsRow
            title="Uno AI"
            description="AI time this month, premium credit and your balance."
            control={<UnoGatewayBalance apiKey={apiKey} />}
          />
        ) : null}
      </SettingsSection>

      {environmentId ? <DefaultAiSection environmentId={environmentId} /> : null}

      <SettingsSection title="Agents">
        {agents.map(({ agent, entry, row }) => {
          // Claude and ChatGPT sign in (and out) with the person's own account here.
          const authDriver =
            agent.driver === "claudeAgent" || agent.driver === "codex" ? agent.driver : null;
          const ownAccount = authDriver !== null;
          const action =
            row.paneKind === "signin" && !ownAccount
              ? "Connect"
              : subscriptionActionLabel(row, agent);
          const busy = signingOut === agent.driver;
          const description =
            signOutError?.driver === agent.driver
              ? `Couldn't sign out: ${signOutError.message}`
              : row.state === "unoAi"
                ? `Works now on Uno AI (premium credit). Have ${agent.plans ?? "your own plan"}? Sign in to use it instead.`
                : row.state === "connected"
                  ? ownAccount
                    ? `Signed in${row.detail ? ` · ${row.detail}` : ""}. Pick it in any chat, or under "New chats start on".`
                    : agent.driver === "opencode"
                      ? agent.description
                      : `Ready${row.detail ? ` · ${row.detail}` : ""}. Pick it in any chat, or under "New chats start on".`
                  : agent.description;
          const switchedOff = row.state === "none" && (!entry || !entry.enabled);
          const ownKey = agent.driver === "opencode" && row.state === "connected";
          const signOut = async () => {
            if (!authDriver) return;
            const confirmed = window.confirm(
              `Sign out of ${agent.label} on this computer? You can sign in again any time.`,
            );
            if (!confirmed) return;
            setSigningOut(agent.driver);
            setSignOutError(null);
            const result = await setup.signOut(authDriver);
            setSigningOut(null);
            if (!result.signedOut) {
              setSignOutError({
                driver: agent.driver,
                message: result.error ?? "the computer did not answer.",
              });
            }
          };
          return (
            <SettingsRow
              key={agent.driver}
              title={agent.label}
              description={description}
              control={
                row.state === "connected" ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
                      <CheckCircle2Icon className="size-3.5" />
                      {ownAccount ? "Connected" : "Ready"}
                    </span>
                    {ownKey ? (
                      <Button
                        size="xs"
                        variant="outline"
                        data-testid="agent-key-opencode"
                        onClick={() => setOpen(open === agent.driver ? null : agent.driver)}
                      >
                        {open === agent.driver ? "Close" : "Use my own key"}
                      </Button>
                    ) : null}
                    {row.canSignOut && ownAccount ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void signOut()}
                        data-testid={`subscription-sign-out-${agent.driver}`}
                      >
                        {busy ? "Signing out…" : "Sign out"}
                      </Button>
                    ) : null}
                  </span>
                ) : action ? (
                  <Button
                    size="xs"
                    variant="outline"
                    data-testid={`agent-setup-${agent.driver}`}
                    onClick={() => setOpen(open === agent.driver ? null : agent.driver)}
                  >
                    {open === agent.driver ? "Close" : action}
                  </Button>
                ) : switchedOff ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={turningOn === agent.driver || !serverSettings}
                    data-testid={`agent-turn-on-${agent.driver}`}
                    onClick={() => void turnOn(agent.driver)}
                  >
                    {turningOn === agent.driver ? "Turning on…" : "Turn on"}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">Not on this computer</span>
                )
              }
            >
              {open === agent.driver && ownKey ? (
                <div className="mt-3 flex flex-col gap-2">
                  <OpenCodeKeyForm className="mt-0" onSaved={() => setOpen(null)} />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    An Anthropic, OpenRouter or OpenAI key works here. For OpenCode's own plan or
                    any other provider, run <code className="font-mono">opencode auth login</code>{" "}
                    in the Terminal — this page picks it up.
                  </p>
                </div>
              ) : open === agent.driver && entry && row.paneKind ? (
                <div className="-mx-4 mt-3 border-t border-border/60 sm:-mx-5">
                  <ProviderSetupPane
                    entry={entry}
                    kind={row.paneKind}
                    setup={setup}
                    environmentId={environmentId}
                  />
                </div>
              ) : null}
            </SettingsRow>
          );
        })}
      </SettingsSection>

      {environmentId ? (
        <>
          {/* Any other agent: the guide says what it must speak and where its file goes. */}
          <HarnessesSettingsPanel environmentId={environmentId} embedded />
          <AiProviderKeysSection environmentId={environmentId} />
        </>
      ) : null}
    </SettingsPageContainer>
  );
}

// ── Assistants & phone ───────────────────────────────────────────────

export function AssistantsPhoneSettings() {
  const navigate = useNavigate();
  const devMode = useDevMode();
  const { environmentId } = useActiveMachine();
  const channels = useAssistantChannels(environmentId);
  const [connecting, setConnecting] = useState<ConnectChannel | null>(null);
  const phoneUrl = isWebApp && !isElectron ? window.location.origin : PHONE_WORK_URL;
  return (
    <SettingsPageContainer>
      <SettingsSection title="Assistants">
        <LinkRow
          icon={<BotIcon />}
          title="Assistants"
          description="Bots that answer in Telegram or Slack 24/7. Create, pause or delete them."
          onClick={() => void navigate({ to: "/assistants" })}
        />
      </SettingsSection>

      <SettingsSection title="Telegram">
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              <TelegramMark className="size-4" />
              Telegram
            </span>
          }
          description={
            channels.telegram === "on"
              ? `Your assistant answers you in Telegram${channels.telegramBot ? ` as @${channels.telegramBot}` : ""}.`
              : "Scan a QR code with your phone and write to your assistant from anywhere."
          }
          control={
            channels.telegram === "on" ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
                <CheckCircle2Icon className="size-3.5" />
                Connected
              </span>
            ) : environmentId ? (
              <Button size="xs" onClick={() => setConnecting("telegram")}>
                Connect
              </Button>
            ) : null
          }
        />
      </SettingsSection>

      {/* Slack was only in Settings → Full setup (flow-agent 15.10): the same panel, here. */}
      <SettingsSection title="Slack">
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              <SlackBrandMark className="size-4" />
              Slack
            </span>
          }
          description={
            channels.slack === "on"
              ? "Your assistant answers in your Slack workspace."
              : "Mention your assistant in a channel or write to it directly, with your team."
          }
          control={
            channels.slack === "on" ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
                <CheckCircle2Icon className="size-3.5" />
                Connected
              </span>
            ) : environmentId ? (
              <Button
                size="xs"
                onClick={() => setConnecting("slack")}
                data-testid="settings-connect-slack"
              >
                Connect
              </Button>
            ) : null
          }
        />
      </SettingsSection>

      <SettingsSection title="Phone">
        <SettingsRow
          title="Open Uno Work on your phone"
          description="Scan with the phone's camera: Uno Work opens in its browser. Sign in with your Uno account."
        >
          <div className="flex items-center gap-4 pt-3 pb-4">
            <div className="rounded-xl border border-border bg-white p-1.5">
              <QRCodeSvg value={phoneUrl} size={112} title="Open Uno Work on your phone" />
            </div>
            <span className="font-mono text-xs text-muted-foreground">
              {phoneUrl.replace(/^https?:\/\//, "")}
            </span>
          </div>
        </SettingsRow>
        {devMode ? (
          <LinkRow
            icon={<LayersIcon />}
            title="Pair a mobile app (T3 Code)"
            description="The old phone pairing, for developers."
            onClick={() => void navigate({ to: "/settings/app/phone" })}
          />
        ) : null}
      </SettingsSection>

      {environmentId ? (
        <ConnectChannelDialog
          environmentId={environmentId}
          channel={connecting}
          onClose={() => setConnecting(null)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

// ── Computer ─────────────────────────────────────────────────────────

export function ComputerSettings() {
  const navigate = useNavigate();
  const { environmentId, isCloud } = useActiveMachine();
  const rows = useMachineRows();
  const label = rows.find((row) => row.environmentId === environmentId)?.label ?? "This computer";
  const { economy } = useComputerEconomy(environmentId, null);
  return (
    <SettingsPageContainer>
      <SettingsSection title={`Sleep and economy · ${label}`}>
        {economy ? (
          <EconomyCard
            environmentId={environmentId}
            boxId={null}
            className="border-0 bg-transparent"
          />
        ) : (
          <SettingsRow
            title="Sleep and economy"
            description={
              isCloud
                ? "Not offered on this computer's plan."
                : "Sleep and economy are for Uno cloud computers. This one is yours to switch off."
            }
          />
        )}
      </SettingsSection>

      <MachineAccessSections />

      <SettingsSection title="Safety and more">
        <LinkRow
          icon={<LockIcon />}
          title="Security"
          description="Who got in, and what is open to the internet."
          onClick={() => void navigate({ to: "/settings/security" })}
        />
        <LinkRow
          icon={<LayersIcon />}
          title="My computers"
          description="Every computer this app knows, and which one opens first."
          onClick={() => void navigate({ to: "/settings/workspace" })}
        />
        {environmentId ? (
          <LinkRow
            icon={<ArchiveIcon />}
            title="Archived chats"
            description="Chats you archived. Bring them back or delete them."
            onClick={() =>
              void navigate({
                to: "/settings/environment/$environmentId/archived",
                params: { environmentId },
              })
            }
          />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

// ── Developer ────────────────────────────────────────────────────────

export function DeveloperSettings() {
  const navigate = useNavigate();
  const devMode = useDevMode();
  const { environmentId } = useActiveMachine();
  const rows = useMachineRows();
  const flagOverrides = useFeatureFlagOverrides();
  const groups = useMemo(() => {
    const label = rows.find((row) => row.environmentId === environmentId)?.label ?? "This computer";
    return buildSettingsNavGroups({
      isWebApp,
      isFlagEnabled: (flag) => flag === undefined || resolveFeatureFlag(flagOverrides, flag),
      machine: environmentId ? { environmentId, label } : null,
      mode: "classic",
    });
  }, [environmentId, flagOverrides, rows]);
  return (
    <SettingsPageContainer>
      <SettingsSection title="Developer">
        <SettingsRow
          title="Dev mode"
          description="Shows what developers use: agents and harnesses, connections, source control, extensions, credentials, Labs, git and diff tools in chats, every model and agent in the picker, and more chat actions."
          control={
            <Switch
              checked={devMode}
              onCheckedChange={(checked) => setDevMode(Boolean(checked))}
              aria-label="Dev mode"
              data-testid="settings-dev-mode"
            />
          }
        />
      </SettingsSection>
      {devMode
        ? groups.map((group) => (
            <SettingsSection key={group.kind} title={group.heading}>
              {group.entries.map((entry) => {
                const Icon = entry.icon;
                return (
                  <LinkRow
                    key={entry.to}
                    icon={<Icon />}
                    title={entry.label}
                    description={entry.to}
                    onClick={() => void navigate({ to: entry.to })}
                  />
                );
              })}
            </SettingsSection>
          ))
        : null}
    </SettingsPageContainer>
  );
}
