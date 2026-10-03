/**
 * An assistant that lives on THIS computer (decision 02.10 evening: "by
 * default — right here"): a folder in ~/UnoWork/Assistants with its own
 * memory, models, apps and channels; several per computer.
 *
 * What it can open is checked by Work on this computer, not by the console —
 * the console sees one machine token for every assistant here. The page says
 * so in one line, and offers "Give it its own computer" (the assistant MVP's
 * computer of role `assistant`) for assistants that read other people's
 * emails or sites.
 */
import {
  ASSISTANT_PROJECT_ID,
  type AssistantAppLevel,
  type EnvironmentId,
  type ManagerAssistantSummary,
  type ProjectId,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  LoaderCircleIcon,
  MessageSquareIcon,
  MonitorIcon,
  ShieldIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { waitForThreadInStore } from "../../assistant/useAssistantChat";
import {
  deleteLocalAssistant,
  ensureAssistantChat,
  getAssistantApps,
  putAssistantApps,
  readAssistantFile,
  writeAssistantFile,
} from "../../lib/managerApi";
import { listConnectors, openAuthWindow, startConnector } from "../../lib/setupApi";
import { readLocalApi } from "../../localApi";
import { useStore } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ConnectChannelDialog, type ConnectChannel } from "../assistant/ConnectChannelDialog";
import { SlackBrandMark, TelegramMark } from "../setup/brandMarks";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Block, EmojiAvatar, LevelPicker } from "./AssistantBits";
import { ChatsBlock, MemoryBlock, ModelsBlock } from "./AssistantMemoryModels";
import { appState, ScheduleBlock } from "./AssistantPage";
import {
  CONNECTOR_LABEL,
  CONNECTOR_PROVIDERS,
  findTemplate,
  type AssistantPlan,
  type ConnectorLevel,
  type ConnectorPermissions,
  type ConnectorProvider,
} from "./assistantTemplates";
import { createAssistant as createOwnComputerAssistant } from "./createAssistant";
import {
  ASSISTANT_COMPUTERS_KEY,
  LOCAL_ASSISTANTS_KEY,
  makeCreateAssistantDeps,
  useAssistantsAvailability,
} from "./useAssistants";

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** The caption of the option, for New assistant and this page alike. */
export const OWN_COMPUTER_CAPTION =
  "Safer for assistants that read other people's emails or sites: if one gets tricked, your main computer is untouched.";

/** Templates whose assistants read strangers' mail and sites: the option is highlighted. */
export function suggestsOwnComputer(template: string | null | undefined): boolean {
  return template === "marketing" || template === "support";
}

/** "## My job" of SOUL.md, for the plan of a moved assistant. */
export function jobFromSoul(soul: string): string | null {
  const lines = soul.split("\n");
  const at = lines.findIndex((line) => /^##\s+my job/i.test(line.trim()));
  if (at === -1) return null;
  const job: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    if (line.trim().length > 0) job.push(line.trim());
  }
  return job.length > 0 ? job.join(" ") : null;
}

/** Every provider the page shows; one the person never set is full access. */
export function connectorLevels(
  permissions: Readonly<Record<string, AssistantAppLevel>>,
): ConnectorPermissions {
  return Object.fromEntries(
    CONNECTOR_PROVIDERS.map((provider) => [provider, permissions[provider] ?? "write"]),
  ) as ConnectorPermissions;
}

export function LocalAssistantPage({
  summary,
  environmentId,
  machineLabel,
  boxId,
  onDeleted,
  onMoved,
}: {
  summary: ManagerAssistantSummary;
  /** This computer: the assistant lives here. */
  environmentId: EnvironmentId;
  machineLabel: string;
  /** This computer's box (schedules wake it), null when it has none. */
  boxId: number | null;
  onDeleted: () => void;
  onMoved: (boxId: number) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setActiveEnvironmentId = useStore((state) => state.setActiveEnvironmentId);
  const projectId = summary.projectId;
  const name = summary.title;
  const template = findTemplate(summary.profile?.template ?? null);
  const emoji = summary.profile?.emoji ?? template?.emoji ?? "🤖";
  const [busy, setBusy] = useState<null | "chat" | "delete" | "move">(null);
  const [connecting, setConnecting] = useState<ConnectChannel | null>(null);
  const availability = useAssistantsAvailability();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: LOCAL_ASSISTANTS_KEY });

  const talk = async () => {
    setBusy("chat");
    try {
      const chat = await ensureAssistantChat({ environmentId, projectId });
      setActiveEnvironmentId(environmentId);
      await waitForThreadInStore(environmentId, chat.threadId, 5_000);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId, threadId: chat.threadId }),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Couldn't open the chat with ${name}`,
        description: errorText(cause, "This computer didn't answer."),
      });
    } finally {
      setBusy(null);
    }
  };

  const confirm = async (question: string) => {
    const api = readLocalApi();
    return api ? api.dialogs.confirm(question) : window.confirm(question);
  };

  const remove = async () => {
    if (
      !(await confirm([`Delete ${name}?`, "Deleted assistants are kept for 7 days."].join("\n")))
    ) {
      return;
    }
    setBusy("delete");
    try {
      await deleteLocalAssistant({ environmentId, projectId });
      refresh();
      onDeleted();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Couldn't delete ${name}`,
        description: errorText(cause, "This computer didn't answer."),
      });
    } finally {
      setBusy(null);
    }
  };

  /**
   * "Give it its own computer": a computer of role `assistant` with the same
   * name, apps, and its memory and rules copied over; the one here is
   * deleted (kept 7 days) only once the copy is there.
   */
  const move = async () => {
    if (
      !(await confirm(
        [
          `Give ${name} its own computer?`,
          "Its memory, rules and apps move there. Telegram and Slack need connecting again, and the one here is deleted (kept 7 days).",
        ].join("\n"),
      ))
    ) {
      return;
    }
    setBusy("move");
    try {
      const read = (file: "SOUL.md" | "USER.md" | "NOTES.md" | "ROUTING.md") =>
        readAssistantFile({ environmentId, projectId, name: file })
          .then((result) => result.content)
          .catch(() => "");
      const [soul, user, notes, routing] = await Promise.all([
        read("SOUL.md"),
        read("USER.md"),
        read("NOTES.md"),
        read("ROUTING.md"),
      ]);
      const apps = await getAssistantApps({ environmentId, projectId }).catch(() => null);
      const job = jobFromSoul(soul) ?? template?.phrase ?? name;
      const plan: AssistantPlan = {
        name,
        emoji,
        template: template?.id ?? null,
        phrase: job,
        job,
        connectors: connectorLevels(apps?.permissions ?? {}),
        schedule: null,
        answers: [],
        never: template?.never ?? ["Pay for anything"],
      };
      const result = await createOwnComputerAssistant(
        plan,
        makeCreateAssistantDeps(environmentId, plan, () => undefined),
      );
      void queryClient.invalidateQueries({ queryKey: ASSISTANT_COMPUTERS_KEY });
      if (!result.assistantReady || !result.environmentId) {
        toastManager.add({
          type: "warning",
          title: `${name}'s computer is still starting`,
          description: `${name} stays here for now. Open its new computer in a minute, then delete this one.`,
        });
        return;
      }
      for (const [file, content] of [
        ["SOUL.md", soul],
        ["USER.md", user],
        ["NOTES.md", notes],
        ["ROUTING.md", routing],
      ] as const) {
        if (content.trim().length === 0) continue;
        await writeAssistantFile({
          environmentId: result.environmentId,
          projectId: ASSISTANT_PROJECT_ID,
          name: file,
          content,
        });
      }
      await deleteLocalAssistant({ environmentId, projectId });
      refresh();
      toastManager.add({ type: "success", title: `${name} has its own computer now` });
      onMoved(result.boxId);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Couldn't move ${name}`,
        description: errorText(cause, "Uno didn't answer. Nothing changed here."),
      });
    } finally {
      setBusy(null);
    }
  };

  const telegramOn = summary.telegram.configured && summary.telegram.allowedChatIds.length > 0;
  const slackOn = summary.slack.configured && summary.slack.allowedChannelIds.length > 0;
  return (
    <section className="flex flex-col gap-5" data-testid="assistant-local-page">
      <div className="flex items-start gap-3">
        <EmojiAvatar emoji={emoji} className="size-12 text-2xl" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold tracking-tight">{name}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {template ? template.title : "Assistant"} · on this computer, {machineLabel}
          </p>
        </div>
        <Button size="sm" onClick={() => void talk()} disabled={busy !== null}>
          {busy === "chat" ? (
            <LoaderCircleIcon className="size-4 animate-spin" />
          ) : (
            <MessageSquareIcon className="size-4" />
          )}
          Chat
        </Button>
      </div>

      <LocalAppsBlock environmentId={environmentId} projectId={projectId} name={name} />

      <section
        className={
          suggestsOwnComputer(template?.id)
            ? "rounded-2xl border border-primary/40 bg-primary/[0.03] px-4 py-3"
            : "rounded-2xl border border-border/70 px-4 py-3"
        }
        data-testid="assistant-own-computer"
      >
        <div className="flex flex-wrap items-center gap-3">
          <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Give it its own computer</span>
            <span className="block text-xs text-muted-foreground">{OWN_COMPUTER_CAPTION}</span>
          </span>
          <Button
            size="sm"
            variant={suggestsOwnComputer(template?.id) ? "default" : "outline"}
            disabled={busy !== null || availability !== "on"}
            onClick={() => void move()}
            data-testid="assistant-move-own-computer"
          >
            {busy === "move" ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
            Move
          </Button>
        </div>
        {availability !== "on" && availability !== "loading" ? (
          <p className="pt-1 text-xs text-muted-foreground">
            Assistants with their own computer aren't on your account yet.
          </p>
        ) : null}
      </section>

      {boxId !== null ? (
        <ScheduleBlock boxId={boxId} name={name} workspaceRoot={summary.workspaceRoot} />
      ) : null}
      <MemoryBlock
        name={name}
        environmentId={environmentId}
        projectId={projectId}
        waking={false}
        onWake={() => undefined}
      />
      <ModelsBlock
        name={name}
        environmentId={environmentId}
        projectId={projectId}
        waking={false}
        onWake={() => undefined}
      />
      <ChatsBlock
        name={name}
        environmentId={environmentId}
        projectId={projectId}
        whereLabel="This computer"
        waking={false}
        onWake={() => undefined}
      />

      <Block title="Answers in">
        <div className="flex flex-wrap items-center gap-2 py-1">
          <Button size="sm" variant="outline" onClick={() => setConnecting("telegram")}>
            <TelegramMark className="size-4" />
            {telegramOn
              ? `Telegram${summary.telegram.botUsername ? ` · @${summary.telegram.botUsername}` : ""}`
              : "Connect Telegram"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setConnecting("slack")}>
            <SlackBrandMark className="size-4" />
            {slackOn ? "Slack" : "Connect Slack"}
          </Button>
        </div>
      </Block>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          disabled={busy !== null}
          onClick={() => void remove()}
          data-testid="assistant-local-delete"
        >
          <Trash2Icon className="size-3.5" />
          Delete {name}
        </Button>
      </div>

      <ConnectChannelDialog
        telegramMode="own"
        environmentId={environmentId}
        projectId={projectId as ProjectId}
        channel={connecting}
        onClose={() => {
          setConnecting(null);
          refresh();
        }}
      />
    </section>
  );
}

/**
 * Apps it may open, stored and checked by Work on this computer. Full access
 * until the person picks a level (decision 02.10).
 */
function LocalAppsBlock({
  environmentId,
  projectId,
  name,
}: {
  environmentId: EnvironmentId;
  projectId: string;
  name: string;
}) {
  const queryClient = useQueryClient();
  const key = ["uno-assistant-local-apps", environmentId, projectId] as const;
  const access = useQuery({
    queryKey: key,
    queryFn: () => getAssistantApps({ environmentId, projectId }),
    retry: false,
  });
  const apps = useQuery({
    queryKey: ["uno-assistant-apps", environmentId],
    queryFn: () => listConnectors({ environmentId }),
    retry: false,
    staleTime: 30_000,
  });
  const [saving, setSaving] = useState<ConnectorProvider | null>(null);
  const levels = connectorLevels(access.data?.permissions ?? {});

  const change = async (provider: ConnectorProvider, level: ConnectorLevel) => {
    setSaving(provider);
    try {
      await putAssistantApps({
        environmentId,
        projectId,
        permissions: { ...levels, [provider]: level },
      });
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't change the access",
        description: errorText(cause, "This computer didn't answer."),
      });
    } finally {
      setSaving(null);
    }
  };

  const connect = async (provider: ConnectorProvider) => {
    try {
      const { authorizeUrl } = await startConnector({ environmentId, provider });
      await openAuthWindow(authorizeUrl, "uno-connector");
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Couldn't connect ${CONNECTOR_LABEL[provider]}`,
        description: errorText(cause, "Uno didn't answer."),
      });
    } finally {
      void queryClient.invalidateQueries({ queryKey: ["uno-assistant-apps", environmentId] });
    }
  };

  const connectors = apps.data?.available ? apps.data.connectors : [];
  return (
    <Block title={`Apps ${name} can open`} testId="assistant-local-access">
      {access.isLoading ? (
        <p className="py-1 text-sm text-muted-foreground">Loading…</p>
      ) : access.isError ? (
        <p className="py-1 text-sm text-muted-foreground">
          This needs Uno Work 0.0.106 on this computer. Until then, {name} reaches every app you
          connected.
        </p>
      ) : (
        <>
          <div className="divide-y divide-border/60">
            {CONNECTOR_PROVIDERS.map((provider) => {
              const app = appState(connectors.find((entry) => entry.provider === provider));
              return (
                <div key={provider} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{CONNECTOR_LABEL[provider]}</span>
                    {app.text ? (
                      <span className="block text-xs text-muted-foreground">
                        {app.text}
                        {app.canConnect && levels[provider] !== "none" ? (
                          <>
                            {" · "}
                            <button
                              type="button"
                              className="cursor-pointer font-medium text-foreground underline underline-offset-2"
                              onClick={() => void connect(provider)}
                            >
                              Connect
                            </button>
                          </>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                  {saving === provider ? (
                    <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
                  ) : null}
                  <LevelPicker
                    value={levels[provider]}
                    disabled={saving !== null}
                    onChange={(level) => void change(provider, level)}
                    testId={`assistant-local-access-${provider}`}
                  />
                </div>
              );
            })}
          </div>
          <p
            className="flex gap-1.5 pt-1 text-xs text-muted-foreground"
            data-testid="assistant-local-access-honest"
          >
            <ShieldIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Work on this computer checks this on every request. It stops mistakes, not a
              determined attack: assistants on one computer share it. For a wall Uno's servers
              enforce, give {name} its own computer.
            </span>
          </p>
        </>
      )}
    </Block>
  );
}
