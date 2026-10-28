/**
 * Variant A (28.10): the page of the one Uno — and of your own assistants,
 * which live behind its Advanced.
 *
 * Uno's page, top to bottom, only what you'd change:
 * - who it is: face, name (rename in place), where it lives (uno-work, always
 *   on / naps on Free);
 * - how it works: the two modes, as two cards;
 * - its hands: every computer of the account, home first; a switch per
 *   computer it may start chats on;
 * - apps: the account's connectors, the real list (Connect / Sign in again);
 * - where you talk: Telegram in one tap (Uno's bot), here in Work;
 * - channels, memory;
 * - Advanced: your own assistants (the gallery), nothing else.
 *
 * An own assistant's page: face, name, role and character, the two modes,
 * and Remove (it stops what it's doing; its chats stay; Bring back).
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  CloudIcon,
  LaptopIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SendIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { DEMO } from "../../demo/demoFlag";
import {
  createAssistantConversation,
  ensureAssistantChat,
  getAssistantComputers,
  setAssistantComputers,
  startTelegramPairing,
} from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import { openInNewTab } from "../../navigation/useOpenApp";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { ConnectorsList } from "../setup/steps/ConnectorsStep";
import { SidebarShowButton } from "../sidebar/SidebarShowButton";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { AssistantAvatar, avatarImageOf } from "./AssistantAvatar";
import { AssistantFacePicker } from "./AssistantFacePicker";
import { MODE_COPY, ModeIcon, modeOf, useSetAssistantMode } from "./AssistantModeChip";
import { ChatLine, MemoryFile, Pill, Section } from "./AssistantProfileParts";
import { NAME_MAX, cleanName } from "./assistantGallery.logic";
import { ACTIVITY_LABEL } from "./assistantTeam.logic";
import { type TeamMember, useAssistantTeam } from "./useAssistantTeam";
import { LOCAL_ASSISTANTS_KEY } from "./useAssistants";
import { useTeamActions } from "./useTeamActions";
import {
  channelName,
  cleanChannelName,
  orderChannels,
  useUnoHome,
  waitForThread,
} from "./useUnoHome";

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

// ── Pieces ────────────────────────────────────────────────────────────────

/** Name in place: a pencil, an input with a counter, Save. */
function NameEditor(props: { readonly member: TeamMember }) {
  const { member } = props;
  const actions = useTeamActions();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(member.profile.name);
  const [busy, setBusy] = useState(false);
  const clean = cleanName(draft);
  const save = async () => {
    if (clean === null || busy) return;
    setBusy(true);
    try {
      await actions.update(member, { name: clean });
      setEditing(false);
      toastManager.add({ type: "success", title: `Renamed to ${clean}` });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't rename",
        description: errorText(cause, "Its computer didn't answer."),
      });
    } finally {
      setBusy(false);
    }
  };
  if (!editing) {
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <h1
          className="min-w-0 truncate text-xl leading-tight font-semibold"
          title={member.profile.name}
          data-testid="assistant-page-name"
        >
          {member.profile.name}
        </h1>
        {member.revoked ? null : (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Rename"
            title="Rename"
            onClick={() => {
              setDraft(member.profile.name);
              setEditing(true);
            }}
            data-testid="assistant-page-rename"
          >
            <PencilIcon className="size-3.5" />
          </Button>
        )}
      </div>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <input
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        value={draft}
        maxLength={NAME_MAX}
        onChange={(event) => setDraft(event.target.value.slice(0, NAME_MAX))}
        onKeyDown={(event) => {
          if (event.key === "Escape") setEditing(false);
        }}
        aria-label="Name"
        data-testid="assistant-page-name-input"
        className="h-8 w-64 max-w-full rounded-md border border-input bg-background px-2 text-base font-semibold outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      />
      <span className="text-[11px] text-muted-foreground tabular-nums">
        {draft.trim().length}/{NAME_MAX}
      </span>
      <Button
        size="sm"
        type="submit"
        disabled={clean === null || busy}
        data-testid="assistant-page-name-save"
      >
        {busy ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
        Save
      </Button>
      <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
        Cancel
      </Button>
      {clean === null ? <span className="text-xs text-destructive">Give it a name.</span> : null}
    </form>
  );
}

/** The two modes as two cards. */
function ModeCards(props: { readonly member: TeamMember }) {
  const { member } = props;
  const mode = modeOf(member);
  const { set, busy } = useSetAssistantMode();
  return (
    <div className="grid gap-2 p-2 sm:grid-cols-2" data-testid="assistant-page-mode">
      {(["itself", "asks-first"] as const).map((item) => (
        <button
          key={item}
          type="button"
          disabled={busy || member.revoked}
          onClick={() => {
            if (item !== mode) void set(member, item);
          }}
          aria-pressed={item === mode}
          data-testid={`assistant-page-mode-${item}`}
          className={cn(
            "flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-left transition-colors disabled:cursor-default",
            item === mode
              ? "border-primary/60 bg-primary/[0.05] ring-1 ring-primary/30"
              : "border-border hover:bg-accent/50",
          )}
        >
          <ModeIcon mode={item} className="mt-0.5 size-4 shrink-0" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">{MODE_COPY[item].label}</span>
            <span className="text-xs text-muted-foreground">{MODE_COPY[item].detail}</span>
          </span>
          {item === mode ? <CheckIcon className="ml-auto size-4 shrink-0 text-primary" /> : null}
        </button>
      ))}
    </div>
  );
}

/** Every computer of the account: its home first, then the ones it may use as hands. */
function Hands(props: { readonly member: TeamMember }) {
  const { member } = props;
  const queryClient = useQueryClient();
  const key = ["uno-assistant", "computers", member.environmentId, member.projectId];
  const computers = useQuery({
    queryKey: key,
    queryFn: () =>
      getAssistantComputers({
        environmentId: member.environmentId as EnvironmentId,
        projectId: member.projectId,
      }),
    retry: false,
  });
  const [saving, setSaving] = useState<string | null>(null);
  const list = computers.data?.computers ?? [];
  const toggle = async (environmentId: string, on: boolean) => {
    setSaving(environmentId);
    try {
      const allowed = list
        .filter((item) => !item.home && (item.environmentId === environmentId ? on : item.allowed))
        .map((item) => item.environmentId);
      await setAssistantComputers({
        environmentId: member.environmentId as EnvironmentId,
        projectId: member.projectId,
        computers: allowed,
      });
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't change it",
        description: errorText(cause, "Its computer didn't answer."),
      });
    } finally {
      setSaving(null);
    }
  };
  if (computers.isLoading) {
    return (
      <p className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground">
        <LoaderCircleIcon className="size-3.5 animate-spin" /> Asking your computers…
      </p>
    );
  }
  const ordered = list.toSorted((a, b) => Number(b.home) - Number(a.home));
  return (
    <div data-testid="assistant-page-hands">
      {ordered.map((item) => (
        <div
          key={item.environmentId}
          className="flex min-h-11 items-center gap-2.5 border-t border-border/70 px-3 py-1.5 first:border-t-0"
          data-testid="assistant-page-hand"
          data-computer={item.label}
        >
          {item.kind === "cloud" ? (
            <CloudIcon className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <LaptopIcon className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{item.label}</span>
            <span className="truncate text-xs text-muted-foreground">
              {item.home
                ? "Home — Uno lives here"
                : item.awake
                  ? "Online"
                  : "Asleep — its tasks wait until it wakes"}
            </span>
          </span>
          {item.home ? (
            <Pill muted>Home</Pill>
          ) : (
            <Switch
              checked={item.allowed}
              disabled={saving !== null}
              onCheckedChange={(checked) => void toggle(item.environmentId, checked)}
              aria-label={`Let ${member.profile.name} work on ${item.label}`}
              data-testid={`assistant-page-hand-toggle-${item.key}`}
            />
          )}
        </div>
      ))}
      <p className="border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">
        It starts chats on these computers by itself. You see them in the sidebar and in Needs you.
      </p>
    </div>
  );
}

/** Telegram in one tap: Uno's bot, press Start, done. */
function TelegramRow(props: { readonly member: TeamMember }) {
  const { member } = props;
  const actions = useTeamActions();
  const [waiting, setWaiting] = useState(false);
  const telegram = member.summary?.telegram;
  const linked = telegram?.configured === true;
  const connect = async () => {
    setWaiting(true);
    try {
      const pair = await startTelegramPairing({
        environmentId: member.environmentId as EnvironmentId,
        projectId: member.projectId,
      });
      // The demo has no Telegram to open; a real one opens the bot to press Start.
      if (pair.link && !DEMO) openInNewTab(pair.link);
      for (let tries = 0; tries < 12; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await actions.refresh();
      }
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't open Telegram",
        description: errorText(cause, "Its computer didn't answer."),
      });
    } finally {
      setWaiting(false);
    }
  };
  return (
    <div className="flex h-11 items-center gap-2.5 px-3" data-testid="assistant-page-telegram">
      <SendIcon className="size-4 shrink-0 text-sky-500" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">Telegram</span>
        <span className="truncate text-xs text-muted-foreground">
          {linked
            ? `@${telegram?.botUsername ?? "uno_team_bot"} · only decisions and the morning summary`
            : "Answer and Allow from your phone"}
        </span>
      </span>
      {linked ? (
        <Pill>Linked</Pill>
      ) : waiting ? (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 animate-spin" /> Press Start in Telegram…
        </span>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void connect()}
          data-testid="assistant-page-telegram-connect"
        >
          Connect Telegram
        </Button>
      )}
    </div>
  );
}

function Advanced(props: { readonly children: ReactNode; readonly defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  return (
    <section className="flex flex-col gap-3" data-testid="assistant-page-advanced">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-fit cursor-pointer items-center gap-1 px-1 text-[13px] font-medium text-muted-foreground hover:text-foreground"
        data-testid="assistant-page-advanced-toggle"
      >
        <ChevronRightIcon className={cn("size-4 transition-transform", open && "rotate-90")} />
        Advanced
        <span className="font-normal">· your own assistants</span>
      </button>
      {open ? props.children : null}
    </section>
  );
}

// ── The page ──────────────────────────────────────────────────────────────

export function AssistantPageA(props: {
  readonly environmentId: string;
  readonly projectId: string;
}) {
  const team = useAssistantTeam();
  const member =
    team.find(
      (item) => item.environmentId === props.environmentId && item.projectId === props.projectId,
    ) ?? null;
  const navigate = useNavigate();
  const home = useUnoHome();
  const actions = useTeamActions();
  const queryClient = useQueryClient();
  const [faceOpen, setFaceOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newChannel, setNewChannel] = useState<string | null>(null);

  const backToUno = () =>
    home.uno
      ? void navigate({
          to: "/assistants",
          search: { view: "profile", env: home.uno.environmentId, project: home.uno.projectId },
        })
      : void navigate({ to: "/" });

  const header = (back: ReactNode) => (
    <header className="flex min-h-12 items-center gap-2 border-b border-border px-3 sm:px-5">
      <SidebarShowButton />
      {back}
    </header>
  );

  if (member === null) {
    return (
      <SidebarInset className="h-dvh min-h-0 bg-background text-foreground">
        {header(null)}
        <p className="p-6 text-sm text-muted-foreground">
          This assistant isn't here — its computer may be offline.
        </p>
      </SidebarInset>
    );
  }

  const { profile } = member;
  const name = profile.name;
  const openThread = (thread: Pick<SidebarThreadSummary, "environmentId" | "id">) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({
        environmentId: thread.environmentId,
        threadId: thread.id as ThreadId,
      }),
    });
  const openChat = async () => {
    const { threadId } = await ensureAssistantChat({
      environmentId: member.environmentId as EnvironmentId,
      projectId: member.projectId,
    });
    await queryClient.invalidateQueries({ queryKey: LOCAL_ASSISTANTS_KEY });
    await waitForThread(member.environmentId, threadId);
    openThread({ environmentId: member.environmentId as EnvironmentId, id: threadId });
  };
  const own = team.filter((item) => !item.isUno && !item.revoked);

  const remove = () => {
    setConfirmRemove(false);
    setBusy(true);
    void actions
      .revoke(member)
      .then(() =>
        toastManager.add({
          type: "success",
          title: `${name} is removed`,
          description: "It stopped what it was doing. Its chats stay; bring it back any time.",
        }),
      )
      .catch((cause: unknown) =>
        toastManager.add({
          type: "error",
          title: "Couldn't remove it",
          description: errorText(cause, "Its computer didn't answer."),
        }),
      )
      .finally(() => setBusy(false));
  };

  const addChannel = async () => {
    const title = cleanChannelName(newChannel ?? "");
    if (title === null) return;
    const { threadId } = await createAssistantConversation({
      environmentId: member.environmentId as EnvironmentId,
      title,
    });
    setNewChannel(null);
    await waitForThread(member.environmentId, threadId);
    openThread({ environmentId: member.environmentId as EnvironmentId, id: threadId });
  };

  const whoLine = member.isUno
    ? `Your one assistant · lives ${home.line}`
    : `Your own assistant · ${profile.roles[0] ?? "no role yet"} · on ${member.computerLabel || "your cloud computer"} · uses Uno's apps`;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden"
        data-testid="assistant-page-a"
      >
        {header(
          member.isUno ? null : (
            <Button size="xs" variant="ghost" onClick={backToUno}>
              <ArrowLeftIcon className="size-3.5" />
              {home.uno?.profile.name ?? "Uno"}
            </Button>
          ),
        )}
        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            {/* Who it is */}
            <div className="flex items-start gap-4">
              <button
                type="button"
                disabled={member.isUno || member.revoked}
                onClick={() => setFaceOpen(true)}
                title={member.isUno ? undefined : "Change its face"}
                className="relative shrink-0 cursor-pointer rounded-full disabled:cursor-default"
                data-testid="assistant-page-face"
              >
                <AssistantAvatar
                  emoji={profile.emoji}
                  tone={profile.tone}
                  image={avatarImageOf(profile)}
                  activity={member.activity}
                  revoked={member.revoked}
                  className="size-14"
                  emojiClassName="text-3xl"
                />
              </button>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <NameEditor member={member} />
                  {member.revoked ? (
                    <Pill muted>Removed</Pill>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span
                        className={cn(
                          "size-2 rounded-full",
                          member.activity === "working"
                            ? "bg-sky-500"
                            : member.activity === "waiting"
                              ? "bg-amber-500"
                              : "bg-success",
                        )}
                      />
                      {ACTIVITY_LABEL[member.activity]}
                    </span>
                  )}
                </div>
                <p
                  className="truncate text-xs text-muted-foreground"
                  data-testid="assistant-page-where"
                >
                  {whoLine}
                </p>
                {!member.isUno && profile.character ? (
                  <p className="text-xs text-muted-foreground">Character: {profile.character}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {member.revoked ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void actions.restore(member)}
                    data-testid="assistant-page-bring-back"
                  >
                    <RotateCcwIcon className="size-3.5" /> Bring back
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => void openChat()}
                    data-testid="assistant-page-open-chat"
                  >
                    <MessageCircleIcon className="size-3.5" />
                    {member.isUno ? "Open Everything" : "Open chat"}
                  </Button>
                )}
              </div>
            </div>

            {home.alwaysOn === false && member.isUno ? (
              <p
                className="rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-xs"
                data-testid="assistant-page-free"
              >
                On Free, {home.label} naps when you're away: Uno catches up when you open Work and
                can't write first. Plus keeps it awake.
              </p>
            ) : null}

            <Section title="How it works" testId="assistant-page-mode-section">
              <ModeCards member={member} />
            </Section>

            {member.isUno ? (
              <>
                <Section title="Computers — its hands" testId="assistant-page-hands-section">
                  <Hands member={member} />
                </Section>

                <Section
                  title="Apps"
                  testId="assistant-page-apps"
                  action={
                    <button
                      type="button"
                      onClick={() => void navigate({ to: "/settings/connectors" })}
                      className="cursor-pointer text-xs text-primary hover:underline"
                    >
                      Settings → Connectors
                    </button>
                  }
                >
                  <ConnectorsList appsOnly className="rounded-lg border-0" />
                </Section>

                <Section title="Where you talk" testId="assistant-page-talk">
                  <TelegramRow member={member} />
                  <div className="flex h-11 items-center gap-2.5 border-t border-border/70 px-3">
                    <MessageCircleIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 text-sm">Here in Uno Work</span>
                    <span className="text-xs text-muted-foreground">always</span>
                  </div>
                </Section>

                <Section
                  title={`Channels · ${member.chats.conversations.length}`}
                  testId="assistant-page-channels"
                  action={
                    <button
                      type="button"
                      onClick={() => setNewChannel("")}
                      className="inline-flex cursor-pointer items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <PlusIcon className="size-3" /> New channel
                    </button>
                  }
                >
                  {newChannel !== null ? (
                    <form
                      className="flex items-center gap-2 border-b border-border/70 px-3 py-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void addChannel();
                      }}
                    >
                      <span className="text-sm text-muted-foreground">#</span>
                      <input
                        // oxlint-disable-next-line jsx-a11y/no-autofocus
                        autoFocus
                        value={newChannel}
                        maxLength={40}
                        onChange={(event) => setNewChannel(event.target.value)}
                        placeholder="channel name"
                        aria-label="New channel name"
                        className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-hidden"
                      />
                      <Button
                        size="sm"
                        type="submit"
                        disabled={cleanChannelName(newChannel) === null}
                      >
                        Create
                      </Button>
                    </form>
                  ) : null}
                  {orderChannels(member.chats.conversations)
                    .slice(0, 8)
                    .map((thread) => (
                      <ChatLine
                        key={thread.id}
                        thread={{
                          ...thread,
                          title:
                            thread.assistantRole === "chat"
                              ? "Everything"
                              : `# ${channelName(thread)}`,
                        }}
                        onOpen={() => openThread(thread)}
                      />
                    ))}
                </Section>

                <Section title="Memory — one for all channels and computers">
                  <MemoryFile member={member} name="NOTES.md" what="what it has learned" last />
                </Section>

                <Advanced defaultOpen={own.length > 0}>
                  <section
                    className="flex flex-col gap-3 rounded-xl border border-dashed border-border p-4"
                    data-testid="assistant-page-own"
                  >
                    <div className="flex flex-wrap items-start gap-3">
                      <SparklesIcon className="mt-0.5 size-4 text-primary" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">Your own assistants</p>
                        <p className="text-xs text-muted-foreground">
                          A character with its own role, face and chat — a secretary, a marketer, a
                          developer. It uses Uno's apps; Uno stays your main one.
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void navigate({ to: "/assistants", search: { view: "gallery" } })
                        }
                        data-testid="assistant-page-gallery"
                      >
                        Pick a character
                      </Button>
                    </div>
                    {own.length > 0 ? (
                      <div className="flex flex-col gap-0.5">
                        {own.map((item) => (
                          <button
                            key={item.key}
                            type="button"
                            onClick={() =>
                              void navigate({
                                to: "/assistants",
                                search: {
                                  view: "profile",
                                  env: item.environmentId,
                                  project: item.projectId,
                                },
                              })
                            }
                            className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/50"
                          >
                            <AssistantAvatar
                              emoji={item.profile.emoji}
                              tone={item.profile.tone}
                              image={avatarImageOf(item.profile)}
                              className="size-6"
                              emojiClassName="text-xs"
                            />
                            <span className="min-w-0 truncate text-sm">{item.profile.name}</span>
                            <span className="text-xs text-muted-foreground">
                              {item.profile.roles[0] ?? ""}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </section>
                </Advanced>
              </>
            ) : (
              <>
                <Section title={`Chats · ${member.chats.conversations.length}`}>
                  {member.chats.conversations.length > 0 ? (
                    member.chats.conversations
                      .slice(0, 6)
                      .map((thread) => (
                        <ChatLine
                          key={thread.id}
                          thread={thread}
                          onOpen={() => openThread(thread)}
                        />
                      ))
                  ) : (
                    <p className="px-3 py-2 text-sm text-muted-foreground">No chats yet.</p>
                  )}
                </Section>
                {member.revoked ? null : (
                  <section
                    className="flex flex-col gap-2 px-1"
                    data-testid="assistant-page-remove-section"
                  >
                    {confirmRemove ? (
                      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.04] px-3 py-2.5 text-sm">
                        <span className="min-w-0 flex-1">
                          Remove {name}? It stops what it's doing now. Its chats stay.
                        </span>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={remove}
                          disabled={busy}
                          data-testid="assistant-page-remove-confirm"
                        >
                          Remove
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmRemove(true)}
                        className="inline-flex w-fit cursor-pointer items-center gap-1.5 text-xs text-destructive hover:underline"
                        data-testid="assistant-page-remove"
                      >
                        <Trash2Icon className="size-3.5" /> Remove {name}
                      </button>
                    )}
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {!member.isUno && !member.revoked ? (
        <AssistantFacePicker member={member} open={faceOpen} onOpenChange={setFaceOpen} />
      ) : null}
    </SidebarInset>
  );
}
