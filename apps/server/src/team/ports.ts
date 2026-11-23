/**
 * What the team workers (shareMirror.ts, inbound.ts, bridge.ts) use of
 * Uno Work, as plain promises: TeamCollab.ts builds it from the services,
 * the tests from fakes.
 *
 * @module team/ports
 */
import type { TeamChatStatus, TeamErrorPart } from "@t3tools/contracts";

import type { HostRecord } from "../chatRequests/hostLogic.ts";
import type { ReadOnlyStartInput, TeamHostShape } from "../chatRequests/host.ts";
import type { MirrorMessage, ToolCounts } from "./shareMirror.logic.ts";
import type { PartsCache, TeamCloud } from "./teamCloud.ts";
import type { TeamProjectHere } from "./teamProjects.ts";

export interface LocalThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: TeamChatStatus;
  /** A turn runs, or the chat waits for the person: a new turn can't start now. */
  readonly busy: boolean;
  /** Its project's folder here. */
  readonly folder: string | null;
}

export interface LocalThreadDetail {
  readonly messages: ReadonlyArray<MirrorMessage>;
  readonly toolsByTurn: ReadonlyMap<string, ToolCounts>;
}

export type TellResult = "told" | "busy" | "gone";

export interface ThreadFollow {
  readonly title: string;
  /** running | waiting-for-you | done | failed | idle | stopped */
  readonly state: string;
  readonly lastMessage: string | null;
}

export interface TeamTelegram {
  /** Telegram is linked for the person here. */
  readonly linked: () => Promise<boolean>;
  readonly send: (input: {
    readonly key: string;
    readonly text: string;
    readonly textWithoutButtons: string;
    /** Start / Decline for this record id; null: none. */
    readonly buttonsFor: string | null;
    readonly buttonsTtlMs?: number;
  }) => Promise<boolean>;
  readonly retire: (recordId: string, line: string) => Promise<void>;
}

export interface TeamPorts {
  readonly cloud: TeamCloud;
  readonly parts: PartsCache;
  /** This Work's environment id: the `source` of everything it sends. */
  readonly source: () => Promise<string>;
  readonly stateDir: string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;

  readonly projectsHere: () => Promise<ReadonlyArray<TeamProjectHere>>;
  /** The key values known here for a folder (never logged). */
  readonly folderSecrets: (folder: string) => Promise<ReadonlyArray<string>>;

  readonly thread: (threadId: string) => Promise<LocalThread | null>;
  readonly threadDetail: (threadId: string) => Promise<LocalThreadDetail | null>;
  /** Mark a chat as holding outside text (T49), before the text goes in. */
  readonly markOutside: (threadId: string) => Promise<void>;
  /** A new turn with this text as its message, when the chat is free. */
  readonly tell: (threadId: string, text: string) => Promise<TellResult>;
  /** Interrupt the turn and stop the session. */
  readonly stop: (threadId: string) => Promise<void>;

  readonly host: {
    readonly admit: (file: Parameters<TeamHostShape["admit"]>[0]) => Promise<HostRecord | null>;
    readonly autoStart: (id: string) => Promise<string>;
    readonly decide: (id: string, decision: "start" | "decline") => Promise<void>;
    readonly retire: (
      id: string,
      status: "expired" | "refused",
      reason: string,
    ) => Promise<HostRecord | null>;
    readonly startReadOnly: (
      input: ReadOnlyStartInput,
    ) => Promise<{ readonly threadId: string; readonly title: string }>;
    readonly follow: (threadId: string) => Promise<ThreadFollow | null>;
    readonly records: () => Promise<ReadonlyArray<HostRecord>>;
  };

  readonly telegram: TeamTelegram | null;
  /**
   * The person's own computers through the T50 tunnel (a cloud computer
   * with "Connect my computer"): where a colleague's session waits, and
   * pressing Start / Decline there. Null elsewhere.
   */
  readonly tunnel: {
    readonly findWaiting: (recordId: string) => Promise<{
      readonly computerId: string;
      readonly computerName: string;
    } | null>;
    readonly decide: (
      computerId: string,
      recordId: string,
      decision: "start" | "decline",
    ) => Promise<void>;
  } | null;
  readonly computerName: () => Promise<string>;

  readonly error: (part: TeamErrorPart, message: string) => void;
}
