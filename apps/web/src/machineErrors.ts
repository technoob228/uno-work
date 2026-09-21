/**
 * Machine errors in a person's words.
 *
 * Connecting, waking and creating machines crosses three systems (the daemon
 * serving this page, the Uno control plane, the box's own daemon), and each of
 * them fails in its own dialect: `409: {"error":"NETWORK_NOT_READY: …"}`,
 * `Failed to fetch remote auth endpoint https://…`, a timeout. None of that is
 * something a person should have to read. `describeMachineError` turns any of
 * them into a title, one plain sentence and what to do — and keeps the raw
 * text as `details`, which the UI shows only under "Show details".
 *
 * Pure, so every rule is unit-tested with the strings production really sent.
 *
 * @module machineErrors
 */
import {
  isRemoteEnvironmentAuthHttpError,
  isRemoteEnvironmentUnreachableError,
} from "./environments/remote/api";

export interface HumanMachineError {
  readonly title: string;
  readonly message: string;
  /** Raw text for "Show details". Null when it would repeat the message. */
  readonly details: string | null;
  /**
   * The machine is probably just starting or waking: trying again later is the
   * right move, and the UI should say "we'll keep trying" rather than "failed".
   */
  readonly transient: boolean;
}

function rawText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

interface Rule {
  readonly test: RegExp;
  readonly title: string;
  readonly message: string;
  readonly transient: boolean;
}

/**
 * First match wins, so specific control-plane codes come before the generic
 * network shapes they are usually wrapped in.
 */
const RULES: ReadonlyArray<Rule> = [
  {
    test: /connect your uno account first|no api key|not linked/i,
    title: "Uno account not connected",
    message:
      "This app isn't linked to your Uno account yet, so it can't see or create computers. Link it in Settings → Machine → Account.",
    transient: false,
  },
  {
    test: /\b401\b|unauthori[sz]ed|invalid api key|forbidden|\b403\b/i,
    title: "Uno didn't accept this account",
    message:
      "Your Uno account key was refused. Check it in Settings → Machine → Account, or copy a fresh one from the Uno console.",
    transient: false,
  },
  {
    test: /insufficient|not enough (balance|funds)|\b402\b|payment required|no active (plan|subscription)/i,
    title: "Not enough balance",
    message: "Your Uno balance or plan doesn't cover this computer. Top up in the Uno console.",
    transient: false,
  },
  {
    test: /NO_NODE_CAPACITY|no capacity|out of capacity/i,
    title: "No free capacity right now",
    message:
      "Uno has no free room for a new computer at the moment. Nothing was created or charged. Try again in a few minutes.",
    transient: false,
  },
  {
    test: /install\.sh|daemon is not installed|not installed on it|daemonInstallRequired/i,
    title: "Uno Work isn't installed there",
    message:
      "This computer doesn't have Uno Work on it yet, so it can't be connected with one click.",
    transient: false,
  },
  {
    test: /entered status "(error|failed)"|status[":\s]+(error|failed)\b|image artifact unavailable|provision(ing)? failed/i,
    title: "This computer is broken",
    message:
      "Uno reports this computer as broken, so it can't start. You can delete it in the Uno console and create a new one.",
    transient: false,
  },
  {
    test: /NETWORK_NOT_READY|not published yet|no published hostname|hostname is not published/i,
    title: "Still getting an address",
    message:
      "The computer is up but doesn't have its web address yet. This usually takes under a minute.",
    transient: true,
  },
  {
    test: /sleeping|asleep|is stopped|box is not running|not running/i,
    title: "The computer is asleep",
    message: "It needs to wake up before it can be connected.",
    transient: true,
  },
  {
    test: /did not answer within|taking longer than expected|did not reach "running"/i,
    title: "Still starting",
    message: "The computer is taking longer than usual to start. It may still come up.",
    transient: true,
  },
  {
    // 500 on a pairing request usually means the daemon inside the box is not
    // up yet (the control plane runs `auth pairing create` in the box and it
    // fails); 502–504 come from an edge in front of a machine that is starting.
    test: /\b50[0234]\b|bad gateway|gateway time-?out|service unavailable|internal[_ ]error/i,
    title: "The computer isn't answering yet",
    message: "It's probably still starting or waking up.",
    transient: true,
  },
  {
    test: /failed to fetch|networkerror|network error|load failed|no answer from|timed? ?out|ECONNREFUSED|ECONNRESET|ENOTFOUND/i,
    title: "The computer isn't answering yet",
    message: "It's probably still starting or waking up.",
    transient: true,
  },
];

export function describeMachineError(error: unknown): HumanMachineError {
  const raw = rawText(error).trim();
  if (isRemoteEnvironmentUnreachableError(error)) {
    return {
      title: "The computer isn't answering yet",
      message: "It's probably still starting or waking up.",
      details: raw || null,
      transient: true,
    };
  }
  // The box's own daemon refused the one-time link (expired or already used):
  // not the Uno account's fault, and a fresh link fixes it.
  if (isRemoteEnvironmentAuthHttpError(error) && (error.status === 401 || error.status === 403)) {
    return {
      title: "The sign-in link expired",
      message:
        "The one-time link to this computer ran out before it was used. Try again for a fresh one.",
      details: raw || null,
      transient: false,
    };
  }
  for (const rule of RULES) {
    if (rule.test.test(raw)) {
      return {
        title: rule.title,
        message: rule.message,
        details: raw.length > 0 ? raw : null,
        transient: rule.transient,
      };
    }
  }
  return {
    title: "Something went wrong",
    message: "The computer couldn't be reached. Try again in a moment.",
    details: raw.length > 0 ? raw : null,
    transient: false,
  };
}

/**
 * Raw control-plane notes that are fine to show as-is are rare; anything that
 * looks like a status code or JSON goes through `describeMachineError`.
 */
export function looksTechnical(text: string): boolean {
  return /[{}[\]]|^\s*\d{3}\b|https?:\/\/|Error\b|_[A-Z]{2,}|[A-Z]{3,}_[A-Z]/.test(text);
}
