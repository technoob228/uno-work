/**
 * An assistant's page on real data, simple (Misha 23.10: "an assistant =
 * the AI it runs on + an outside channel + its own folder; click create,
 * click Telegram, done"):
 *
 * - who it is: its face (click → Upload / Emoji / Persona), name, status;
 * - the one next step: Connect Telegram (@BotFather, paste the token, then
 *   Start in Telegram) until a bot is linked; Slack and its email are small
 *   rows under it;
 * - its permission level, where it can look, where it works, the apps it
 *   may open and the AI (one per computer) — in plain sight (29.10);
 * - its chats and what is on it now, its memory and instructions (edited
 *   right on the page);
 * - Advanced, folded: projects by name, its email rules, role, routines,
 *   the team and "Set up again";
 * - its automations (28.10): what it does on a schedule or on an event.
 *
 * Everything here reads and changes what its computer keeps. The mock's page
 * (`?demo=w0138`) is `AssistantProfilePage.tsx`.
 */
import { scopeProjectRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
  LockIcon,
  MailIcon,
  MessageCircleIcon,
  PencilIcon,
  RotateCcwIcon,
  SendIcon,
  SlackIcon,
  SquarePenIcon,
  UserRoundXIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useMachineRows } from "../../hooks/useMachineRows";
import { getAssistant, getAssistantMail } from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { ConnectChannelDialog, type ConnectChannel } from "../assistant/ConnectChannelDialog";
import { TelegramWizard } from "../assistant/TelegramWizard";
import { SidebarShowButton } from "../sidebar/SidebarShowButton";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { assistantOwnRuntimeMode } from "@t3tools/shared/assistantPreset";

import { AssistantAvatar, avatarImageOf } from "./AssistantAvatar";
import { AssistantFacePicker } from "./AssistantFacePicker";
import { TeamDuties, TeamMail, TeamWhoEditor, TeamWorksOn } from "./AssistantProfileBlocks";
import { MemoryBlock } from "./AssistantMemoryModels";
import { AssistantModeSwitch } from "./PersonaMode";
import { AutomationsSection } from "../automations/AutomationsSection";
import { JoinCallsSection } from "./JoinCallsSection";
import { ChatLine, MemoryFile, Pill, Row, Section, TreeBranch } from "./AssistantProfileParts";
import { TeamConnectors, TeamPresetEditor, TeamRoutines, TeamRunsOn } from "./AssistantProfileReal";
import { ACTIVITY_LABEL, buildAssistantTree, descendantKeys } from "./assistantTeam.logic";
import { setupProgressLine } from "./teamFromDaemon.logic";
import { type TeamMember, useAssistantTeam } from "./useAssistantTeam";
import { useQuickCreateAssistant } from "./useQuickCreateAssistant";
import { useTeamActions } from "./useTeamActions";

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

// ── Where you talk ────────────────────────────────────────────────────────

/**
 * The next step: its own Telegram bot. One click opens the steps (@BotFather,
 * the token — masked, kept on its computer — then Start in Telegram); the
 * card checks every few seconds while it is open.
 */
function ConnectTelegramCard(props: { readonly member: TeamMember }) {
  const { member } = props;
  const [open, setOpen] = useState(false);
  const summary = useQuery({
    queryKey: ["uno-assistant", "telegram-card", member.environmentId, member.projectId],
    queryFn: () =>
      getAssistant({
        environmentId: member.environmentId as EnvironmentId,
        projectId: member.projectId,
      }),
    enabled: open,
    refetchInterval: open ? 2500 : false,
    retry: false,
  });
  const actions = useTeamActions();
  const name = member.profile.name;
  const data = summary.data ?? member.summary;
  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-primary/40 bg-primary/[0.03] p-4"
      data-testid="assistant-connect-telegram"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-9 place-items-center rounded-lg bg-sky-500/10 text-sky-500">
          <SendIcon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Connect Telegram</span>
          <span className="block text-xs text-muted-foreground">
            Talk to {name} from your phone, in a bot of its own.
          </span>
        </span>
        {open ? null : (
          <Button onClick={() => setOpen(true)} data-testid="assistant-connect-telegram-start">
            Connect Telegram
          </Button>
        )}
      </div>
      {open ? (
        data ? (
          <TelegramWizard
            environmentId={member.environmentId as EnvironmentId}
            summary={data}
            onChanged={() => {
              void summary.refetch();
              void actions.refresh();
            }}
          />
        ) : (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircleIcon className="size-3.5 animate-spin" /> Asking its computer…
          </p>
        )
      ) : null}
    </section>
  );
}

function TalkRow(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: ReactNode;
  readonly testId?: string;
}) {
  return (
    <div
      className="flex h-9 items-center gap-2 border-t border-border/70 px-3 text-sm first:border-t-0"
      data-testid={props.testId}
    >
      <span className="text-muted-foreground">{props.icon}</span>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{props.value}</span>
    </div>
  );
}

/**
 * Telegram, Slack and its own email as small rows; here in Uno Work always.
 * "Link" opens the channel right here (audit 27.10 #14: it used to open a
 * second, older page of the same assistant). A persona's Telegram is a bot of
 * its own — Uno's shared bot is Uno's only (Misha 28.10).
 */
function WhereYouTalk(props: { readonly member: TeamMember }) {
  const { member } = props;
  const [connecting, setConnecting] = useState<ConnectChannel | null>(null);
  const telegram = member.summary?.telegram;
  const slack = member.summary?.slack;
  const mail = useQuery({
    queryKey: ["uno-assistant", "mail", member.environmentId, member.projectId],
    queryFn: () =>
      getAssistantMail({
        environmentId: member.environmentId as EnvironmentId,
        projectId: member.projectId,
      }),
    retry: false,
    staleTime: 30_000,
  });
  const link = (channel: ConnectChannel) => (
    <button
      type="button"
      onClick={() => setConnecting(channel)}
      className="cursor-pointer text-primary hover:underline"
      data-testid={`assistant-talk-${channel}-link`}
    >
      Link
    </button>
  );
  const view = mail.data;
  return (
    <div className="rounded-lg border border-border bg-card/40" data-testid="assistant-talk">
      {telegram?.configured ? (
        <TalkRow
          icon={<SendIcon className="size-3.5" />}
          label={
            member.isUno
              ? "Telegram"
              : telegram.shared
                ? "Telegram · Uno's bot"
                : "Telegram · its own bot"
          }
          value={telegram.botUsername ? `@${telegram.botUsername}` : "linked"}
          testId="assistant-talk-telegram"
        />
      ) : !member.isUno ? (
        <TalkRow
          icon={<SendIcon className="size-3.5" />}
          label="Telegram · its own bot"
          value={member.revoked ? "not linked" : link("telegram")}
          testId="assistant-talk-telegram"
        />
      ) : null}
      <TalkRow
        icon={<SlackIcon className="size-3.5" />}
        label="Slack"
        value={
          slack?.configured
            ? (slack.botUserName ?? "linked")
            : member.revoked
              ? "not linked"
              : link("slack")
        }
        testId="assistant-talk-slack"
      />
      {view?.available && view.address ? (
        <TalkRow
          icon={<MailIcon className="size-3.5" />}
          label={view.address}
          value={view.policy.enabled ? "its own email" : "email off"}
          testId="assistant-talk-mail"
        />
      ) : null}
      <TalkRow
        icon={<MessageCircleIcon className="size-3.5" />}
        label="Here in Uno Work"
        value="always"
      />
      <ConnectChannelDialog
        environmentId={member.environmentId as EnvironmentId}
        projectId={member.projectId as ProjectId}
        channel={connecting}
        telegramMode="own"
        onClose={() => setConnecting(null)}
      />
    </div>
  );
}

// ── Advanced ──────────────────────────────────────────────────────────────

function Advanced(props: { readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-4" data-testid="assistant-advanced">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-fit cursor-pointer items-center gap-1 px-1 text-[13px] font-medium text-muted-foreground hover:text-foreground"
        data-testid="assistant-advanced-toggle"
      >
        <ChevronRightIcon className={cn("size-4 transition-transform", open && "rotate-90")} />
        Advanced
        <span className="font-normal">· projects by name, its email, role and routines, team</span>
      </button>
      {open ? props.children : null}
    </section>
  );
}

// ── The page ──────────────────────────────────────────────────────────────

export function AssistantProfileSimple(props: {
  readonly environmentId: string;
  readonly projectId: string;
}) {
  const team = useAssistantTeam();
  const member =
    team.find(
      (item) => item.environmentId === props.environmentId && item.projectId === props.projectId,
    ) ?? null;
  const navigate = useNavigate();
  const router = useRouter();
  const machines = useMachineRows();
  const { handleNewThread } = useNewThreadHandler();
  const actions = useTeamActions();
  const quick = useQuickCreateAssistant();
  const [editingWho, setEditingWho] = useState(false);
  const [changingBrain, setChangingBrain] = useState(false);
  const [faceOpen, setFaceOpen] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [editingMemory, setEditingMemory] = useState(false);
  const [busy, setBusy] = useState(false);

  // Back where the person came from (its chat, the sidebar, the list); a page
  // opened by a link goes to the list of assistants (29.10).
  const canGoBack = useCanGoBack();
  const back = (
    <Button
      size="xs"
      variant="ghost"
      onClick={() => (canGoBack ? router.history.back() : void navigate({ to: "/assistants" }))}
      data-testid="assistant-profile-back"
    >
      <ArrowLeftIcon className="size-3.5" />
      <span className="hidden sm:inline">{canGoBack ? "Back" : "All assistants"}</span>
    </Button>
  );

  if (member === null) {
    return (
      <SidebarInset className="h-dvh min-h-0 bg-background text-foreground">
        <header className="flex min-h-12 items-center gap-2 border-b border-border px-3 sm:px-5">
          <SidebarShowButton />
          {back}
        </header>
        <p className="p-6 text-sm text-muted-foreground">
          This assistant isn't here — its computer may be offline.
        </p>
      </SidebarInset>
    );
  }

  const { profile } = member;
  const name = profile.name;
  const uno = team.find((item) => item.isUno) ?? null;
  const telegramLinked = member.summary?.telegram.configured === true;
  const openThread = (thread: SidebarThreadSummary) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({
        environmentId: thread.environmentId,
        threadId: thread.id as ThreadId,
      }),
    });
  // Its chat opens in its own mode ("Cautious" = edit files, ask before
  // commands); the daemon caps the harness to it anyway.
  const newChat = () =>
    void handleNewThread(
      scopeProjectRef(member.environmentId as EnvironmentId, member.projectId as ProjectId),
      { envMode: "local", runtimeMode: assistantOwnRuntimeMode(member.profile.preset) },
    );
  const running = [...member.chats.work, ...member.chats.conversations].filter((thread) => {
    const status = resolveSidebarThreadStatus(thread);
    return status === "working" || status === "approval" || status === "input";
  });
  const parent = member.createdBy
    ? (team.find((item) => item.key === member.createdBy) ?? null)
    : null;
  const tree = buildAssistantTree(team);
  const descendants = descendantKeys(team, member.key);
  const homeMachine = machines.find((machine) => machine.environmentId === member.environmentId);
  const place = {
    environmentId: member.environmentId,
    label: member.computerLabel,
    own: false,
    mac: homeMachine?.kind === "computer",
  };
  const nameOf = (projectId: string) =>
    team.find((item) => item.environmentId === member.environmentId && item.projectId === projectId)
      ?.profile.name ?? projectId;
  const setupLine = setupProgressLine(member.summary?.team?.team ?? null, { isUno: member.isUno });
  const canEditFace = !member.isUno && !member.revoked;

  const teamTask = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't change it",
        description: errorText(cause, "Its computer didn't answer."),
      });
    } finally {
      setBusy(false);
    }
  };
  // Optional now: its setup chat goes on where it stopped (the daemon keeps the progress).
  const setUpAgain = () =>
    void teamTask(async () => {
      const threadId = await actions.startSetup(member);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId: member.environmentId as EnvironmentId,
          threadId,
        }),
      });
    });
  const doRevoke = () => {
    setConfirmRevoke(false);
    void teamTask(async () => {
      const more = await actions.revoke(member);
      toastManager.add({
        type: "success",
        title: `${name} is removed`,
        description:
          more > 0
            ? `And ${more} assistant${more === 1 ? "" : "s"} it set up. Their chats stay.`
            : "Its chats stay. Bring it back any time.",
      });
    });
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden"
        data-testid="assistant-profile"
      >
        <header className="flex min-h-12 items-center gap-2 border-b border-border px-3 sm:px-5">
          <SidebarShowButton />
          {back}
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            {/* Who it is */}
            <div className="flex items-start gap-4">
              <button
                type="button"
                disabled={!canEditFace}
                onClick={() => setFaceOpen(true)}
                title={canEditFace ? "Change its face" : undefined}
                aria-label={canEditFace ? `Change ${name}'s face` : undefined}
                className="group relative shrink-0 cursor-pointer rounded-full disabled:cursor-default"
                data-testid="assistant-profile-face"
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
                {canEditFace ? (
                  <span className="absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full border border-border bg-background text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                    <PencilIcon className="size-3" />
                  </span>
                ) : null}
              </button>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-xl leading-tight font-semibold">{name}</h1>
                  {!member.revoked && !editingWho ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Edit name, role and how it talks"
                      title="Edit name, role and how it talks"
                      onClick={() => setEditingWho(true)}
                      data-testid="assistant-profile-who-edit"
                    >
                      <PencilIcon className="size-3.5" />
                    </Button>
                  ) : null}
                  {member.revoked ? (
                    <Pill muted>Revoked</Pill>
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
                <p className="text-xs text-muted-foreground" data-testid="assistant-profile-line">
                  {member.isUno
                    ? `Your main assistant · sees all your computers and apps · lives on ${member.computerLabel || "your cloud computer"}`
                    : `${profile.roles[0] ? `${profile.roles[0]} · ` : ""}works next to Uno · shares its memory · lives on ${member.computerLabel || "your cloud computer"}`}
                </p>
                {setupLine ? (
                  <p
                    className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                    data-testid="assistant-profile-setup-progress"
                  >
                    {setupLine}
                    <button
                      type="button"
                      onClick={setUpAgain}
                      disabled={busy}
                      className="cursor-pointer text-primary hover:underline"
                    >
                      Go on
                    </button>
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {member.revoked ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void teamTask(() => actions.restore(member))}
                  >
                    <RotateCcwIcon className="size-3.5" /> Bring back
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant={telegramLinked ? "default" : "outline"}
                    onClick={newChat}
                    data-testid="assistant-profile-new-chat"
                  >
                    <SquarePenIcon className="size-3.5" /> New chat
                  </Button>
                )}
              </div>
            </div>

            {editingWho ? (
              <TeamWhoEditor
                member={member}
                withFace={false}
                onClose={() => setEditingWho(false)}
              />
            ) : null}

            {/* The one next step, then the other ways to reach it. */}
            {!member.revoked && !telegramLinked && member.isUno ? (
              <ConnectTelegramCard member={member} />
            ) : null}
            <WhereYouTalk member={member} />
            {!member.revoked ? (
              <JoinCallsSection
                environmentId={member.environmentId}
                projectId={member.projectId}
                name={name}
              />
            ) : null}
            {/* What it does by itself: on a schedule or when something happens (28.10). */}
            <AutomationsSection member={member} />

            {/* Variant D: its mode and where it looks, in plain sight. */}
            <Section title="Permission level" testId="assistant-profile-mode">
              <div className="p-2">
                <AssistantModeSwitch member={member} />
              </div>
            </Section>
            <Section title="Where it can look" testId="assistant-profile-where">
              <div className="flex flex-col gap-1 px-3 py-2.5 text-sm">
                {profile.projects === "all" ? (
                  <span>All your projects, new ones too — like Uno.</span>
                ) : (
                  <>
                    <span>Only: {profile.projects.join(", ") || "its own folder"}</span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <LockIcon className="size-3 text-success" /> Locked by a sandbox on{" "}
                      {member.computerLabel || "its computer"}. On your other computers it's a note,
                      not a lock.
                    </span>
                  </>
                )}
              </div>
            </Section>

            {/* Its computer, apps and AI in plain sight (29.10: they were under Advanced). */}
            <Section title="Where it works" testId="assistant-profile-works-on-section">
              <TeamWorksOn member={member} />
            </Section>

            <Section
              title="Apps it can open"
              testId="assistant-profile-can-use"
              action={
                <button
                  type="button"
                  onClick={() => void navigate({ to: "/settings/connectors" })}
                  className="cursor-pointer text-xs text-primary hover:underline"
                >
                  Connectors in Settings
                </button>
              }
            >
              <TeamConnectors member={member} place={place} nameOf={nameOf} />
            </Section>

            <Section
              title="The AI it runs on"
              action={
                member.revoked ? null : (
                  <button
                    type="button"
                    onClick={() => setChangingBrain((value) => !value)}
                    className="cursor-pointer text-xs text-primary hover:underline"
                  >
                    {changingBrain ? "Done" : "Change"}
                  </button>
                )
              }
            >
              <TeamRunsOn member={member} changing={changingBrain} />
            </Section>

            <div className="grid gap-6 md:grid-cols-2">
              <Section title={`Chats · ${member.chats.conversations.length}`}>
                {member.chats.conversations.length > 0 ? (
                  member.chats.conversations
                    .slice(0, 6)
                    .map((thread) => (
                      <ChatLine key={thread.id} thread={thread} onOpen={() => openThread(thread)} />
                    ))
                ) : (
                  <p className="px-3 py-2 text-sm text-muted-foreground">
                    No chats yet — say hi with New chat.
                  </p>
                )}
              </Section>
              <Section title="Tasks" testId="assistant-profile-tasks">
                <TeamDuties member={member} />
                <p className="border-t border-border/70 px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  Running now
                </p>
                {running.length > 0 ? (
                  running
                    .slice(0, 4)
                    .map((thread) => (
                      <ChatLine key={thread.id} thread={thread} onOpen={() => openThread(thread)} />
                    ))
                ) : (
                  <p className="px-3 pt-0 pb-2 text-xs text-muted-foreground">Nothing running.</p>
                )}
              </Section>
            </div>

            <Section
              title={
                member.isUno ? "Memory · shared with your helpers" : "Memory · shared with Uno"
              }
              action={
                <button
                  type="button"
                  onClick={() => setEditingMemory((value) => !value)}
                  className="cursor-pointer text-xs text-primary hover:underline"
                  data-testid="assistant-profile-memory-edit"
                >
                  {editingMemory ? "Done" : "Edit memory and instructions"}
                </button>
              }
            >
              {/* Edited right here (29.10): "Edit" used to open an older page of it. */}
              {editingMemory ? (
                <div className="px-3 py-2" data-testid="assistant-profile-memory-editor">
                  <MemoryBlock
                    name={name}
                    environmentId={member.environmentId as EnvironmentId}
                    projectId={member.projectId}
                    waking={false}
                    onWake={() => undefined}
                  />
                </div>
              ) : (
                <>
                  <MemoryFile
                    member={uno ?? member}
                    name="NOTES.md"
                    what="what Uno and helpers learned"
                  />
                  <MemoryFile member={member} name="AGENTS.md" what="its instructions" last />
                </>
              )}
            </Section>

            {/* Variant D: removing a persona is a visible, plain action. */}
            {member.isUno || member.revoked ? null : (
              <div
                className="flex flex-col gap-2 rounded-xl border border-border px-3 py-2.5"
                data-testid="assistant-profile-remove-box"
              >
                {confirmRevoke ? (
                  <>
                    <span className="text-sm">
                      {running.length > 0
                        ? `${name} is working on “${running[0]!.title}” right now. Remove anyway? That task stops; ${name}'s chats stay.`
                        : `Remove ${name}? ${name} stops working and leaves the sidebar; its chats stay. You can bring it back.`}
                    </span>
                    <span className="flex items-center gap-2">
                      <Button
                        size="xs"
                        variant="destructive"
                        onClick={doRevoke}
                        data-testid="assistant-profile-remove-confirm"
                      >
                        Remove {name}
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setConfirmRevoke(false)}>
                        Keep
                      </Button>
                    </span>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmRevoke(true)}
                    className="inline-flex w-fit cursor-pointer items-center gap-1.5 text-sm text-destructive hover:underline"
                    data-testid="assistant-profile-remove"
                  >
                    <UserRoundXIcon className="size-3.5" />
                    Remove {name}
                  </button>
                )}
              </div>
            )}

            <Advanced>
              <Section title="What it may do" testId="assistant-profile-access">
                <div className="px-3 py-2">
                  <TeamPresetEditor member={member} nameOf={nameOf} />
                </div>
              </Section>

              <TeamMail
                member={member}
                section={(body) => (
                  <Section title="Its email" testId="assistant-profile-mail">
                    {body}
                  </Section>
                )}
              />

              <Section title="Role and routines">
                <Row label="Role">
                  <div className="flex flex-wrap items-center gap-1">
                    {profile.roles.length > 0 ? (
                      profile.roles.map((role) => <Pill key={role}>{role}</Pill>)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                    {profile.character ? <Pill muted>{profile.character}</Pill> : null}
                    {member.revoked ? null : (
                      <button
                        type="button"
                        onClick={() => setEditingWho(true)}
                        className="ml-1 cursor-pointer text-xs text-primary hover:underline"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                </Row>
                <TeamRoutines member={member} machine={homeMachine} />
              </Section>

              <Section
                title="Team"
                testId="assistant-profile-team"
                action={
                  <button
                    type="button"
                    onClick={() => void navigate({ to: "/assistants", search: { view: "new" } })}
                    disabled={quick.creating}
                    className="cursor-pointer text-xs text-primary hover:underline"
                    data-testid="assistant-profile-new-assistant"
                  >
                    New assistant
                  </button>
                }
              >
                <div className="flex flex-col gap-0.5 p-1.5">
                  {tree.map((node) => (
                    <TreeBranch
                      key={node.item.key}
                      node={node}
                      current={member.key}
                      onOpen={(other) =>
                        void navigate({
                          to: "/assistants",
                          search: {
                            view: "profile",
                            env: other.environmentId,
                            project: other.projectId,
                          },
                        })
                      }
                    />
                  ))}
                </div>
                <div className="flex flex-col items-start gap-1.5 border-t border-border/70 px-3 py-2.5 text-xs text-muted-foreground">
                  <p>{parent ? `Set up by ${parent.profile.name}.` : "Set up by you."}</p>
                  {member.revoked ? null : (
                    <button
                      type="button"
                      onClick={setUpAgain}
                      disabled={busy}
                      className="cursor-pointer text-foreground hover:underline"
                      data-testid="assistant-profile-setup-again"
                    >
                      Set up again in a chat — it asks about its job, apps and routines
                    </button>
                  )}
                </div>
              </Section>
            </Advanced>
          </div>
        </div>
      </div>
      {canEditFace ? (
        <AssistantFacePicker member={member} open={faceOpen} onOpenChange={setFaceOpen} />
      ) : null}
    </SidebarInset>
  );
}
