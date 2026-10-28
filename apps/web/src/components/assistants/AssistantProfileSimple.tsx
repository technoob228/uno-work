/**
 * An assistant's page on real data, simple (Misha 23.10: "an assistant =
 * the AI it runs on + an outside channel + its own folder; click create,
 * click Telegram, done"):
 *
 * - who it is: its face (click → Upload / Emoji / Persona), name, status;
 * - the one next step: Connect Telegram (@BotFather, paste the token, then
 *   Start in Telegram) until a bot is linked; Slack and its email are small
 *   rows under it;
 * - its chats and what is on it now, its memory;
 * - Advanced, folded: its mode (Does it itself / Asks first) and projects,
 *   where it works, the apps it may open, the AI (one per computer), its
 *   email rules, role, routines, the team and "Set up again".
 *
 * Everything here reads and changes what its computer keeps. The mock's page
 * (`?demo=w0138`) is `AssistantProfilePage.tsx`.
 */
import { scopeProjectRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
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
import { TelegramWizard } from "../assistant/TelegramWizard";
import { SidebarShowButton } from "../sidebar/SidebarShowButton";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { assistantOwnRuntimeMode } from "@t3tools/shared/assistantPreset";

import { AssistantAvatar, avatarImageOf } from "./AssistantAvatar";
import { AssistantFacePicker } from "./AssistantFacePicker";
import { AssistantBasics } from "./AssistantBasics";
import { MachineTag } from "./MachineAssistants";
import { TeamDuties, TeamMail, TeamWhoEditor, TeamWorksOn } from "./AssistantProfileBlocks";
import { ChatLine, MemoryFile, Pill, Row, Section, TreeBranch } from "./AssistantProfileParts";
import {
  TeamConnectors,
  TeamPresetEditor,
  TeamRoutines,
  TeamRunsOn,
  useOpenAssistantSettings,
} from "./AssistantProfileReal";
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

/** Telegram (once linked), Slack and its own email as small rows; here in Uno Work always. */
function WhereYouTalk(props: { readonly member: TeamMember }) {
  const { member } = props;
  const openSettings = useOpenAssistantSettings();
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
  const link = (
    <button
      type="button"
      onClick={() => openSettings(member)}
      className="cursor-pointer text-primary hover:underline"
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
          label="Telegram"
          value={telegram.botUsername ? `@${telegram.botUsername}` : "linked"}
          testId="assistant-talk-telegram"
        />
      ) : null}
      <TalkRow
        icon={<SlackIcon className="size-3.5" />}
        label="Slack"
        value={slack?.configured ? (slack.botUserName ?? "linked") : link}
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
        <span className="font-normal">· mode, projects, where it works, apps, AI, email</span>
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
  const machines = useMachineRows();
  const { handleNewThread } = useNewThreadHandler();
  const actions = useTeamActions();
  const quick = useQuickCreateAssistant();
  const openSettings = useOpenAssistantSettings();
  const [editingWho, setEditingWho] = useState(false);
  const [changingBrain, setChangingBrain] = useState(false);
  const [faceOpen, setFaceOpen] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [busy, setBusy] = useState(false);

  const back = (
    <Button size="xs" variant="ghost" onClick={() => void navigate({ to: "/assistants" })}>
      <ArrowLeftIcon className="size-3.5" />
      <span className="hidden sm:inline">Assistants</span>
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
  const telegramLinked = member.summary?.telegram.configured === true;
  const openThread = (thread: SidebarThreadSummary) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({
        environmentId: thread.environmentId,
        threadId: thread.id as ThreadId,
      }),
    });
  // Its chat opens in its own mode ("Asks first" = edit files, ask before
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
        title: `${name} is revoked`,
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
                  <h1
                    className="min-w-0 max-w-full truncate text-xl leading-tight font-semibold"
                    title={name}
                    data-testid="assistant-profile-name"
                  >
                    {name}
                  </h1>
                  <MachineTag label={homeMachine?.label ?? member.computerLabel} />
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
                <p className="text-xs text-muted-foreground">
                  {member.isUno
                    ? `The assistant of ${homeMachine?.label ?? member.computerLabel} · `
                    : ""}
                  Takes tasks only from you · sees only{" "}
                  {homeMachine?.label ?? (member.computerLabel || "this computer")}
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

            <AssistantBasics
              member={member}
              machineLabel={homeMachine?.label ?? member.computerLabel}
              running={running}
              onRemoved={() => undefined}
            />

            {/* The one next step, then the other ways to reach it. */}
            {!member.revoked && !telegramLinked ? <ConnectTelegramCard member={member} /> : null}
            <WhereYouTalk member={member} />

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
              title="Memory · its own folder"
              action={
                <button
                  type="button"
                  onClick={() => openSettings(member)}
                  className="cursor-pointer text-xs text-primary hover:underline"
                  data-testid="assistant-profile-memory-edit"
                >
                  Edit
                </button>
              }
            >
              <MemoryFile member={member} name="NOTES.md" what="what it has learned" />
              <MemoryFile member={member} name="AGENTS.md" what="its instructions" last />
            </Section>

            <Advanced>
              <Section title="What it may do" testId="assistant-profile-access">
                <div className="px-3 py-2">
                  <TeamPresetEditor member={member} nameOf={nameOf} />
                </div>
              </Section>

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
                    onClick={() => void quick.create()}
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
                  {member.isUno || member.revoked ? null : confirmRevoke ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-foreground">
                        Revoke {name}
                        {descendants.length > 0
                          ? ` and ${descendants.length} assistant${descendants.length === 1 ? "" : "s"} it set up`
                          : ""}
                        ?
                      </span>
                      <Button
                        size="xs"
                        variant="destructive"
                        onClick={doRevoke}
                        data-testid="assistant-profile-revoke-confirm"
                      >
                        Revoke
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setConfirmRevoke(false)}>
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmRevoke(true)}
                      className="inline-flex cursor-pointer items-center gap-1 text-destructive hover:underline"
                      data-testid="assistant-profile-revoke"
                    >
                      <UserRoundXIcon className="size-3.5" />
                      Revoke access
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
