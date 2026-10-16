/**
 * Pult — the owner's board of agent work inside Uno Work: what waits for them,
 * which tasks stand, run or wait for review, who does them and where.
 * The shape follows the tracker (uno-workspace/tracker) and the Pult 3.0 mocks.
 */

export type PultTaskStatus =
  | "needs_you"
  | "blocked"
  | "doing"
  | "review"
  | "paused"
  | "todo"
  | "idea"
  | "done"
  | "stopped";

export type PultChatState =
  | "working"
  | "needs_you"
  | "idle"
  | "quiet"
  | "paused_limit"
  | "dead"
  | "sleeping";

export interface PultMachine {
  readonly id: string;
  readonly name: string;
  readonly kind?: string;
  readonly subscription?: string;
  readonly online?: boolean;
  readonly warn?: string;
}

export interface PultLimitWindow {
  readonly name: string;
  readonly pct: number;
  readonly resetAt: string;
  readonly forecast: string;
}

export interface PultSubscription {
  readonly id: string;
  readonly vendor: string;
  readonly plan: string;
  readonly label: string;
  readonly machines: ReadonlyArray<string>;
  readonly windows: ReadonlyArray<PultLimitWindow>;
  readonly state: "ok" | "warn" | "out";
  readonly advice?: string;
  readonly burn?: string;
}

export interface PultChatMessage {
  readonly who: "misha" | "agent";
  readonly at: string;
  readonly text: string;
  readonly tools?: ReadonlyArray<string>;
  readonly options?: ReadonlyArray<string>;
}

export interface PultChat {
  readonly id: string;
  readonly title: string;
  readonly machine: string;
  readonly subscription: string;
  readonly agent: string;
  readonly model: string;
  readonly state: PultChatState;
  readonly lastAt: string;
  readonly tasks: ReadonlyArray<string>;
  readonly project?: string;
  readonly branch?: string;
  readonly summary?: string;
  readonly messages: ReadonlyArray<PultChatMessage>;
  /** The Uno Work chat behind it: opening the task opens this chat in the middle. */
  readonly thread?: PultThreadRef;
}

export interface PultThreadRef {
  readonly environmentId: string;
  readonly threadId: string;
}

export interface PultNeedOption {
  readonly label: string;
  readonly hint?: string;
  readonly recommended?: boolean;
}

/** What the task needs from the owner: decide (pick), do (by hand: money, access), look (check and say ok). */
export interface PultNeed {
  readonly kind: "decide" | "do" | "look";
  readonly title: string;
  readonly explain?: string;
  readonly money?: string;
  readonly options?: ReadonlyArray<PultNeedOption>;
  readonly steps?: ReadonlyArray<string>;
  readonly autoAt?: string | null;
  readonly autoText?: string;
  readonly askedAt?: string;
}

export interface PultArtifact {
  readonly kind: "site" | "file" | "branch" | "link" | "screen";
  readonly title: string;
  readonly url?: string;
  readonly path?: string;
  readonly password?: string;
  readonly note?: string;
}

export interface PultEnvLine {
  readonly what: string;
  readonly at?: string;
  readonly rollback?: string;
}

export interface PultTask {
  readonly id: string;
  readonly title: string;
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly rank: number;
  readonly status: PultTaskStatus;
  readonly progress: number;
  readonly stream?: string;
  readonly why?: string;
  readonly deadline?: string | null;
  readonly eta?: { readonly left?: string; readonly at?: string | null } | null;
  readonly chats: ReadonlyArray<string>;
  readonly owner: string | null;
  readonly stages?: ReadonlyArray<{ readonly name: string; readonly done: boolean; readonly now?: boolean }>;
  readonly blocker?: string;
  readonly pause?: string;
  readonly needs?: PultNeed;
  readonly request?: {
    readonly by: string;
    readonly at: string;
    readonly text: string;
    readonly wishes?: ReadonlyArray<string>;
  };
  readonly artifacts?: ReadonlyArray<PultArtifact>;
  readonly docs?: ReadonlyArray<string>;
  readonly actions?: ReadonlyArray<{
    readonly text: string;
    readonly done: boolean;
    readonly who: "agent" | "misha";
    readonly note?: string;
  }>;
  readonly env?: {
    readonly prod?: PultEnvLine | null;
    readonly stage?: PultEnvLine | null;
    readonly branch?: string;
  } | null;
  readonly feed?: ReadonlyArray<{ readonly at: string; readonly kind: string; readonly text: string }>;
}

export interface PultRelease {
  readonly at: string;
  readonly env: "prod" | "stage" | "plan";
  readonly what: string;
  readonly state: "ok" | "rolling" | "planned" | "failed";
  readonly by: string;
  readonly task: string | null;
  readonly rollback?: string;
  readonly progress?: number;
}

export interface PultWish {
  readonly at: string;
  readonly text: string;
  readonly where: "prod" | "stage" | "doing" | "lost" | "declined";
  readonly task: string | null;
  readonly note?: string;
}

export interface PultAlert {
  readonly at: string;
  readonly source: string;
  readonly raw: string;
  readonly plain: string;
  readonly needYou: boolean;
  readonly task?: string;
  readonly handledBy?: string;
  readonly muted?: boolean;
}

export interface PultEvent {
  readonly at: string;
  readonly kind: string;
  readonly text: string;
  readonly task?: string;
  readonly bad?: boolean;
}

export interface PultDoc {
  readonly title: string;
  readonly updatedAt: string;
  readonly by: string;
  readonly md: string;
}

export interface PultAgentKind {
  readonly id: string;
  readonly name: string;
  readonly models: ReadonlyArray<string>;
  readonly subs: ReadonlyArray<string>;
}

export interface PultData {
  readonly NOW: string;
  readonly lastSeen: string;
  readonly machines: ReadonlyArray<PultMachine>;
  readonly subscriptions: ReadonlyArray<PultSubscription>;
  readonly chats: ReadonlyArray<PultChat>;
  readonly tasks: ReadonlyArray<PultTask>;
  readonly releases: ReadonlyArray<PultRelease>;
  readonly decisions: ReadonlyArray<{ readonly at: string; readonly text: string; readonly task: string | null }>;
  readonly docs: Readonly<Record<string, PultDoc>>;
  readonly sinceLastSeen: ReadonlyArray<PultEvent>;
  readonly agentKinds: ReadonlyArray<PultAgentKind>;
  readonly wishes: ReadonlyArray<PultWish>;
  readonly alerts: ReadonlyArray<PultAlert>;
  readonly upcoming: ReadonlyArray<{ readonly at: string; readonly text: string; readonly task?: string; readonly chat?: string }>;
}
