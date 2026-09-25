/**
 * "You were signed out" — pure detection of a harness that lost its sign-in
 * (expired login, revoked key) for the chat's re-auth card.
 *
 * Two signals, either is enough:
 *   - the daemon's provider snapshot: installed, and `auth.status` is
 *     `unauthenticated` (the provider probes in apps/server/src/provider);
 *   - the failed turn's error text, matched against per-harness auth-loss
 *     patterns (the snapshot is re-probed only now and then, a 401 is now).
 *
 * Not installed is not signed out (the install UI owns that), billing is not
 * signed out (UnoBillingTopUpBanner owns that), and custom (ACP) harnesses
 * keep their plain error: we don't know how they sign in.
 *
 * The assistant chat always runs on Hermes, whatever its session or model
 * selection says (a chat moved from Codex to Hermes keeps a stale Codex
 * session); its sign-in is the LLM provider behind Hermes: the Uno account
 * key, or the person's own key for xAI / OpenRouter / OpenAI / custom.
 *
 * @module components/harness/harnessAuthLoss
 */
import {
  AI_PROVIDER_LABELS,
  ASSISTANT_HARNESS_INSTANCE_ID,
  CUSTOM_HARNESS_DRIVER_KIND,
  type AssistantLlmProvider,
  type ModelSelection,
  type OrchestrationSessionErrorClass,
  type ServerProvider,
} from "@t3tools/contracts";
import { isAssistantConversation } from "@t3tools/shared/assistantChat";
import {
  coerceAssistantModelSelection,
  readAssistantLlmProvider,
} from "@t3tools/shared/assistantLlm";

export type HarnessAuthLossKind =
  /** Claude / Codex: the in-app sign-in dialog (account or API key). */
  | "signIn"
  /** OpenCode: paste a new provider key. */
  | "updateKey"
  /** Cursor: no in-app login — `agent login` in a terminal. */
  | "cursorCli"
  /** The Uno gateway (and Hermes on it): the Uno account key, in Settings. */
  | "unoAccount"
  /** The assistant on the person's own LLM key: Settings → AI provider keys. */
  | "assistantKey";

export interface HarnessAuthLoss {
  readonly kind: HarnessAuthLossKind;
  /** Driver whose sign-in is lost (`hermes` for the assistant chat). */
  readonly driver: string;
  readonly harnessLabel: string;
  readonly title: string;
  readonly message: string;
  readonly actionLabel: string;
  /** Terminal command for harnesses without an in-app login (Cursor). */
  readonly command: string | null;
  /**
   * `error`: a turn failed on it (the card offers a retry); `status`: the
   * daemon's snapshot says so (nothing failed yet).
   */
  readonly source: "status" | "error";
}

export interface DetectHarnessAuthLossInput {
  readonly driver: string | null;
  readonly providerStatus: ServerProvider | null;
  readonly threadError: string | null;
  readonly sessionLastError: string | null;
  /**
   * The harness's short final reply of the last turn: Claude Code answers a
   * lost login with a reply ("Not logged in · Please run /login"), not an
   * error. Only a short reply counts (see `lastShortReply`).
   */
  readonly lastReply?: string | null | undefined;
  readonly sessionLastErrorClass?: OrchestrationSessionErrorClass | null | undefined;
  /** Set for the assistant chat: the LLM provider behind Hermes. */
  readonly assistantLlmProvider?: AssistantLlmProvider | null | undefined;
  /** A custom (ACP) harness: never a re-auth card. */
  readonly isCustom: boolean;
}

export const CURSOR_LOGIN_COMMAND = "agent login";

/** Anchor of Settings → Providers → "AI provider keys" (EnvironmentProvidersPanel). */
export const AI_PROVIDER_KEYS_ANCHOR = "ai-provider-keys";

/** Every string the re-auth card shows, in one place. */
export const HARNESS_REAUTH_COPY = {
  signedOutTitle: (label: string) => `You were signed out of ${label}`,
  signInMessage: (label: string) =>
    `${label} can't answer until you sign in again. This chat is kept.`,
  openCodeMessage: "The API key OpenCode uses stopped working. Paste a new one to continue.",
  cursorMessage:
    "Cursor signs in from a terminal on this computer. Run this command there, then retry.",
  unoMessage:
    "The Uno account key on this computer stopped working. Sign in again in Settings to continue.",
  assistantKeyTitle: (provider: string) => `Your ${provider} key stopped working`,
  assistantKeyMessage: (provider: string) =>
    `${provider} rejected the key Uno uses. Add a new key in Settings, or switch Uno back to the Uno gateway.`,
  signInAction: "Sign in again",
  updateKeyAction: "Update key",
  openSettingsAction: "Open Settings",
  copyCommandDone: "Copied. Paste it in a terminal on this computer.",
  signedInTitle: (label: string) => `Signed in to ${label}`,
  signedInMessage: "Send your last message again?",
  retryAction: "Retry",
  retryingAction: "Retrying…",
  retryUnavailable: "Signed in. Send your message again to continue.",
} as const;

const HARNESS_LABELS: Readonly<Record<string, string>> = {
  claudeAgent: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  uno: "Uno AI",
  cursor: "Cursor",
  hermes: "Uno",
};

const KNOWN_DRIVERS: ReadonlySet<string> = new Set(Object.keys(HARNESS_LABELS));

const HTTP_401 = /\b401\b/;
const HTTP_403 = /\b403\b/;
const UNAUTHORIZED = /unauthori[sz]ed/i;
const INVALID_API_KEY = /invalid[ _-]?(x-)?api[ _-]?key/i;
const INCORRECT_API_KEY = /incorrect api key/i;

/** Error-text patterns that mean "this harness lost its sign-in", per driver. */
const AUTH_LOSS_PATTERNS: Readonly<Record<string, ReadonlyArray<RegExp>>> = {
  codex: [
    /not authenticated/i,
    HTTP_401,
    UNAUTHORIZED,
    /codex login/i,
    /refresh token/i,
    /token (has )?expired/i,
  ],
  claudeAgent: [
    INVALID_API_KEY,
    /oauth token has expired/i,
    /please run \/login/i,
    /(^|\s)\/login\b/i,
    /authentication_error/i,
  ],
  opencode: [HTTP_401, INVALID_API_KEY, INCORRECT_API_KEY],
  uno: [HTTP_401, INVALID_API_KEY, UNAUTHORIZED],
  hermes: [HTTP_401, INVALID_API_KEY, UNAUTHORIZED],
  cursor: [/not authenticated/i, /agent login/i],
};

/** An assistant on the person's own key: the provider turned the key down. */
const BYOK_AUTH_PATTERNS: ReadonlyArray<RegExp> = [
  HTTP_401,
  HTTP_403,
  INVALID_API_KEY,
  INCORRECT_API_KEY,
  UNAUTHORIZED,
];

/** Out of credits is a top-up, not a sign-in (UnoBillingTopUpBanner). */
const BILLING_PATTERNS: ReadonlyArray<RegExp> = [
  /\b402\b/,
  /insufficient[ _](balance|credits|funds|quota)/i,
  /no_money/i,
  /llm (balance|credits)/i,
  /credits (are )?(empty|depleted)/i,
  /credits_depleted/i,
  /payment required/i,
];

const matchesAny = (text: string, patterns: ReadonlyArray<RegExp>): boolean =>
  patterns.some((pattern) => pattern.test(text));

export function isBillingErrorText(text: string | null | undefined): boolean {
  return Boolean(text) && matchesAny(text!, BILLING_PATTERNS);
}

/** Whether `text` reads as an auth loss for `driver` (billing never does). */
export function isAuthLossErrorText(driver: string, text: string | null | undefined): boolean {
  if (!text || isBillingErrorText(text)) return false;
  const patterns = AUTH_LOSS_PATTERNS[driver];
  return patterns ? matchesAny(text, patterns) : false;
}

export function isByokAuthErrorText(text: string | null | undefined): boolean {
  if (!text || isBillingErrorText(text)) return false;
  return matchesAny(text, BYOK_AUTH_PATTERNS);
}

function errorTexts(input: DetectHarnessAuthLossInput): ReadonlyArray<string> {
  if (input.sessionLastErrorClass === "billing_error") return [];
  return [input.threadError, input.sessionLastError, input.lastReply ?? null].filter(
    (text): text is string => typeof text === "string" && text.trim().length > 0,
  );
}

function snapshotSignedOut(status: ServerProvider | null): boolean {
  return status !== null && status.installed && status.auth.status === "unauthenticated";
}

function build(
  kind: HarnessAuthLossKind,
  driver: string,
  harnessLabel: string,
  source: HarnessAuthLoss["source"],
): HarnessAuthLoss {
  const copy = HARNESS_REAUTH_COPY;
  switch (kind) {
    case "signIn":
      return {
        kind,
        driver,
        harnessLabel,
        source,
        title: copy.signedOutTitle(harnessLabel),
        message: copy.signInMessage(harnessLabel),
        actionLabel: copy.signInAction,
        command: null,
      };
    case "updateKey":
      return {
        kind,
        driver,
        harnessLabel,
        source,
        title: copy.signedOutTitle(harnessLabel),
        message: copy.openCodeMessage,
        actionLabel: copy.updateKeyAction,
        command: null,
      };
    case "cursorCli":
      return {
        kind,
        driver,
        harnessLabel,
        source,
        title: copy.signedOutTitle(harnessLabel),
        message: copy.cursorMessage,
        actionLabel: copy.signInAction,
        command: CURSOR_LOGIN_COMMAND,
      };
    case "unoAccount":
      return {
        kind,
        driver,
        harnessLabel,
        source,
        title: copy.signedOutTitle(harnessLabel),
        message: copy.unoMessage,
        actionLabel: copy.signInAction,
        command: null,
      };
    case "assistantKey":
      return {
        kind,
        driver,
        harnessLabel,
        source,
        title: copy.assistantKeyTitle(harnessLabel),
        message: copy.assistantKeyMessage(harnessLabel),
        actionLabel: copy.updateKeyAction,
        command: null,
      };
  }
}

const KIND_BY_DRIVER: Readonly<Record<string, HarnessAuthLossKind>> = {
  claudeAgent: "signIn",
  codex: "signIn",
  opencode: "updateKey",
  cursor: "cursorCli",
  uno: "unoAccount",
  // Hermes outside the assistant chat still runs on the Uno account key.
  hermes: "unoAccount",
};

function detectAssistant(
  input: DetectHarnessAuthLossInput,
  provider: AssistantLlmProvider,
): HarnessAuthLoss | null {
  const texts = errorTexts(input);
  if (provider !== "uno") {
    // The Hermes snapshot only knows the Uno key; the person's own key shows
    // up as a failed turn.
    if (!texts.some(isByokAuthErrorText)) return null;
    const label = provider === "custom" ? "custom provider" : AI_PROVIDER_LABELS[provider];
    return build("assistantKey", "hermes", label, "error");
  }
  if (input.providerStatus && !input.providerStatus.installed) return null;
  if (texts.some((text) => isAuthLossErrorText("hermes", text))) {
    return build("unoAccount", "hermes", HARNESS_LABELS.uno!, "error");
  }
  if (snapshotSignedOut(input.providerStatus)) {
    return build("unoAccount", "hermes", HARNESS_LABELS.uno!, "status");
  }
  return null;
}

export function detectHarnessAuthLoss(input: DetectHarnessAuthLossInput): HarnessAuthLoss | null {
  if (input.assistantLlmProvider) {
    return detectAssistant(input, input.assistantLlmProvider);
  }
  if (input.isCustom) return null;
  const driver = input.driver ?? input.providerStatus?.driver ?? null;
  if (!driver || !KNOWN_DRIVERS.has(driver)) return null;
  // Not installed is an install problem, not a sign-in one.
  if (input.providerStatus && !input.providerStatus.installed) return null;

  const kind = KIND_BY_DRIVER[driver]!;
  const label = input.providerStatus?.displayName?.trim() || HARNESS_LABELS[driver]!;
  if (errorTexts(input).some((text) => isAuthLossErrorText(driver, text))) {
    return build(kind, driver, label, "error");
  }
  if (snapshotSignedOut(input.providerStatus)) {
    return build(kind, driver, label, "status");
  }
  return null;
}

/**
 * A turn failed on an auth-looking error while the snapshot still reads
 * signed in: worth one re-probe so the picker badge catches up.
 */
export function shouldReprobeProvider(
  loss: HarnessAuthLoss | null,
  providerStatus: ServerProvider | null,
): boolean {
  return (
    loss !== null &&
    loss.source === "error" &&
    loss.kind !== "assistantKey" &&
    providerStatus !== null &&
    providerStatus.auth.status === "authenticated"
  );
}

/** What of a thread the detection reads (the web `Thread` fits). */
export interface HarnessAuthLossThread {
  readonly projectId: string;
  readonly assistantRole?: "chat" | "spawned" | null | undefined;
  readonly modelSelection: Pick<ModelSelection, "instanceId" | "options"> & { model: string };
  readonly error: string | null;
  readonly session: {
    readonly provider: string;
    readonly providerInstanceId?: string | undefined;
    readonly lastError?: string | undefined;
    readonly lastErrorClass?: OrchestrationSessionErrorClass | undefined;
    /** While a (retried) turn runs, the previous turn's error is history. */
    readonly orchestrationStatus?: string | undefined;
  } | null;
  readonly messages?: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly streaming?: boolean | undefined;
  }>;
}

/** Longest final reply still read as a harness status line, not an answer. */
export const AUTH_REPLY_MAX_CHARS = 240;

/**
 * The last message when it is a finished, short reply of the harness: a
 * status line like "Not logged in · Please run /login". A real answer that
 * happens to mention a login is longer or isn't the last message.
 */
function lastShortReply(thread: HarnessAuthLossThread): string | null {
  const last = thread.messages?.at(-1);
  if (!last || last.role !== "assistant" || last.streaming === true) return null;
  const text = last.text.trim();
  return text.length > 0 && text.length <= AUTH_REPLY_MAX_CHARS ? text : null;
}

function liveSessionError(thread: HarnessAuthLossThread): string | null {
  const status = thread.session?.orchestrationStatus;
  if (status === "running" || status === "starting") return null;
  return thread.session?.lastError ?? null;
}

export interface ThreadHarnessAuthLoss {
  /** The thread is a conversation with the assistant (always Hermes). */
  readonly isAssistant: boolean;
  /** The provider snapshot the chat runs on (Hermes for the assistant). */
  readonly providerStatus: ServerProvider | null;
  readonly loss: HarnessAuthLoss | null;
  /**
   * Hide the raw thread error: the re-auth card says it better, or it is a
   * stale sign-in error of the harness an assistant chat no longer runs on.
   */
  readonly suppressThreadError: boolean;
}

/**
 * The chat's harness and whether it lost its sign-in. The assistant chat is
 * pinned to Hermes: a stale session or selection from another harness (the
 * Codex a chat ran on before 0.0.84) is ignored.
 */
export function resolveThreadHarnessAuthLoss(input: {
  readonly thread: HarnessAuthLossThread;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  /** Snapshot a non-assistant chat runs on, as the chat already resolved it. */
  readonly activeProviderStatus: ServerProvider | null;
}): ThreadHarnessAuthLoss {
  const { thread } = input;
  if (isAssistantConversation(thread)) {
    const providerStatus =
      input.providerStatuses.find(
        (status) => status.instanceId === ASSISTANT_HARNESS_INSTANCE_ID,
      ) ?? null;
    // Only errors of a Hermes session belong to the assistant; a Codex
    // session's leftovers must not read as "signed out of Codex".
    const hermesSession =
      thread.session !== null &&
      (thread.session.providerInstanceId ?? thread.session.provider) ===
        ASSISTANT_HARNESS_INSTANCE_ID;
    const detected = detectHarnessAuthLoss({
      driver: "hermes",
      providerStatus,
      threadError: hermesSession || thread.session === null ? thread.error : null,
      sessionLastError: hermesSession ? liveSessionError(thread) : null,
      sessionLastErrorClass: thread.session?.lastErrorClass ?? null,
      assistantLlmProvider: readAssistantLlmProvider(
        coerceAssistantModelSelection(thread.modelSelection as ModelSelection),
      ),
      isCustom: false,
    });
    // "No Uno AI key yet" / "Hermes not installed" are the engine banner's
    // (AssistantEngine) — the card is for a turn that failed on sign-in, so
    // a machine that never had a key doesn't hear "you were signed out".
    const errorLoss = detected?.source === "error" ? detected : null;
    const staleSessionDriver = !hermesSession && thread.session ? thread.session.provider : null;
    const staleAuthError =
      staleSessionDriver !== null &&
      [thread.error, thread.session?.lastError].some((text) =>
        isAuthLossErrorText(staleSessionDriver, text),
      );
    return {
      isAssistant: true,
      providerStatus,
      loss: errorLoss,
      suppressThreadError: errorLoss !== null || staleAuthError,
    };
  }
  const providerStatus = input.activeProviderStatus;
  const driver = providerStatus?.driver ?? thread.session?.provider ?? null;
  const loss = detectHarnessAuthLoss({
    driver,
    providerStatus,
    threadError: thread.error,
    sessionLastError: liveSessionError(thread),
    lastReply: lastShortReply(thread),
    sessionLastErrorClass: thread.session?.lastErrorClass ?? null,
    isCustom: driver === CUSTOM_HARNESS_DRIVER_KIND,
  });
  return {
    isAssistant: false,
    providerStatus,
    loss,
    suppressThreadError: loss?.source === "error",
  };
}
