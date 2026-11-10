/**
 * Moving an assistant to another computer of the account (Misha 10.11: "my
 * assistant lives on kinship and I can't move it").
 *
 * An assistant is its computer's: its folder (memory, rules, skills), its
 * state on that daemon (preset, app levels, team record), its project
 * (title, model), its Telegram / Slack connectors, its pending reminders and
 * its automations at the console. A move carries all of it as one bundle
 * and switches over in an order that never leaves two copies answering and
 * never leaves none:
 *
 * 1. **copy** — the source exports the bundle, the target imports it
 *    *staged*: everything but the channels;
 * 2. **check** — the target says the assistant is up there (project, folder,
 *    token); its automations are made there;
 * 3. **switch** — only now the source lets go (channels off, kept for Undo;
 *    a named assistant goes to Deleted, kept 7 days), then the target turns
 *    the channels on and claims the assistant as living there.
 *
 * Any failure before the switch removes the copy and leaves the source as it
 * was; a failure while switching gives the source its channels back. Chats
 * stay readable where they ran; a text copy of them travels in the folder
 * (`history/`).
 *
 * The same orchestration runs in the web app (both computers through the
 * app's connections) and in the daemon (`assistant_move`: this computer and
 * another one through the console's pairing). Plain promises, no Effect.
 *
 * @module assistantMove
 */

export const ASSISTANT_MOVE_BUNDLE_VERSION = 1;

/** One file of the bundle, relative to its root; `data` is base64. */
export interface AssistantMoveFile {
  readonly path: string;
  readonly mode: number;
  readonly data: string;
}

export interface AssistantMoveConnector {
  readonly kind: "telegram" | "slack";
  readonly config: unknown;
  /**
   * `own`: the person's own bot / app — its credentials move along.
   * `relay`: Uno's bot / Slack app through the console, bound to the source
   * computer — linked again on the target with one tap.
   */
  readonly via: "own" | "relay";
}

export interface AssistantMoveReminder {
  readonly reminderId: string;
  readonly chatId: string;
  readonly message: string;
  readonly dueAt: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly connector: string;
}

export interface AssistantMoveBundle {
  readonly version: typeof ASSISTANT_MOVE_BUNDLE_VERSION;
  readonly projectId: string;
  readonly title: string;
  /** Uno, the computer's own assistant (`assistant-home`). */
  readonly isUno: boolean;
  readonly exportedAt: string;
  readonly defaultModelSelection: unknown;
  /** Its folder, relative to its workspace root. */
  readonly workspace: ReadonlyArray<AssistantMoveFile>;
  /** Its state on the daemon, relative to `<state>/assistants/<id>/`. */
  readonly state: ReadonlyArray<AssistantMoveFile>;
  /** What stayed behind and why (too big, not a file). */
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  readonly connectors: ReadonlyArray<AssistantMoveConnector>;
  readonly reminders: ReadonlyArray<AssistantMoveReminder>;
  /** How many of its chats went along as text (`history/`). */
  readonly historyChats: number;
}

export interface AssistantMoveImportResult {
  readonly projectId: string;
  readonly ok: boolean;
  /** Plain words, one per thing that is not right on the target. */
  readonly problems: ReadonlyArray<string>;
}

export interface AssistantMoveActivateResult {
  /** Channels to link again on the target ("telegram", "slack"). */
  readonly relink: ReadonlyArray<"telegram" | "slack">;
}

/** An automation of the assistant as the target makes it again. */
export interface AssistantMoveAutomation {
  readonly id: number;
  readonly name: string;
  /** The create input for the target (name, instruction, trigger, executor, enabled …). */
  readonly input: Record<string, unknown>;
}

export interface AssistantMoveComputer {
  readonly name: string;
  readonly boxId: number | null;
}

export interface AssistantMoveDeps {
  readonly source: {
    readonly exportBundle: (projectId: string) => Promise<AssistantMoveBundle>;
    readonly release: (input: {
      readonly projectId: string;
      readonly to: AssistantMoveComputer;
    }) => Promise<void>;
    readonly unrelease: (projectId: string) => Promise<void>;
    /**
     * Its automations at the console: the ones that move, and the names of the
     * ones that stay (see {@link splitMovableAutomations}).
     */
    readonly listAutomations?: (projectId: string) => Promise<{
      readonly move: ReadonlyArray<AssistantMoveAutomation>;
      readonly stay: ReadonlyArray<string>;
    }>;
    readonly deleteAutomation?: (id: number) => Promise<void>;
  };
  readonly target: {
    readonly importBundle: (input: {
      readonly bundle: AssistantMoveBundle;
      readonly from: AssistantMoveComputer;
    }) => Promise<AssistantMoveImportResult>;
    readonly activate: (input: {
      readonly projectId: string;
      readonly bundle: AssistantMoveBundle;
      readonly from: AssistantMoveComputer;
    }) => Promise<AssistantMoveActivateResult>;
    readonly discard: (projectId: string) => Promise<void>;
    readonly createAutomation?: (
      input: Record<string, unknown>,
    ) => Promise<{ readonly id: number }>;
    readonly deleteAutomation?: (id: number) => Promise<void>;
  };
  readonly sleep?: (ms: number) => Promise<void>;
}

export type AssistantMoveStep = "copy" | "check" | "switch" | "done";

export interface AssistantMoveInput {
  readonly projectId: string;
  readonly name: string;
  readonly from: AssistantMoveComputer;
  readonly to: AssistantMoveComputer;
}

export interface AssistantMoveOutcome {
  readonly projectId: string;
  readonly relink: ReadonlyArray<"telegram" | "slack">;
  readonly automationsMoved: number;
  readonly historyChats: number;
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  /** Things that went wrong after the switch (the move itself stands). */
  readonly warnings: ReadonlyArray<string>;
}

/** A move that didn't happen; `changed: false` means the source is as it was. */
export class AssistantMoveError extends Error {
  readonly step: AssistantMoveStep;
  readonly changed: boolean;
  constructor(
    message: string,
    input: { step: AssistantMoveStep; changed: boolean; cause?: unknown },
  ) {
    super(message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "AssistantMoveError";
    this.step = input.step;
    this.changed = input.changed;
  }
}

/**
 * The source's long poll of an own Telegram bot ends within this; the target
 * starts polling after it, so the bot never sees two pollers (409).
 */
export const TELEGRAM_POLL_HANDOVER_MS = 11_000;

const reasonOf = (cause: unknown): string => {
  const text = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return text.trim().length > 0 ? text.trim().replace(/\.$/, "") : "it didn't answer";
};

const quietly = async (task: () => Promise<unknown>): Promise<void> => {
  try {
    await task();
  } catch {
    // best effort: the caller already reports the failure that matters
  }
};

/** Copy → check → switch, with the rollback of each step (see the module doc). */
export async function runAssistantMove(
  input: AssistantMoveInput,
  deps: AssistantMoveDeps,
  onStep: (step: AssistantMoveStep) => void = () => undefined,
): Promise<AssistantMoveOutcome> {
  const { name, from, to } = input;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  if (from.boxId !== null && from.boxId === to.boxId) {
    throw new AssistantMoveError(`${name} already lives on ${to.name}.`, {
      step: "copy",
      changed: false,
    });
  }

  // 1. Copy.
  onStep("copy");
  let bundle: AssistantMoveBundle;
  try {
    bundle = await deps.source.exportBundle(input.projectId);
  } catch (cause) {
    throw new AssistantMoveError(
      `Couldn't read ${name} on ${from.name} (${reasonOf(cause)}). Nothing changed.`,
      { step: "copy", changed: false, cause },
    );
  }
  let imported: AssistantMoveImportResult;
  try {
    imported = await deps.target.importBundle({ bundle, from });
  } catch (cause) {
    await quietly(() => deps.target.discard(bundle.projectId));
    throw new AssistantMoveError(
      `${to.name} didn't take ${name} (${reasonOf(cause)}). Nothing changed on ${from.name}.`,
      { step: "copy", changed: false, cause },
    );
  }

  // 2. Check, and its automations there.
  onStep("check");
  if (!imported.ok) {
    await quietly(() => deps.target.discard(imported.projectId));
    throw new AssistantMoveError(
      `${name} didn't come up on ${to.name}: ${imported.problems.join("; ") || "unknown problem"}. Nothing changed on ${from.name}.`,
      { step: "check", changed: false },
    );
  }
  const listed =
    deps.source.listAutomations === undefined
      ? { move: [], stay: [] }
      : await deps.source.listAutomations(input.projectId).catch(() => ({ move: [], stay: [] }));
  const automations = listed.move;
  const madeThere: number[] = [];
  const undoTarget = async () => {
    for (const id of madeThere) {
      await quietly(() => deps.target.deleteAutomation?.(id) ?? Promise.resolve());
    }
    await quietly(() => deps.target.discard(imported.projectId));
  };
  if (automations.length > 0) {
    if (deps.target.createAutomation === undefined) {
      await undoTarget();
      throw new AssistantMoveError(
        `${name} has ${automations.length} automation${automations.length === 1 ? "" : "s"}, and ${to.name} can't run automations (they need a cloud computer). Nothing changed.`,
        { step: "check", changed: false },
      );
    }
    for (const automation of automations) {
      try {
        madeThere.push((await deps.target.createAutomation(automation.input)).id);
      } catch (cause) {
        await undoTarget();
        throw new AssistantMoveError(
          `Its automation “${automation.name}” couldn't be made on ${to.name} (${reasonOf(cause)}). Nothing changed on ${from.name}.`,
          { step: "check", changed: false, cause },
        );
      }
    }
  }

  // 3. Switch: the source lets go first, then the target answers.
  onStep("switch");
  try {
    await deps.source.release({ projectId: input.projectId, to });
  } catch (cause) {
    await undoTarget();
    throw new AssistantMoveError(
      `${from.name} didn't let ${name} go (${reasonOf(cause)}). Nothing changed.`,
      { step: "switch", changed: false, cause },
    );
  }
  if (
    bundle.connectors.some((connector) => connector.kind === "telegram" && connector.via === "own")
  ) {
    await sleep(TELEGRAM_POLL_HANDOVER_MS);
  }
  let activated: AssistantMoveActivateResult;
  try {
    activated = await deps.target.activate({ projectId: imported.projectId, bundle, from });
  } catch (cause) {
    let back = true;
    try {
      await deps.source.unrelease(input.projectId);
    } catch {
      back = false;
    }
    await undoTarget();
    throw new AssistantMoveError(
      back
        ? `${to.name} couldn't turn ${name} on (${reasonOf(cause)}). It stays on ${from.name}, as before.`
        : `${to.name} couldn't turn ${name} on (${reasonOf(cause)}), and ${from.name} didn't take it back. Open ${from.name} → ${name} → Undo the move.`,
      { step: "switch", changed: !back, cause },
    );
  }

  const warnings: string[] = listed.stay.map(
    (automationName) =>
      `“${automationName}” stays on ${from.name}: its web address or chat is there.`,
  );
  for (const automation of automations) {
    try {
      await deps.source.deleteAutomation?.(automation.id);
    } catch (cause) {
      warnings.push(
        `The old copy of “${automation.name}” is still on ${from.name} (${reasonOf(cause)}); turn it off there.`,
      );
    }
  }
  onStep("done");
  return {
    projectId: imported.projectId,
    relink: activated.relink,
    automationsMoved: madeThere.length,
    historyChats: bundle.historyChats,
    skipped: bundle.skipped,
    warnings,
  };
}

/** One line for the person once it moved: what came along and what is left to do. */
export function describeAssistantMove(
  outcome: AssistantMoveOutcome,
  input: { readonly name: string; readonly from: string; readonly to: string },
): string {
  const parts = [`${input.name} lives on ${input.to} now: memory, rules, settings`];
  if (outcome.automationsMoved > 0) {
    parts[0] += `, ${outcome.automationsMoved} automation${outcome.automationsMoved === 1 ? "" : "s"}`;
  }
  parts[0] += " came along.";
  parts.push(
    outcome.historyChats > 0
      ? `Old chats stay readable on ${input.from}; a text copy is in its folder (history/).`
      : `Old chats stay readable on ${input.from}.`,
  );
  if (outcome.relink.length > 0) {
    const what = outcome.relink
      .map((kind) => (kind === "telegram" ? "Telegram" : "Slack"))
      .join(" and ");
    parts.push(`Connect ${what} again on ${input.to} — Uno's bot is per computer.`);
  }
  if (outcome.skipped.length > 0) {
    parts.push(
      `${outcome.skipped.length} big file${outcome.skipped.length === 1 ? "" : "s"} stayed on ${input.from}.`,
    );
  }
  return [...parts, ...outcome.warnings].join(" ");
}

/** An automation as the console lists it, as far as a move reads it. */
export interface AssistantMoveListedAutomation {
  readonly id: number;
  readonly assistant: string;
  readonly name: string;
  readonly instruction: string;
  readonly enabled: boolean;
  readonly trigger: { readonly kind: string } & Record<string, unknown>;
  readonly executor?: ({ readonly kind: string } & Record<string, unknown>) | undefined;
}

/**
 * Which of an assistant's automations move with it: the ones it runs itself
 * on a schedule or an event. A webhook / site form keeps its address only
 * where it is, and one that runs in a chat or a project needs that chat
 * there — those stay (by name).
 */
export function splitMovableAutomations(
  automations: ReadonlyArray<AssistantMoveListedAutomation>,
  projectId: string,
): { readonly move: AssistantMoveAutomation[]; readonly stay: string[] } {
  const move: AssistantMoveAutomation[] = [];
  const stay: string[] = [];
  for (const automation of automations) {
    if (automation.assistant !== projectId) continue;
    const outside =
      automation.trigger.kind === "webhook" || automation.trigger.kind === "site.form";
    const elsewhere = automation.executor !== undefined && automation.executor.kind !== "assistant";
    if (outside || elsewhere) {
      stay.push(automation.name);
      continue;
    }
    move.push({
      id: automation.id,
      name: automation.name,
      input: {
        assistant: projectId,
        name: automation.name,
        instruction: automation.instruction,
        trigger: automation.trigger,
        ...(automation.executor !== undefined ? { executor: automation.executor } : {}),
        enabled: automation.enabled,
      },
    });
  }
  return { move, stay };
}
