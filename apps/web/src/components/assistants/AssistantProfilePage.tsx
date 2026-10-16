/**
 * An assistant's page (w0138 p7, Misha 14.10): who it is and what it does
 * now, its chats, what it can open and may do, what it runs on, where you
 * talk to it, its memory, and who set it up — the team as a tree, where
 * revoking one revokes everything it set up.
 *
 * Opened from its face in the sidebar, from the Inbox card "Uno set up
 * Scout", and from the team tree. Memory rows unfold the file here; editing
 * it and the models table stay on `LocalAssistantPage.tsx` ("Memory & models").
 */
import { scopeProjectRef } from "@t3tools/client-runtime";
import type {
  AssistantEditableFileName,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CalendarClockIcon,
  ChevronRightIcon,
  FileTextIcon,
  LaptopIcon,
  MessageCircleIcon,
  RotateCcwIcon,
  SendIcon,
  SquarePenIcon,
  UserRoundXIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useMachineLabels } from "../../hooks/useMachineRows";
import { readAssistantFile } from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { AssistantPowerPicker } from "../assistant/AssistantPowerPicker";
import { SidebarShowButton } from "../sidebar/SidebarShowButton";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { AssistantAvatar } from "./AssistantAvatar";
import { TeammateAccess } from "./TeammateAccess";
import { useAssistantOnboarding } from "./AssistantOnboarding";
import {
  ACTIVITY_LABEL,
  accessOf,
  type AssistantPreset,
  type AssistantTreeNode,
  BRAIN_NAME,
  CHANNEL_NAME,
  PRESETS,
  PRESET_NAME,
  buildAssistantTree,
  descendantKeys,
  profileLine,
  rightsBeyondParent,
} from "./assistantTeam.logic";
import { useAssistantTeamStore } from "./assistantTeamStore";
import { type TeamMember, threadActivityMs, useAssistantTeam } from "./useAssistantTeam";

function Section(props: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly testId?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-2", props.className)} data-testid={props.testId}>
      <div className="flex h-6 items-center justify-between gap-2 px-1">
        <h2 className="text-[13px] font-medium text-foreground">{props.title}</h2>
        {props.action}
      </div>
      <div className="rounded-lg border border-border bg-card/40">{props.children}</div>
    </section>
  );
}

function Row(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly last?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[7.5rem_1fr] items-start gap-3 px-3 py-2 text-sm",
        !props.last && "border-b border-border/70",
      )}
    >
      <span className="pt-px text-xs text-muted-foreground">{props.label}</span>
      <div className="min-w-0">{props.children}</div>
    </div>
  );
}

function Pill(props: { readonly children: ReactNode; readonly muted?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-2 text-xs",
        props.muted ? "border-border text-muted-foreground" : "border-border bg-muted/50",
      )}
    >
      {props.children}
    </span>
  );
}

function ChatLine(props: { readonly thread: SidebarThreadSummary; readonly onOpen: () => void }) {
  const status = resolveSidebarThreadStatus(props.thread);
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="flex h-8 w-full cursor-pointer items-center gap-2 border-b border-border/70 px-3 text-left text-sm last:border-b-0 hover:bg-accent/40"
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          status === "working"
            ? "bg-sky-500"
            : status === "approval" || status === "input"
              ? "bg-amber-500"
              : status === "failed"
                ? "bg-destructive"
                : "bg-muted-foreground/30",
        )}
      />
      <span className="min-w-0 flex-1 truncate">{props.thread.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {formatRelativeTimeLabel(new Date(threadActivityMs(props.thread)).toISOString())}
      </span>
    </button>
  );
}

function MemoryFile(props: {
  readonly member: TeamMember;
  readonly name: AssistantEditableFileName;
  readonly what: string;
  readonly last?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const file = useQuery({
    queryKey: [
      "assistant-file-preview",
      props.member.environmentId,
      props.member.projectId,
      props.name,
    ],
    queryFn: () =>
      readAssistantFile({
        environmentId: props.member.environmentId as EnvironmentId,
        projectId: props.member.projectId,
        name: props.name,
      }),
    retry: false,
    staleTime: 60_000,
  });
  const lines = (file.data?.content ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .slice(0, open ? undefined : 3);
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
      className={cn(
        "flex w-full cursor-pointer items-start gap-2.5 px-3 py-2 text-left hover:bg-accent/40",
        !props.last && "border-b border-border/70",
      )}
    >
      <FileTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2 text-sm">
          <span className="font-medium">{props.name}</span>
          <span className="text-xs text-muted-foreground">{props.what}</span>
        </span>
        {file.isLoading ? (
          <span className="block text-xs text-muted-foreground">…</span>
        ) : lines.length > 0 ? (
          lines.map((line) => (
            <span
              key={line}
              className={cn("block text-xs text-muted-foreground", !open && "truncate")}
            >
              {line}
            </span>
          ))
        ) : (
          <span className="block text-xs text-muted-foreground">
            {file.isError ? "Opens when its computer is awake." : "Empty so far."}
          </span>
        )}
      </span>
      <ChevronRightIcon
        className={cn(
          "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
          open && "rotate-90",
        )}
      />
    </button>
  );
}

function TreeBranch(props: {
  readonly node: AssistantTreeNode<TeamMember>;
  readonly current: string;
  readonly onOpen: (member: TeamMember) => void;
}) {
  const { item } = props.node;
  return (
    <div>
      <button
        type="button"
        onClick={() => props.onOpen(item)}
        className={cn(
          "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent/40",
          item.key === props.current && "bg-accent/60",
        )}
      >
        <AssistantAvatar
          emoji={item.profile.emoji}
          tone={item.profile.tone}
          activity={item.activity}
          revoked={item.revoked}
          className="size-4.5"
          emojiClassName="text-[10px]"
        />
        <span className={cn("truncate", item.revoked && "text-muted-foreground line-through")}>
          {item.profile.name}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {item.revoked ? "revoked" : PRESET_NAME[item.profile.preset]}
        </span>
      </button>
      {props.node.children.length > 0 ? (
        // Who it set up: indented under a line, not ASCII (critics D20).
        <div className="ml-[1.06rem] border-l border-border pl-2">
          {props.node.children.map((child) => (
            <TreeBranch
              key={child.item.key}
              node={child}
              current={props.current}
              onOpen={props.onOpen}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AssistantProfilePage(props: {
  readonly environmentId: string;
  readonly projectId: string;
}) {
  const team = useAssistantTeam();
  const member =
    team.find(
      (item) => item.environmentId === props.environmentId && item.projectId === props.projectId,
    ) ?? null;
  const navigate = useNavigate();
  const labels = useMachineLabels();
  const { handleNewThread } = useNewThreadHandler();
  const patchProfile = useAssistantTeamStore((store) => store.patch);
  const revoke = useAssistantTeamStore((store) => store.revoke);
  const restore = useAssistantTeamStore((store) => store.restore);
  const openSetup = useAssistantOnboarding((state) => state.openFor);
  const openNewAssistant = useAssistantOnboarding((state) => state.openNew);
  const [changingBrain, setChangingBrain] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

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
  const openMember = (other: TeamMember) =>
    void navigate({
      to: "/assistants",
      search: { view: "profile", env: other.environmentId, project: other.projectId },
    });
  const openThread = (thread: SidebarThreadSummary) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({
        environmentId: thread.environmentId,
        threadId: thread.id as ThreadId,
      }),
    });
  const newChat = () =>
    void handleNewThread(
      scopeProjectRef(member.environmentId as EnvironmentId, member.projectId as ProjectId),
      { envMode: "local" },
    );

  const running = [...member.chats.work, ...member.chats.conversations].filter((thread) => {
    const status = resolveSidebarThreadStatus(thread);
    return status === "working" || status === "approval" || status === "input";
  });
  const parent = member.createdBy
    ? (team.find((item) => item.key === member.createdBy) ?? null)
    : null;
  const beyond = parent ? rightsBeyondParent(parent.profile, profile) : [];
  const tree = buildAssistantTree(team);
  const descendants = descendantKeys(team, member.key);
  const computers = profile.computers.map((id) => labels.get(id) ?? "a computer");

  const setPreset = (preset: AssistantPreset) => {
    patchProfile(member.key, { preset });
    toastManager.add({
      type: "success",
      title: `${profile.name}: ${PRESET_NAME[preset]}`,
      description: "From its next step.",
    });
  };
  const doRevoke = () => {
    const more = revoke(member.key);
    setConfirmRevoke(false);
    toastManager.add({
      type: "success",
      title: `${profile.name} is revoked`,
      description:
        more > 0
          ? `And ${more} assistant${more === 1 ? "" : "s"} it set up. Its chats stay.`
          : "Its chats stay. Bring it back any time.",
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
              <AssistantAvatar
                emoji={profile.emoji}
                tone={profile.tone}
                activity={member.activity}
                revoked={member.revoked}
                className="size-14"
                emojiClassName="text-3xl"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-xl font-semibold leading-tight">{profile.name}</h1>
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
                <p className="text-sm text-muted-foreground">{profileLine(profile)}</p>
                <p className="text-xs text-muted-foreground">
                  {profile.character ? `${profile.character} · ` : ""}
                  Takes tasks only from you · lives on {member.computerLabel || "this computer"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {member.revoked ? (
                  <Button size="sm" variant="outline" onClick={() => restore(member.key)}>
                    <RotateCcwIcon className="size-3.5" /> Bring back
                  </Button>
                ) : (
                  <>
                    <Button size="sm" variant="outline" onClick={() => openSetup(member)}>
                      Set up again
                    </Button>
                    <Button size="sm" onClick={newChat} data-testid="assistant-profile-new-chat">
                      <SquarePenIcon className="size-3.5" /> New chat
                    </Button>
                  </>
                )}
              </div>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
              <Section title="Now" testId="assistant-profile-now">
                {running.length > 0 ? (
                  running
                    .slice(0, 4)
                    .map((thread) => (
                      <ChatLine key={thread.id} thread={thread} onOpen={() => openThread(thread)} />
                    ))
                ) : (
                  <p className="px-3 py-2 text-sm text-muted-foreground">Idle — nothing running.</p>
                )}
                {(profile.schedule ?? []).map((task) => (
                  <div
                    key={task.name}
                    className="flex h-8 items-center gap-2 border-t border-border/70 px-3 text-sm"
                  >
                    <CalendarClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{task.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{task.when}</span>
                  </div>
                ))}
              </Section>

              <Section title={`Chats · ${member.chats.conversations.length}`}>
                {member.chats.conversations.length > 0 ? (
                  member.chats.conversations
                    .slice(0, 6)
                    .map((thread) => (
                      <ChatLine key={thread.id} thread={thread} onOpen={() => openThread(thread)} />
                    ))
                ) : (
                  <p className="px-3 py-2 text-sm text-muted-foreground">No chats yet.</p>
                )}
              </Section>
            </div>

            <Section title="Access and role" testId="assistant-profile-access">
              <Row label="May">
                <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="What it may do">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      role="radio"
                      aria-checked={profile.preset === preset.id}
                      disabled={member.revoked}
                      onClick={() => setPreset(preset.id)}
                      title={preset.line}
                      className={cn(
                        "h-6 cursor-pointer rounded-md border px-2 text-xs transition-colors disabled:cursor-default",
                        profile.preset === preset.id
                          ? "border-primary/50 bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:bg-accent",
                      )}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {PRESETS.find((preset) => preset.id === profile.preset)?.line}
                </p>
              </Row>
              <Row label="Projects">
                <div className="flex flex-wrap gap-1">
                  {profile.projects === "all" ? (
                    <Pill>Every project</Pill>
                  ) : (
                    profile.projects.map((name) => <Pill key={name}>{name}</Pill>)
                  )}
                </div>
              </Row>
              <Row label="Computers">
                <div className="flex flex-wrap gap-1">
                  {computers.map((label) => (
                    <Pill key={label}>
                      <LaptopIcon className="mr-1 size-3 text-muted-foreground" />
                      {label}
                    </Pill>
                  ))}
                </div>
              </Row>
              <Row label="Role" last={profile.skills.length === 0}>
                <div className="flex flex-wrap gap-1">
                  {profile.roles.length > 0 ? (
                    profile.roles.map((role) => <Pill key={role}>{role}</Pill>)
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
              </Row>
              {profile.skills.length > 0 ? (
                <Row label="Skills" last>
                  <div className="flex flex-wrap gap-1">
                    {profile.skills.map((skill) => (
                      <Pill key={skill} muted>
                        {skill}
                      </Pill>
                    ))}
                  </div>
                </Row>
              ) : null}
            </Section>

            <div className="grid gap-6 md:grid-cols-2">
              <Section
                title="Runs on"
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
                {changingBrain ? (
                  <AssistantPowerPicker
                    environmentId={member.environmentId as EnvironmentId}
                    value={profile.brain}
                    onChange={(brain) => patchProfile(member.key, { brain })}
                    note={`Only for ${profile.name}.`}
                    className="p-2 [&_[role=radiogroup]]:grid-cols-1"
                  />
                ) : (
                  <p className="px-3 py-2 text-sm">
                    {BRAIN_NAME[profile.brain]}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {profile.brain === "uno"
                        ? "included in your plan"
                        : profile.brain === "key"
                          ? "billed by the key's provider"
                          : "your plan's limits apply · Uno doesn't charge"}
                    </span>
                  </p>
                )}
              </Section>

              <Section title="Where you talk">
                <div className="flex h-9 items-center gap-2 border-b border-border/70 px-3 text-sm">
                  <SendIcon className="size-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{CHANNEL_NAME[profile.channel]}</span>
                  {profile.channelHandle ? (
                    <span className="text-xs text-muted-foreground">{profile.channelHandle}</span>
                  ) : (
                    <span className="text-xs text-primary">Link</span>
                  )}
                </div>
                <div className="flex h-9 items-center gap-2 px-3 text-sm">
                  <MessageCircleIcon className="size-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1">Here in Uno Work</span>
                  <span className="text-xs text-muted-foreground">always</span>
                </div>
              </Section>
            </div>

            <Section
              title="What it can use"
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
              <TeammateAccess
                name={profile.name}
                access={accessOf(profile)}
                onChange={member.revoked ? null : (access) => patchProfile(member.key, { access })}
                foldWhenFull
              />
            </Section>

            <Section title="Memory">
              <MemoryFile member={member} name="NOTES.md" what="what it has learned" />
              <MemoryFile member={member} name="AGENTS.md" what="its instructions" last />
            </Section>

            <Section
              title="Team"
              testId="assistant-profile-team"
              action={
                <button
                  type="button"
                  onClick={() => openNewAssistant()}
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
                    onOpen={openMember}
                  />
                ))}
              </div>
              <div className="border-t border-border/70 px-3 py-2.5 text-xs text-muted-foreground">
                {parent ? (
                  <p>
                    Set up by {parent.profile.name}
                    {" · "}
                    {beyond.length === 0
                      ? `${parent.profile.name} can set up a helper within its own rights — you'll see it in Needs you.`
                      : `beyond ${parent.profile.name}'s access: ${beyond.join(", ")}`}
                  </p>
                ) : (
                  <p>Set up by you.</p>
                )}
                {member.revoked ? null : confirmRevoke ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-foreground">
                      Revoke {profile.name}
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
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmRevoke(true)}
                    className="mt-1.5 inline-flex cursor-pointer items-center gap-1 text-destructive hover:underline"
                    data-testid="assistant-profile-revoke"
                  >
                    <UserRoundXIcon className="size-3.5" />
                    Revoke access
                    {descendants.length > 0
                      ? ` — also revokes ${descendants
                          .map((key) => team.find((item) => item.key === key)?.profile.name ?? "")
                          .filter(Boolean)
                          .join(", ")}`
                      : ""}
                  </button>
                )}
              </div>
            </Section>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
