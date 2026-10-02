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
import { useMemo, useState, type ReactNode } from "react";

import { CONSOLE_URL } from "../../account/accountOverview";
import { accountTransport } from "../../account/unoAccount";
import { useAssistantChannels } from "../../assistant/useAssistantChannels";
import { setDevMode, useDevMode } from "../../devMode";
import { isElectron } from "../../env";
import { useEnvironmentSettings } from "../../environments/settings/serverSettings";
import { resolveFeatureFlag } from "../../featureFlags";
import { useActiveMachine } from "../../hooks/useActiveMachine";
import { useFeatureFlagOverrides } from "../../hooks/useFeatureFlags";
import { useMachineRows } from "../../hooks/useMachineRows";
import { isWebApp } from "../../webMode";
import { ConnectChannelDialog } from "../assistant/ConnectChannelDialog";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { ProviderSetupPane } from "../chat/ProviderSetupPane";
import { resolveProviderPaneKind } from "../chat/modelPickerProviderPane";
import { EconomyCard, useComputerEconomy } from "../computer/EconomyControl";
import { useHomeModelPicker } from "../computer/home/HomeComposer";
import { openInstallDocs } from "../onboarding/harnessInstallLinks";
import { useHarnessSetup } from "../harness/useHarnessSetup";
import { runsOnUnoAi } from "../harness/harnessSetupState";
import { subscriptionRowState } from "./simpleSubscriptionRow.logic";
import { TelegramMark } from "../setup/brandMarks";
import { Button } from "../ui/button";
import { QRCodeSvg } from "../ui/qr-code";
import { Switch } from "../ui/switch";
import { MachineAccessSections } from "./MachineAccessSettings";
import { GeneralSettingsPanel, UnoGatewayBalance } from "./SettingsPanels";
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
              title="AI hours and balance"
              description="Smart and Fast come from your AI hours; Premium models from premium credit."
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

const SUBSCRIPTIONS = [
  {
    driver: "claudeAgent",
    label: "Claude",
    plans: "Claude Pro or Max",
    description: "Your Claude Pro or Max subscription",
  },
  {
    driver: "codex",
    label: "ChatGPT",
    plans: "ChatGPT Plus or Pro",
    description: "Your ChatGPT Plus or Pro subscription",
  },
] as const;

export function AiSettings() {
  const { environmentId } = useActiveMachine();
  const apiKey = useActiveUnoKey();
  const picker = useHomeModelPicker(environmentId);
  const setup = useHarnessSetup(environmentId);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <SettingsPageContainer>
      <SettingsSection title="AI">
        <SettingsRow
          title="Model for new chats"
          description="Smart is a good start. You can change it in any chat."
          control={
            picker.selection ? (
              <ProviderModelPicker
                compact
                activeInstanceId={picker.selection.instanceId}
                model={picker.selection.model}
                lockedProvider={null}
                instanceEntries={picker.instanceEntries}
                environmentId={environmentId}
                modelOptionsByInstance={picker.modelOptionsByInstance}
                onInstanceModelChange={picker.pick}
                triggerVariant="outline"
              />
            ) : (
              <span className="text-xs text-muted-foreground">No AI on this computer yet</span>
            )
          }
        />
        {apiKey ? (
          <SettingsRow
            title="Uno AI"
            description="AI hours this month, and premium credit."
            control={<UnoGatewayBalance apiKey={apiKey} />}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Your subscription">
        {SUBSCRIPTIONS.map((sub) => {
          const entry =
            picker.instanceEntries.find(
              (candidate) => candidate.driverKind === sub.driver && candidate.isDefault,
            ) ?? picker.instanceEntries.find((candidate) => candidate.driverKind === sub.driver);
          const row = subscriptionRowState({
            kind: entry ? resolveProviderPaneKind(entry) : "blocked",
            onUnoAi: entry ? runsOnUnoAi(entry.snapshot) : false,
            accountLabel: entry?.snapshot.auth.label ?? null,
            email: entry?.snapshot.auth.email ?? null,
          });
          const description =
            row.state === "unoAi"
              ? `Works now on Uno AI (premium credit). Have ${sub.plans}? Sign in to use it instead.`
              : row.state === "connected"
                ? `Signed in${row.detail ? ` · ${row.detail}` : ""}. Pick its model under "Model for new chats".`
                : sub.description;
          return (
            <SettingsRow
              key={sub.driver}
              title={sub.label}
              description={description}
              control={
                row.state === "connected" ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
                    <CheckCircle2Icon className="size-3.5" />
                    Connected
                  </span>
                ) : row.paneKind ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setOpen(open === sub.driver ? null : sub.driver)}
                  >
                    {open === sub.driver ? "Close" : row.state === "unoAi" ? "Sign in" : "Connect"}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">Not on this computer</span>
                )
              }
            >
              {open === sub.driver && entry && row.paneKind ? (
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
    </SettingsPageContainer>
  );
}

// ── Assistants & phone ───────────────────────────────────────────────

export function AssistantsPhoneSettings() {
  const navigate = useNavigate();
  const devMode = useDevMode();
  const { environmentId } = useActiveMachine();
  const channels = useAssistantChannels(environmentId);
  const [connecting, setConnecting] = useState(false);
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
              <Button size="xs" onClick={() => setConnecting(true)}>
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
          channel={connecting ? "telegram" : null}
          onClose={() => setConnecting(false)}
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
