/**
 * One assistant on its own computer (assistants MVP): what it can open
 * (connector permissions, stored and checked by the console), its schedule,
 * "Memory & models" (AssistantMemoryModels.tsx: memory files, the routing
 * table, chats it started and their cost, computers it can use), its
 * channels and chat.
 *
 * Access and schedule come from the console and work while the computer
 * sleeps; memory, channels and chat need the computer awake and connected.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  AlarmClockIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  PowerIcon,
  Trash2Icon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { ensureAssistantChatWhenReady } from "../../assistant/assistantChat.logic";
import { waitForThreadInStore } from "../../assistant/useAssistantChat";
import {
  deleteAssistantComputer,
  deleteAssistantSchedule,
  getConnectorPermissions,
  listAssistantSchedules,
  putConnectorPermissions,
} from "../../lib/assistantsConsoleApi";
import { ensureAssistantChat } from "../../lib/managerApi";
import {
  listConnectors,
  openAuthWindow,
  startConnector,
  type SetupConnector,
} from "../../lib/setupApi";
import { readLocalApi } from "../../localApi";
import { useStore } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { connectUnoBoxById } from "../../unoBoxConnect";
import { ConnectChannelDialog, type ConnectChannel } from "../assistant/ConnectChannelDialog";
import { SlackBrandMark, TelegramMark } from "../setup/brandMarks";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Block, EmojiAvatar, LevelPicker, StatusPill } from "./AssistantBits";
import { ChatsBlock, ComputersBlock, MemoryBlock, ModelsBlock } from "./AssistantMemoryModels";
import {
  CONNECTOR_LABEL,
  CONNECTOR_PROVIDERS,
  describeCron,
  findTemplate,
  type ConnectorLevel,
  type ConnectorPermissions,
  type ConnectorProvider,
} from "./assistantTemplates";
import { pendingAssistantSetup, setUpAssistantOnComputer } from "./createAssistant";
import {
  ASSISTANT_COMPUTERS_KEY,
  computerSetupDeps,
  type AssistantListItem,
} from "./useAssistants";

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export function AssistantPage({
  item,
  accountEnvironmentId,
  onDeleted,
}: {
  item: AssistantListItem;
  /** The computer this page talks to (holds the account for waking). */
  accountEnvironmentId: EnvironmentId;
  onDeleted: () => void;
}) {
  const { computer, environmentId } = item;
  const { label, boxId } = computer;
  const name = label.name;
  const template = findTemplate(label.template);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setActiveEnvironmentId = useStore((state) => state.setActiveEnvironmentId);
  const [busy, setBusy] = useState<null | "chat" | "wake" | "finish" | "delete">(null);
  const [connecting, setConnecting] = useState<ConnectChannel | null>(null);
  const [pending, setPending] = useState(() => pendingAssistantSetup.get(boxId));

  const wake = async (): Promise<EnvironmentId | null> => {
    if (environmentId) return environmentId;
    setBusy("wake");
    try {
      const record = await connectUnoBoxById(accountEnvironmentId, boxId, computer.boxName);
      void queryClient.invalidateQueries({ queryKey: ASSISTANT_COMPUTERS_KEY });
      return record.environmentId;
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Couldn't wake ${name}`,
        description: errorText(cause, "Its computer didn't answer. Try again in a minute."),
      });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const talk = async () => {
    const target = await wake();
    if (!target) return;
    setBusy("chat");
    try {
      const chat = await ensureAssistantChatWhenReady(() =>
        ensureAssistantChat({ environmentId: target }),
      );
      if (!chat) throw new Error("Its chat isn't ready yet. Try again in a moment.");
      setActiveEnvironmentId(target);
      await waitForThreadInStore(target, chat.threadId, 5_000);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId: target, threadId: chat.threadId }),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Couldn't open the chat with ${name}`,
        description: errorText(cause, "Its computer didn't answer."),
      });
    } finally {
      setBusy(null);
    }
  };

  const finishSetup = async () => {
    if (!pending) return;
    const target = await wake();
    if (!target) return;
    setBusy("finish");
    try {
      const ok = await setUpAssistantOnComputer(
        computerSetupDeps,
        target,
        pending,
        boxId,
        new Date().toISOString(),
      );
      if (!ok) throw new Error("Its computer is still starting. Try again in a minute.");
      pendingAssistantSetup.clear(boxId);
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: ["uno-assistant-memory", boxId] });
      toastManager.add({ type: "success", title: `${name} is ready` });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't finish the setup",
        description: errorText(cause, "Its computer didn't answer."),
      });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const question = [
      `Delete ${name}?`,
      "Its computer, its memory and its schedule are deleted. Your other assistants and computers stay as they are.",
    ].join("\n");
    const api = readLocalApi();
    const confirmed = api ? await api.dialogs.confirm(question) : window.confirm(question);
    if (!confirmed) return;
    setBusy("delete");
    try {
      await deleteAssistantComputer(boxId);
      pendingAssistantSetup.clear(boxId);
      void queryClient.invalidateQueries({ queryKey: ASSISTANT_COMPUTERS_KEY });
      onDeleted();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Couldn't delete ${name}`,
        description: errorText(cause, "Uno didn't answer."),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-5" data-testid="assistant-page">
      <div className="flex items-start gap-3">
        <EmojiAvatar emoji={label.emoji} className="size-12 text-2xl" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">{name}</h1>
            <StatusPill status={item.status} />
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {template ? template.title : "Assistant"} · its own computer, {computer.boxName}
          </p>
        </div>
        <Button size="sm" onClick={() => void talk()} disabled={busy !== null}>
          {busy === "chat" || busy === "wake" ? (
            <LoaderCircleIcon className="size-4 animate-spin" />
          ) : (
            <MessageSquareIcon className="size-4" />
          )}
          Chat
        </Button>
      </div>

      {pending ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-warning/8 px-4 py-3 text-sm">
          <WrenchIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            {name}'s computer was still starting when you created it. Finish the setup to give it
            its instructions.
          </span>
          <Button size="sm" onClick={() => void finishSetup()} disabled={busy !== null}>
            {busy === "finish" ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
            Finish setup
          </Button>
        </div>
      ) : null}

      <AccessBlock boxId={boxId} name={name} accountEnvironmentId={accountEnvironmentId} />
      <ScheduleBlock boxId={boxId} name={name} />
      <MemoryBlock
        name={name}
        environmentId={environmentId}
        waking={busy === "wake"}
        onWake={() => void wake()}
      />
      <ModelsBlock
        name={name}
        environmentId={environmentId}
        waking={busy === "wake"}
        onWake={() => void wake()}
      />
      <ChatsBlock
        name={name}
        environmentId={environmentId}
        waking={busy === "wake"}
        onWake={() => void wake()}
      />
      <ComputersBlock name={name} boxId={boxId} />

      <Block title="Answers in">
        {environmentId ? (
          <div className="flex flex-wrap gap-2 py-1">
            <Button size="sm" variant="outline" onClick={() => setConnecting("telegram")}>
              <TelegramMark className="size-4" />
              Connect Telegram
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConnecting("slack")}>
              <SlackBrandMark className="size-4" />
              Connect Slack
            </Button>
          </div>
        ) : (
          <p className="py-1 text-sm text-muted-foreground">
            Here, in Uno Work. Wake {name} to connect Telegram or Slack.
          </p>
        )}
      </Block>

      <div className="flex flex-wrap items-center gap-2">
        {environmentId ? null : (
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void wake()}>
            <PowerIcon className="size-3.5" />
            Wake up
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          disabled={busy !== null}
          onClick={() => void remove()}
          data-testid="assistant-delete"
        >
          <Trash2Icon className="size-3.5" />
          Delete {name}
        </Button>
      </div>

      {environmentId ? (
        <ConnectChannelDialog
          environmentId={environmentId}
          channel={connecting}
          onClose={() => setConnecting(null)}
        />
      ) : null}
    </section>
  );
}

/** One line about the app itself on the account: connected, not yet, or not offered yet. */
function appState(connector: SetupConnector | undefined): {
  text: string;
  canConnect: boolean;
} {
  if (!connector) return { text: "", canConnect: false };
  if (!connector.available) return { text: "Coming soon to Uno", canConnect: false };
  if (connector.needsReconnect) return { text: "Needs signing in again", canConnect: true };
  if (connector.connected) {
    return {
      text: connector.account ? `Connected · ${connector.account}` : "Connected",
      canConnect: false,
    };
  }
  return { text: "Not connected yet", canConnect: true };
}

function AccessBlock({
  boxId,
  name,
  accountEnvironmentId,
}: {
  boxId: number;
  name: string;
  /** The person's computer: apps are connected once per account, from there. */
  accountEnvironmentId: EnvironmentId;
}) {
  const queryClient = useQueryClient();
  const key = ["uno-assistant-access", boxId] as const;
  const access = useQuery({
    queryKey: key,
    queryFn: () => getConnectorPermissions(boxId),
    retry: false,
  });
  const appsKey = ["uno-assistant-apps", accountEnvironmentId] as const;
  const apps = useQuery({
    queryKey: appsKey,
    queryFn: () => listConnectors({ environmentId: accountEnvironmentId }),
    retry: false,
    staleTime: 30_000,
  });
  const [saving, setSaving] = useState<ConnectorProvider | null>(null);

  const change = async (
    current: ConnectorPermissions,
    provider: ConnectorProvider,
    level: ConnectorLevel,
  ) => {
    setSaving(provider);
    try {
      // The console takes the whole computer: every provider goes.
      const saved = await putConnectorPermissions(boxId, { ...current, [provider]: level });
      if (!saved) throw new Error("Your account doesn't have per-assistant access yet.");
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't change the access",
        description: errorText(cause, "Uno didn't answer."),
      });
    } finally {
      setSaving(null);
    }
  };

  const connect = async (provider: ConnectorProvider) => {
    try {
      const { authorizeUrl } = await startConnector({
        environmentId: accountEnvironmentId,
        provider,
      });
      await openAuthWindow(authorizeUrl, "uno-connector");
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Couldn't connect ${CONNECTOR_LABEL[provider]}`,
        description: errorText(cause, "Uno didn't answer."),
      });
    } finally {
      void queryClient.invalidateQueries({ queryKey: appsKey });
    }
  };

  const data = access.data;
  const connectors = apps.data?.available ? apps.data.connectors : [];
  return (
    <Block title={`Apps ${name} can open`} testId="assistant-access">
      {access.isLoading ? (
        <p className="py-1 text-sm text-muted-foreground">Loading…</p>
      ) : access.isError ? (
        <p className="py-1 text-sm text-muted-foreground">
          Couldn't load the access: {errorText(access.error, "Uno didn't answer.")}
        </p>
      ) : data && !data.supported ? (
        <p
          className="py-1 text-sm text-muted-foreground"
          data-testid="assistant-access-unsupported"
        >
          Uno can't limit apps per assistant on your account yet. Until it can, {name} reaches every
          app you connected.
        </p>
      ) : data ? (
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
                        {app.canConnect && data.permissions[provider] !== "none" ? (
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
                    value={data.permissions[provider]}
                    disabled={saving !== null}
                    onChange={(level) => void change(data.permissions, provider, level)}
                    testId={`assistant-access-${provider}`}
                  />
                </div>
              );
            })}
          </div>
          <p className="pt-1 text-xs text-muted-foreground">
            {data.restricted
              ? `Uno checks this on every request. ${name} doesn't even see the tools it can't use.`
              : `No limits set yet: ${name} reaches every app you connected. Pick a level to set them.`}
          </p>
        </>
      ) : null}
    </Block>
  );
}

function ScheduleBlock({ boxId, name }: { boxId: number; name: string }) {
  const queryClient = useQueryClient();
  const key = ["uno-assistant-schedule", boxId] as const;
  const schedules = useQuery({
    queryKey: key,
    queryFn: () => listAssistantSchedules(boxId),
    retry: false,
  });
  const [removing, setRemoving] = useState<number | null>(null);

  const remove = async (id: number) => {
    setRemoving(id);
    try {
      await deleteAssistantSchedule(id);
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't remove it from the schedule",
        description: errorText(cause, "Uno didn't answer."),
      });
    } finally {
      setRemoving(null);
    }
  };

  const list = schedules.data ?? [];
  return (
    <Block title="Schedule" testId="assistant-schedule">
      {schedules.isLoading ? (
        <p className="py-1 text-sm text-muted-foreground">Loading…</p>
      ) : list.length === 0 ? (
        <p className="py-1 text-sm text-muted-foreground">
          Nothing on schedule. Ask {name} in the chat, for example: "every Monday at 10:00 send me a
          report".
        </p>
      ) : (
        <ul className="flex flex-col">
          {list.map((task) => (
            <li key={task.id} className="flex items-start gap-3 py-2">
              <AlarmClockIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm">{describeCron(task.cron)}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {task.prompt ?? task.name}
                  {task.state === "paused" ? " · paused" : ""}
                </span>
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Remove from schedule"
                disabled={removing !== null}
                onClick={() => void remove(task.id)}
              >
                {removing === task.id ? (
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                ) : (
                  <XIcon className="size-3.5" />
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}
