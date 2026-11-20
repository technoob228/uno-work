/**
 * T51 mockup (Misha 20.11): team work inside one project — share a chat with
 * a colleague, requests and messages between people and their agents, and
 * how far other people's agents may go with yours.
 *
 * DEMO ONLY. Nothing here talks to a server: the demo build seeds this store
 * (demo/teamCollabDemo.ts) and the real components read it. Outside the demo
 * it stays empty and every piece of T51 UI renders nothing. The design is in
 * reports/day_2026-11-20/team-collab/DESIGN.md.
 *
 * Address params of the demo: `t51=off` — Work as it is today (the "before"
 * shots); `as=andrei` — the same Work seen by Andrei, the colleague a chat
 * was shared with.
 */
import { create } from "zustand";

/** What a colleague gets with a shared chat. */
export type ShareLevel = "read" | "write";

/**
 * How far other people's agents may go with yours in this project, from off
 * to doing tasks without asking. The second is the default.
 */
export type AgentLevel = "off" | "ask" | "answer" | "tasks";

export const AGENT_LEVELS: ReadonlyArray<{
  readonly id: AgentLevel;
  readonly label: string;
  readonly line: string;
}> = [
  {
    id: "off",
    label: "Off",
    line: "Their agents can't reach you or your agents. People can still share chats.",
  },
  {
    id: "ask",
    label: "Ask me first",
    line: "Their agents' messages and requests come to your Inbox. Nothing starts until you press Start.",
  },
  {
    id: "answer",
    label: "Answer questions",
    line: "Your agent answers their agents' questions about this project by itself. It only reads: no changes, no keys, no files sent.",
  },
  {
    id: "tasks",
    label: "Do tasks",
    line: "Their agents can start a session on your computer in this project. No deploys, git push or keys; you see it and can stop it.",
  },
];

export const agentLevelLabel = (level: AgentLevel) =>
  AGENT_LEVELS.find((item) => item.id === level)?.label ?? level;

export interface TeamPerson {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: "owner" | "editor";
  /** Initials' colour. */
  readonly tone: "violet" | "emerald" | "amber" | "sky";
  readonly you?: boolean;
}

export interface ChatShare {
  readonly personId: string;
  readonly level: ShareLevel;
}

/** Something a colleague or their agent sent you. */
export interface TeamRequest {
  readonly id: string;
  readonly kind: "session" | "message" | "shared" | "write-access";
  readonly fromPersonId: string;
  /** Sent by their agent (from this chat of theirs), or by the person. */
  readonly viaAgentChat: string | null;
  readonly project: string;
  readonly computer: string;
  readonly title: string;
  readonly gist: string;
  readonly brief?: string;
  readonly minutesAgo: number;
  readonly status: "waiting" | "started" | "declined" | "read";
}

/** A message in one of your chats that another person's agent wrote. */
export interface TeamAgentSender {
  readonly personId: string;
  readonly chatTitle: string;
  /** The level it came in under, as your settings said at that moment. */
  readonly level: AgentLevel;
}

export interface JournalLine {
  readonly at: string;
  readonly text: string;
  readonly level?: AgentLevel;
}

interface TeamCollabState {
  readonly enabled: boolean;
  /** Whose Work this is: Misha's own, or Andrei's (`as=andrei`). */
  readonly viewer: "misha" | "andrei";
  readonly project: string;
  readonly people: ReadonlyArray<TeamPerson>;
  /** Chat id → who it is shared with. */
  readonly shares: Readonly<Record<string, ReadonlyArray<ChatShare>>>;
  /** Andrei's side: chat id → who shared it and how. */
  readonly sharedWithMe: Readonly<
    Record<
      string,
      { readonly ownerId: string; readonly level: ShareLevel; readonly computer: string }
    >
  >;
  readonly requests: ReadonlyArray<TeamRequest>;
  /** `sentByThreadId` of a message → the other person's agent that wrote it. */
  readonly agentSenders: Readonly<Record<string, TeamAgentSender>>;
  /** Chats holding text from another person's agent (the T49 mark). */
  readonly markedChats: Readonly<Record<string, string>>;
  readonly defaultLevel: AgentLevel;
  /** Per person, when not the default. */
  readonly levelFor: Readonly<Record<string, AgentLevel>>;
  readonly journal: ReadonlyArray<JournalLine>;
  /** The request whose brief is open. */
  readonly briefId: string | null;
}

const EMPTY: TeamCollabState = {
  enabled: false,
  viewer: "misha",
  project: "",
  people: [],
  shares: {},
  sharedWithMe: {},
  requests: [],
  agentSenders: {},
  markedChats: {},
  defaultLevel: "ask",
  levelFor: {},
  journal: [],
  briefId: null,
};

export const useTeamCollab = create<TeamCollabState>(() => EMPTY);

export function seedTeamCollab(state: Partial<TeamCollabState>) {
  useTeamCollab.setState({ ...EMPTY, ...state });
}

export const personById = (state: TeamCollabState, id: string) =>
  state.people.find((person) => person.id === id) ?? null;

export const firstName = (person: TeamPerson | null) => person?.name.split(" ")[0] ?? "Someone";

export function setChatShare(chatId: string, personId: string, level: ShareLevel | null) {
  useTeamCollab.setState((state) => {
    const current = (state.shares[chatId] ?? []).filter((share) => share.personId !== personId);
    const next = level ? [...current, { personId, level }] : current;
    return { shares: { ...state.shares, [chatId]: next } };
  });
}

export function decideTeamRequest(id: string, status: TeamRequest["status"]) {
  useTeamCollab.setState((state) => ({
    requests: state.requests.map((request) =>
      request.id === id ? { ...request, status } : request,
    ),
    briefId: null,
  }));
}

export function setAgentLevel(personId: string | null, level: AgentLevel) {
  useTeamCollab.setState((state) =>
    personId === null
      ? { defaultLevel: level }
      : { levelFor: { ...state.levelFor, [personId]: level } },
  );
}

export const openTeamBrief = (id: string | null) => useTeamCollab.setState({ briefId: id });

/** Waiting requests that need a button — added to the Needs you counts. */
export function useTeamWaitingCount(): number {
  return useTeamCollab(
    (state) =>
      state.requests.filter(
        (request) =>
          request.status === "waiting" &&
          (request.kind === "session" || request.kind === "write-access"),
      ).length,
  );
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
