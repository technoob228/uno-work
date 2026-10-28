/**
 * "Sign in, or use Uno credits?" — asked once per harness on a machine.
 *
 * Claude Code with no sign-in of its own runs on the Uno gateway with the
 * machine's key (the daemon reports `auth.type` "unoAi"), paid from the
 * account's premium credit and then its balance. Until 28.10 it did so
 * without a word: people paid without knowing, and didn't know they could
 * use their own Claude subscription. Now the composer asks first and nothing
 * is sent until the person picks; the daemon refuses such turns from any
 * other source too (ClaudeDriver `makeUnoCreditsGuard`), with a text that
 * this module recognises.
 *
 * Codex and Cursor never run on Uno credits (no gateway mode): a missing
 * sign-in there is the usual "Sign in to …" card. OpenCode, Uno Code and
 * Hermes are Uno AI by choice — credits are what they run on.
 *
 * Pure, so the rules are unit-tested without React (unoCreditsChoice.logic.test.ts).
 */
import {
  isUnoCreditsChoiceRequiredText,
  UNO_SMART_MODEL_SLUG,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  type UnoAiPremiumStatus,
} from "@t3tools/contracts";

import { runsOnUnoAi } from "../harness/harnessSetupState";
import {
  UNO_PREMIUM_ADD_CREDIT_LABEL,
  UNO_PREMIUM_BILLING_URL,
  UNO_PREMIUM_CONTINUE_LABEL,
} from "./PremiumCreditNotice";

/** Harnesses that fall back to Uno credits without a sign-in, as people know them. */
export const UNO_CREDITS_HARNESS_LABELS: Readonly<Record<string, string>> = {
  claudeAgent: "Claude Code",
};

export function unoCreditsHarnessLabel(driver: string): string | null {
  return UNO_CREDITS_HARNESS_LABELS[driver] ?? null;
}

/** The person allowed this harness to run on Uno credits on this machine. */
export function unoCreditsAllowed(
  settings: Pick<ServerSettings, "harnessUnoCredits"> | null | undefined,
  driver: string,
): boolean {
  return settings?.harnessUnoCredits?.[driver] === true;
}

/**
 * The choice has to be made before this harness sends anything: it has no
 * sign-in of its own here, would run on Uno credits, and the person hasn't
 * allowed that. Seen in the daemon's snapshot (`auth.type` "unoAi") or, when
 * the snapshot couldn't tell, in the daemon's refusal of the last turn.
 */
export function unoCreditsChoiceNeeded(input: {
  readonly provider: ServerProvider | null | undefined;
  readonly settings: Pick<ServerSettings, "harnessUnoCredits"> | null | undefined;
  /** The chat's last error (thread error / session error), if any. */
  readonly lastError?: string | null | undefined;
}): boolean {
  const { provider } = input;
  if (!provider || unoCreditsHarnessLabel(provider.driver) === null) return false;
  if (unoCreditsAllowed(input.settings, provider.driver)) return false;
  if (runsOnUnoAi(provider)) return true;
  // Refused by the daemon, and not signed in with an own account since.
  const signedInOwn = provider.auth.status === "authenticated" && provider.auth.type !== "unoAi";
  return !signedInOwn && isUnoCreditsChoiceRequiredText(input.lastError);
}

export type UnoCreditsAction =
  | { readonly kind: "useCredits"; readonly label: string }
  | { readonly kind: "billing"; readonly label: string; readonly url: string };

export interface UnoCreditsChoiceCopy {
  readonly title: string;
  readonly body: string;
  readonly signInLabel: string;
  readonly creditsAction: UnoCreditsAction;
  /** Under the buttons; null when there is nothing to add. */
  readonly note: string | null;
  /** "Use Uno AI · Smart instead" when there's no credit; null otherwise. */
  readonly smartLabel: string | null;
}

export const UNO_CREDITS_COPY = {
  title: (label: string) => `You're not signed in to ${label}`,
  body: (label: string, accountName: string) =>
    `Sign in with your ${accountName} account, or use credits from your Uno account to run ${label} here.`,
  bodyNoCredit: (label: string, accountName: string) =>
    `Sign in with your ${accountName} account, or add credit to your Uno account to run ${label} here.`,
  signIn: "Sign in",
  useCredits: "Use Uno credits",
  creditsNote: "Premium credit first, then your balance. You can change this in Settings.",
  queuedNote: "Your message is waiting. It will be sent once you choose.",
  smart: "Use Uno AI · Smart instead",
  smartNote: "Or pick Uno AI · Smart in the model menu: it's included in your plan.",
} as const;

/** Whose account the harness signs in with. */
const ACCOUNT_NAMES: Readonly<Record<string, string>> = {
  claudeAgent: "Claude",
};

/**
 * What the choice says. No premium credit left (and "Continue from balance"
 * off): Uno credits can't run it, so the way on is the billing page — or
 * Smart, which the plan includes.
 */
export function unoCreditsChoiceCopy(input: {
  readonly driver: string;
  readonly premium: UnoAiPremiumStatus | null | undefined;
  readonly canSwitchToSmart: boolean;
  readonly queued: boolean;
}): UnoCreditsChoiceCopy {
  const label = unoCreditsHarnessLabel(input.driver) ?? input.driver;
  const accountName = ACCOUNT_NAMES[input.driver] ?? label;
  const noCredit = input.premium?.exhausted === true;
  if (noCredit) {
    const hasMoney = (input.premium?.balanceUsd ?? 0) >= 0.01;
    return {
      title: UNO_CREDITS_COPY.title(label),
      body: UNO_CREDITS_COPY.bodyNoCredit(label, accountName),
      signInLabel: UNO_CREDITS_COPY.signIn,
      creditsAction: {
        kind: "billing",
        label: hasMoney ? UNO_PREMIUM_CONTINUE_LABEL : UNO_PREMIUM_ADD_CREDIT_LABEL,
        url: UNO_PREMIUM_BILLING_URL,
      },
      note: input.queued
        ? UNO_CREDITS_COPY.queuedNote
        : input.canSwitchToSmart
          ? null
          : UNO_CREDITS_COPY.smartNote,
      smartLabel: input.canSwitchToSmart ? UNO_CREDITS_COPY.smart : null,
    };
  }
  return {
    title: UNO_CREDITS_COPY.title(label),
    body: UNO_CREDITS_COPY.body(label, accountName),
    signInLabel: UNO_CREDITS_COPY.signIn,
    creditsAction: { kind: "useCredits", label: UNO_CREDITS_COPY.useCredits },
    note: input.queued ? UNO_CREDITS_COPY.queuedNote : UNO_CREDITS_COPY.creditsNote,
    smartLabel: null,
  };
}

/**
 * Uno AI · Smart on Uno Code, when this computer has it ready: the way on
 * with no premium credit (Smart is in the plan). Null otherwise.
 */
export function unoSmartTarget(
  providers: ReadonlyArray<ServerProvider>,
): { readonly instanceId: ProviderInstanceId; readonly model: string } | null {
  const uno = providers.find(
    (provider) =>
      provider.driver === "uno" &&
      provider.enabled &&
      provider.installed &&
      provider.status === "ready" &&
      provider.models.some((model) => model.slug === UNO_SMART_MODEL_SLUG),
  );
  return uno ? { instanceId: uno.instanceId, model: UNO_SMART_MODEL_SLUG } : null;
}
