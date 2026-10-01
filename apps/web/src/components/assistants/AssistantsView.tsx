/**
 * Assistants (simplification 01.10) — bots that answer in Telegram or Slack
 * 24/7. Empty until the person creates one; creating is two steps:
 *
 *   1. a name and "what it does" (one line, can be skipped);
 *   2. where it answers: Telegram by Uno's bot with a QR (default, the
 *      goal-first flow people like), "My own Telegram bot" (BotFather),
 *      Slack, or "Only here".
 *
 * The card of an assistant says where it answers, which computer it lives on,
 * its last conversations, and has Pause and Delete.
 *
 * v1: one assistant per computer — the computer's Hermes assistant, see
 * `assistantEntity.ts` for why and where its name lives.
 */
import { ASSISTANT_PROJECT_ID, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  MessageSquareIcon,
  MonitorIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SendIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useAssistantChat } from "../../assistant/useAssistantChat";
import { useAssistantConversations } from "../../assistant/useAssistantConversations";
import { useDevMode } from "../../devMode";
import {
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "../../environments/settings/serverSettings";
import { useActiveMachine } from "../../hooks/useActiveMachine";
import { useMachineRows } from "../../hooks/useMachineRows";
import {
  getAssistant,
  readAssistantFile,
  saveAssistantSlack,
  saveAssistantTelegram,
  writeAssistantFile,
} from "../../lib/managerApi";
import { getSlackInstall, removeSlackInstall } from "../../lib/setupApi";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ConnectChannelDialog, type ConnectChannel } from "../assistant/ConnectChannelDialog";
import { openInstallDocs } from "../onboarding/harnessInstallLinks";
import { SlackBrandMark, TelegramMark } from "../setup/brandMarks";
import { EMPTY_SETUP_PROGRESS } from "../setup/setupModel";
import { AssistantSlackPanel, AssistantTelegramPanel } from "../setup/steps/ChannelsStep";
import { SidebarShowButton } from "../sidebar/SidebarShowButton";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  ASSISTANT_ABOUT_MAX,
  ASSISTANT_NAME_KEY,
  ASSISTANT_ABOUT_KEY,
  ASSISTANT_NAME_MAX,
  DEFAULT_ASSISTANT_NAME,
  ONE_ASSISTANT_NOTE,
  assistantEntity,
  assistantWhereLine,
  withAgentsProfile,
  withAssistantProfile,
  withAssistantWhere,
  withoutAssistant,
  type AssistantEntity,
  type AssistantWhere,
} from "./assistantEntity";

export interface AssistantsRouteSearch {
  /** "new" — the two-step Create; "card" — the assistant's card. */
  readonly view?: "new" | "card";
}

const SUMMARY_KEY = ["uno-assistant", "summary"] as const;

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** The computer's assistant, its connectors, and the person's name for it. */
function useAssistantModel(environmentId: EnvironmentId | null) {
  const settings = useEnvironmentSettings(environmentId);
  const { updateSettings } = useUpdateEnvironmentSettings(environmentId);
  const progress = settings?.setup ?? EMPTY_SETUP_PROGRESS;
  const summary = useQuery({
    queryKey: [...SUMMARY_KEY, environmentId],
    queryFn: () => getAssistant({ environmentId: environmentId!, projectId: ASSISTANT_PROJECT_ID }),
    enabled: environmentId !== null,
    refetchInterval: 10_000,
    retry: false,
  });
  const entity = useMemo(
    () =>
      assistantEntity(progress, {
        telegram: summary.data?.telegram ?? null,
        slack: summary.data?.slack ?? null,
      }),
    [progress, summary.data],
  );
  const saveProgress = (next: typeof progress) =>
    next === progress ? Promise.resolve() : updateSettings({ setup: next });
  return { progress, summary, entity, saveProgress, loading: settings === null };
}

function useMachineLabel(environmentId: EnvironmentId | null): string {
  const rows = useMachineRows();
  return rows.find((row) => row.environmentId === environmentId)?.label ?? "this computer";
}

export function AssistantsView() {
  const search = useSearch({ strict: false }) as AssistantsRouteSearch;
  const navigate = useNavigate();
  const { environmentId } = useActiveMachine();
  const model = useAssistantModel(environmentId);
  const machineLabel = useMachineLabel(environmentId);
  const setView = (view: AssistantsRouteSearch["view"]) =>
    void navigate({ to: "/assistants", search: view ? { view } : {} });

  const creating = search.view === "new";
  const showCard = search.view === "card" && model.entity !== null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex min-h-8 items-center gap-2">
            <SidebarShowButton />
            {creating || showCard ? (
              <Button size="xs" variant="ghost" onClick={() => setView(undefined)}>
                <ArrowLeftIcon className="size-3.5" />
                <span className="hidden sm:inline">Assistants</span>
              </Button>
            ) : (
              <>
                <BotIcon className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">Assistants</span>
              </>
            )}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 pt-2 sm:pt-6">
            {environmentId === null ? (
              <p className="text-sm text-muted-foreground">No computer is connected.</p>
            ) : creating && model.loading ? null : creating ? (
              <CreateAssistant
                environmentId={environmentId}
                machineLabel={machineLabel}
                model={model}
                onDone={() => setView("card")}
              />
            ) : showCard ? (
              <AssistantCard
                environmentId={environmentId}
                machineLabel={machineLabel}
                entity={model.entity!}
                model={model}
                onDeleted={() => setView(undefined)}
              />
            ) : model.entity ? (
              <>
                <AssistantRow
                  entity={model.entity}
                  machineLabel={machineLabel}
                  onOpen={() => setView("card")}
                />
                <p className="px-1 text-xs text-muted-foreground" data-testid="assistants-one-note">
                  {ONE_ASSISTANT_NOTE}
                </p>
              </>
            ) : (
              <EmptyAssistants
                machineLabel={machineLabel}
                loading={model.loading}
                onCreate={() => setView("new")}
              />
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

function EmptyAssistants({
  machineLabel,
  loading,
  onCreate,
}: {
  machineLabel: string;
  loading: boolean;
  onCreate: () => void;
}) {
  return (
    <section
      className="flex flex-col items-center gap-4 rounded-3xl border border-dashed border-border px-6 py-12 text-center"
      data-testid="assistants-empty"
    >
      <span className="flex size-14 items-center justify-center rounded-2xl bg-sky-500/10 text-sky-500">
        <TelegramMark className="size-7" />
      </span>
      <div className="flex max-w-md flex-col gap-1.5">
        <h1 className="text-xl font-semibold tracking-tight">
          Create an assistant that answers in Telegram 24/7
        </h1>
        <p className="text-sm text-muted-foreground">
          Write to it like to a colleague: it answers questions, does tasks on {machineLabel} and
          remembers what you told it.
        </p>
      </div>
      <Button onClick={onCreate} disabled={loading} data-testid="assistants-empty-create">
        <PlusIcon className="size-4" />
        Create an assistant
      </Button>
    </section>
  );
}

function AssistantAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-xl bg-primary font-semibold text-primary-foreground",
        className,
      )}
    >
      {(name.trim()[0] ?? "A").toUpperCase()}
    </span>
  );
}

function StatusDot({ entity }: { entity: AssistantEntity }) {
  const on = entity.telegramOn || entity.slackOn;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className={cn(
          "size-1.5 rounded-full",
          on ? "bg-success" : entity.paused ? "bg-warning" : "bg-muted-foreground/40",
        )}
        aria-hidden
      />
      {on ? "Connected" : entity.paused ? "Paused" : "Not connected yet"}
    </span>
  );
}

function AssistantRow({
  entity,
  machineLabel,
  onOpen,
}: {
  entity: AssistantEntity;
  machineLabel: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="assistants-row"
      className="flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-border/70 bg-card/40 px-4 py-3.5 text-left transition-colors hover:bg-accent/40"
    >
      <AssistantAvatar name={entity.name} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">{entity.name}</span>
          <StatusDot entity={entity} />
        </span>
        {entity.about ? (
          <span className="block truncate text-xs text-muted-foreground">{entity.about}</span>
        ) : null}
        <span className="block truncate text-xs text-muted-foreground">
          {assistantWhereLine(entity)} · on {machineLabel}
        </span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

type Model = ReturnType<typeof useAssistantModel>;

// ── Create: two steps ────────────────────────────────────────────────

const WHERE_OPTIONS: ReadonlyArray<{
  readonly id: AssistantWhere;
  readonly title: string;
  readonly body: string;
  readonly icon: ReactNode;
}> = [
  {
    id: "telegram",
    title: "Telegram",
    body: "Scan a QR code with your phone. Nothing to set up.",
    icon: <TelegramMark className="size-5" />,
  },
  {
    id: "own_bot",
    title: "My own Telegram bot",
    body: "Your bot's name and picture. Made with @BotFather.",
    icon: <SendIcon className="size-4 text-sky-500" />,
  },
  {
    id: "slack",
    title: "Slack",
    body: "In your team's channels.",
    icon: <SlackBrandMark className="size-5" />,
  },
  {
    id: "here",
    title: "Only here",
    body: "Talk to it in Uno Work. Add Telegram later.",
    icon: <MessageSquareIcon className="size-4 text-muted-foreground" />,
  },
];

function CreateAssistant({
  environmentId,
  machineLabel,
  model,
  onDone,
}: {
  environmentId: EnvironmentId;
  machineLabel: string;
  model: Model;
  onDone: () => void;
}) {
  const answers = model.progress.answers;
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState(answers[ASSISTANT_NAME_KEY] ?? "");
  const [about, setAbout] = useState(answers[ASSISTANT_ABOUT_KEY] ?? "");
  const [where, setWhere] = useState<AssistantWhere>("telegram");
  const [saving, setSaving] = useState(false);
  const assistantChat = useAssistantChat();
  const connected = model.entity?.telegramOn === true || model.entity?.slackOn === true;

  const saveProfile = async () => {
    setSaving(true);
    try {
      await model.saveProgress(
        withAssistantProfile(model.progress, { name, about, now: new Date().toISOString() }),
      );
      // Its name and job go into its instructions, between markers (best effort:
      // an older daemon without the file API still gets the assistant).
      void readAssistantFile({ environmentId, projectId: ASSISTANT_PROJECT_ID, name: "AGENTS.md" })
        .then(({ content }) =>
          writeAssistantFile({
            environmentId,
            projectId: ASSISTANT_PROJECT_ID,
            name: "AGENTS.md",
            content: withAgentsProfile(content, { name, about }),
          }),
        )
        .catch(() => undefined);
      setStep(2);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't create the assistant",
        description: errorText(cause, "This computer didn't answer."),
      });
    } finally {
      setSaving(false);
    }
  };

  const pick = (next: AssistantWhere) => {
    setWhere(next);
    void model.saveProgress(withAssistantWhere(model.progress, next)).catch(() => undefined);
  };

  const finish = async () => {
    await model.saveProgress(withAssistantWhere(model.progress, where)).catch(() => undefined);
    if (where === "here") {
      await assistantChat.open();
      return;
    }
    onDone();
  };

  return (
    <section className="flex flex-col gap-5" data-testid="assistants-create-flow">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={cn("font-medium", step === 1 && "text-foreground")}>1. About it</span>
        <ChevronRightIcon className="size-3" />
        <span className={cn("font-medium", step === 2 && "text-foreground")}>
          2. Where it answers
        </span>
      </div>

      {step === 1 ? (
        <>
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">New assistant</h1>
            <p className="text-sm text-muted-foreground">
              It lives on {machineLabel} and answers while the computer is on.
            </p>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Name</span>
            <Input
              autoFocus
              value={name}
              maxLength={ASSISTANT_NAME_MAX}
              placeholder={DEFAULT_ASSISTANT_NAME}
              onChange={(event) => setName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveProfile();
                }
              }}
              data-testid="assistants-name"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              What it does <span className="font-normal text-muted-foreground">(optional)</span>
            </span>
            <Textarea
              value={about}
              maxLength={ASSISTANT_ABOUT_MAX}
              rows={2}
              placeholder="For example: answers my customers' questions about prices and opening hours"
              onChange={(event) => setAbout(event.currentTarget.value)}
              data-testid="assistants-about"
            />
          </label>
          <div className="flex justify-end">
            <Button onClick={() => void saveProfile()} disabled={saving}>
              Next
              <ChevronRightIcon className="size-4" />
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">
              Where should {name.trim() || DEFAULT_ASSISTANT_NAME} answer?
            </h1>
            <p className="text-sm text-muted-foreground">
              It answers while {machineLabel} is on. To answer around the clock, keep it awake in
              Settings → Computer.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup">
            {WHERE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={where === option.id}
                onClick={() => pick(option.id)}
                data-testid={`assistants-where-${option.id}`}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-left transition-colors",
                  where === option.id
                    ? "border-primary/60 bg-primary/[0.04] ring-1 ring-primary/30"
                    : "border-border/70 hover:bg-accent/40",
                )}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background">
                  {option.icon}
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {option.title}
                    {option.id === "telegram" ? (
                      <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
                        Recommended
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-xs text-muted-foreground">{option.body}</span>
                </span>
              </button>
            ))}
          </div>
          <div
            className="rounded-2xl border border-border p-4"
            data-testid="assistants-where-panel"
          >
            {where === "telegram" ? (
              <AssistantTelegramPanel key="shared" environmentId={environmentId} />
            ) : where === "own_bot" ? (
              <AssistantTelegramPanel key="own" environmentId={environmentId} initialMode="own" />
            ) : where === "slack" ? (
              <AssistantSlackPanel environmentId={environmentId} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Talk to it in Uno Work. Telegram and Slack can be added later from its card.
              </p>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button
              variant={where === "here" || connected ? "default" : "outline"}
              onClick={() => void finish()}
              data-testid="assistants-finish"
            >
              {where === "here" ? (
                <>
                  <MessageSquareIcon className="size-4" />
                  Talk to it
                </>
              ) : connected ? (
                <>
                  <CheckIcon className="size-4" />
                  Done
                </>
              ) : (
                "Finish later"
              )}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

// ── The assistant's card ─────────────────────────────────────────────

function AssistantCard({
  environmentId,
  machineLabel,
  entity,
  model,
  onDeleted,
}: {
  environmentId: EnvironmentId;
  machineLabel: string;
  entity: AssistantEntity;
  model: Model;
  onDeleted: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const devMode = useDevMode();
  const assistantChat = useAssistantChat();
  const { conversations, openConversation } = useAssistantConversations();
  const [connecting, setConnecting] = useState<ConnectChannel | null>(null);
  const [busy, setBusy] = useState(false);
  const summary = model.summary.data ?? null;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["uno-assistant"] });

  const setPaused = async (paused: boolean) => {
    if (!summary) return;
    setBusy(true);
    try {
      const tg = summary.telegram;
      if (tg.configured && tg.allowedChatIds.length > 0) {
        await saveAssistantTelegram({
          environmentId,
          projectId: summary.projectId,
          allowedChatIds: tg.allowedChatIds,
          enabled: !paused,
          defaultModelSelection: tg.defaultModelSelection,
          addressing: tg.addressing,
        });
      }
      const sl = summary.slack;
      if (sl.configured) {
        await saveAssistantSlack({
          environmentId,
          projectId: summary.projectId,
          allowedChannelIds: sl.allowedChannelIds,
          enabled: !paused,
        });
      }
      toastManager.add({
        type: "success",
        title: paused ? `${entity.name} is paused` : `${entity.name} answers again`,
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: paused ? "Couldn't pause" : "Couldn't turn it back on",
        description: errorText(cause, "This computer didn't answer."),
      });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const remove = async () => {
    const api = readLocalApi();
    const confirmed = api
      ? await api.dialogs.confirm(
          [
            `Delete ${entity.name}?`,
            "It stops answering in Telegram and Slack. Its conversations stay in Uno Work.",
          ].join("\n"),
        )
      : window.confirm(`Delete ${entity.name}?`);
    if (!confirmed) return;
    setBusy(true);
    try {
      if (summary) {
        const tg = summary.telegram;
        if (tg.configured) {
          await saveAssistantTelegram({
            environmentId,
            projectId: summary.projectId,
            allowedChatIds: [],
            enabled: false,
            defaultModelSelection: tg.defaultModelSelection,
            addressing: tg.addressing,
          });
        }
        if (summary.slack.configured) {
          const install = await getSlackInstall({
            environmentId,
            projectId: ASSISTANT_PROJECT_ID,
          }).catch(() => null);
          if (install?.installed) {
            await removeSlackInstall({ environmentId, projectId: ASSISTANT_PROJECT_ID });
          } else {
            await saveAssistantSlack({
              environmentId,
              projectId: summary.projectId,
              allowedChannelIds: summary.slack.allowedChannelIds,
              enabled: false,
            });
          }
        }
      }
      await model.saveProgress(withoutAssistant(model.progress));
      onDeleted();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't delete the assistant",
        description: errorText(cause, "This computer didn't answer."),
      });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const channelRow = (channel: ConnectChannel) => {
    const isTelegram = channel === "telegram";
    const on = isTelegram ? entity.telegramOn : entity.slackOn;
    const paused = isTelegram ? entity.telegramPaused : entity.slackPaused;
    return (
      <div className="flex items-center gap-3 py-2.5" key={channel}>
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background">
          {isTelegram ? <TelegramMark className="size-4" /> : <SlackBrandMark className="size-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{isTelegram ? "Telegram" : "Slack"}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {on
              ? isTelegram && entity.telegramBot
                ? `Connected · @${entity.telegramBot}`
                : "Connected"
              : paused
                ? "Paused"
                : "Not connected"}
          </span>
        </span>
        {on && isTelegram && entity.telegramBot ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => openInstallDocs(`https://t.me/${entity.telegramBot}`)}
          >
            Open Telegram
          </Button>
        ) : !on && !paused ? (
          <Button
            size="xs"
            variant={isTelegram ? "default" : "outline"}
            onClick={() => setConnecting(channel)}
            data-testid={`assistants-connect-${channel}`}
          >
            Connect
          </Button>
        ) : null}
      </div>
    );
  };

  return (
    <section className="flex flex-col gap-5" data-testid="assistants-card">
      <div className="flex items-start gap-3">
        <AssistantAvatar name={entity.name} className="size-12 text-lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">{entity.name}</h1>
            <StatusDot entity={entity} />
          </div>
          {entity.about ? (
            <p className="mt-0.5 text-sm text-muted-foreground">{entity.about}</p>
          ) : null}
        </div>
        <Button
          size="sm"
          onClick={() => void assistantChat.open()}
          disabled={assistantChat.opening}
        >
          <MessageSquareIcon className="size-4" />
          Talk here
        </Button>
      </div>

      <Block title="Answers in">
        <div className="divide-y divide-border/60">
          {channelRow("telegram")}
          {channelRow("slack")}
        </div>
      </Block>

      <Block title="Lives on">
        <div className="flex items-center gap-3 py-1">
          <MonitorIcon className="size-4 text-muted-foreground" />
          <span className="text-sm">{machineLabel}</span>
          <span className="ml-auto text-xs text-muted-foreground">{ONE_ASSISTANT_NOTE}</span>
        </div>
      </Block>

      <Block title="Last conversations">
        {conversations.length === 0 ? (
          <p className="py-1 text-sm text-muted-foreground">No conversations yet.</p>
        ) : (
          <ul className="flex flex-col">
            {conversations.slice(0, 5).map((thread) => (
              <li key={thread.id}>
                <button
                  type="button"
                  onClick={() => void openConversation(thread.id as ThreadId)}
                  className="-mx-2 flex w-[calc(100%+1rem)] cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-accent/50"
                >
                  <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelativeTimeLabel(thread.updatedAt ?? thread.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <div className="flex flex-wrap items-center gap-2">
        {entity.telegramOn || entity.slackOn ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void setPaused(true)}>
            <PauseIcon className="size-3.5" />
            Pause
          </Button>
        ) : entity.paused ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void setPaused(false)}>
            <PlayIcon className="size-3.5" />
            Resume
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          disabled={busy}
          onClick={() => void remove()}
          data-testid="assistants-delete"
        >
          <Trash2Icon className="size-3.5" />
          Delete
        </Button>
        {devMode ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() =>
              void navigate({
                to: "/settings/environment/$environmentId/assistants",
                params: { environmentId },
              })
            }
          >
            <Settings2Icon className="size-3.5" />
            Advanced settings
          </Button>
        ) : null}
      </div>

      <ConnectChannelDialog
        environmentId={environmentId}
        channel={connecting}
        onClose={() => {
          setConnecting(null);
          refresh();
        }}
      />
    </section>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border/70 px-4 py-3">
      <h2 className="pb-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}
