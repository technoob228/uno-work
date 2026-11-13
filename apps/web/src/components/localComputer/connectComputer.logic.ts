/**
 * "Connect my computer", the part without React: which system the browser is
 * on, how far a pairing got, what a failed install means and what to do next,
 * how a computer's status and journal read.
 *
 * The next step is worked out here, on this side, from words the install
 * script, the helper or the person's terminal printed. No agent reads them:
 * what isn't recognized gets an honest "Uno can't tell" and the same command.
 *
 * Pure part only.
 */
import type {
  MyComputer,
  MyComputerActivityEntry,
  MyComputerPairCommands,
  MyComputerPairStatus,
} from "@t3tools/contracts";

import { formatElapsedAgoLabel } from "../../timestampFormat";

export type LocalOs = keyof MyComputerPairCommands;

export const LOCAL_OS_ORDER: ReadonlyArray<LocalOs> = ["mac", "windows", "linux"];

export const LOCAL_OS: Readonly<
  Record<
    LocalOs,
    {
      readonly label: string;
      readonly terminal: string;
      readonly howTo: ReadonlyArray<string>;
    }
  >
> = {
  mac: {
    label: "macOS",
    terminal: "Terminal",
    howTo: [
      "Press ⌘ Space, type Terminal, press Return.",
      "Or open Finder, then Applications, Utilities, Terminal.",
    ],
  },
  windows: {
    label: "Windows",
    terminal: "PowerShell",
    howTo: [
      "On Windows 10 or 11, click Start, type PowerShell, press Enter.",
      "Use PowerShell, not Command Prompt, and not as administrator.",
    ],
  },
  linux: {
    label: "Linux",
    terminal: "Terminal",
    howTo: ["Press Ctrl + Alt + T.", "Nothing opened? Open your app menu and search for Terminal."],
  },
};

// ── The browser's system ───────────────────────────────────────────────

export interface BrowserClues {
  readonly userAgent: string;
  /** `navigator.userAgentData.platform`, where the browser has it. */
  readonly uaPlatform?: string | undefined;
  readonly maxTouchPoints?: number | undefined;
}

export interface BrowserSystem {
  readonly os: LocalOs;
  /** A phone or tablet: the command has to run on another computer. */
  readonly phone: boolean;
}

/** Android says Linux and iOS says Mac OS X, so phones go first. iPadOS says Macintosh. */
export function detectSystem(clues: BrowserClues): BrowserSystem {
  const hint = `${clues.uaPlatform ?? ""} ${clues.userAgent}`;
  const ipad = /macintosh/i.test(clues.userAgent) && (clues.maxTouchPoints ?? 0) > 1;
  if (ipad || /android|iphone|ipad|ipod/i.test(hint)) return { os: "mac", phone: true };
  if (/windows|win32|win64/i.test(hint)) return { os: "windows", phone: false };
  if (/macos|mac os|macintosh/i.test(hint)) return { os: "mac", phone: false };
  if (/linux|x11|cros|chrome os/i.test(hint)) return { os: "linux", phone: false };
  return { os: "mac", phone: false };
}

// ── How far the pairing got ────────────────────────────────────────────

export type PairProgress =
  | { readonly kind: "waiting" }
  /** The code is taken, the helper is still coming up. */
  | { readonly kind: "finishing" }
  | { readonly kind: "connected"; readonly computerId: string }
  | { readonly kind: "expired" }
  | {
      readonly kind: "failed";
      readonly step: string | null;
      readonly message: string | null;
      /** The same command can still work: the code is alive and not taken. */
      readonly codeUsable: boolean;
    };

/**
 * `claimed` only says the code was taken: the helper still has to install and
 * come online, and can fail after that. So "connected" is the computer itself
 * online, whatever the pairing says (a helper that reported `failed` keeps
 * trying and may get through).
 *
 * A failure outranks `claimed` and `expired` on the console, so the code's age
 * is checked here. For `waiting` the console's clock decides, not this one: a
 * wrong clock on the person's computer mustn't expire a good code.
 */
export function pairProgress(input: {
  readonly status: MyComputerPairStatus | null | undefined;
  readonly computers: ReadonlyArray<Pick<MyComputer, "id" | "online">>;
  readonly expiresAt: string;
  readonly nowMs: number;
}): PairProgress {
  const { status } = input;
  if (!status) return { kind: "waiting" };
  const { computerId } = status;
  if (computerId && input.computers.some((one) => one.id === computerId && one.online)) {
    return { kind: "connected", computerId };
  }
  switch (status.state) {
    case "claimed":
      return { kind: "finishing" };
    case "failed":
      return {
        kind: "failed",
        step: status.step,
        message: status.message,
        codeUsable: computerId === null && input.nowMs < Date.parse(input.expiresAt),
      };
    case "expired":
      return { kind: "expired" };
    default:
      return { kind: "waiting" };
  }
}

// ── What went wrong, what to do next ───────────────────────────────────

export type InstallFixId =
  | "smart-app-control"
  | "defender"
  | "wrong-window"
  | "organization-policy"
  | "execution-policy"
  | "no-curl"
  | "as-admin"
  | "code-used"
  | "cant-connect"
  | "no-network"
  | "not-linked"
  | "unsupported"
  | "damaged"
  | "unknown";

export interface InstallFix {
  readonly id: InstallFixId;
  readonly tone: "help" | "warning";
  readonly title: string;
  readonly body: string;
  /** Numbered steps, when one sentence isn't enough. */
  readonly steps: ReadonlyArray<string>;
  /** What to paste next. */
  readonly command: string | null;
  /**
   * `run`: paste the command, the dialog keeps watching. `new-code`: this code
   * is spent. `wait`: the helper is on it. `stop`: nothing to do on this computer.
   */
  readonly next: "run" | "new-code" | "wait" | "stop";
  /** The computer's own words say more than the title does. */
  readonly showMessage: boolean;
}

const CODE_USED_FIX = {
  id: "code-used",
  tone: "help",
  title: "This command no longer works",
  body: "It expired or was already used.",
  steps: [],
  command: null,
  next: "new-code",
  showMessage: false,
} as const satisfies InstallFix;

const PASTE_AGAIN = "Paste the command again.";
const STOPPED_TWICE =
  "Paste the command again in a new window. If it stops at the same place, ask Uno in a chat and paste this text.";

const SMART_APP_CONTROL = /smart app control|application control policy/i;
const ANTIVIRUS =
  /virus|malware|malicious|potentially unwanted|(windows|microsoft) (defender|security)|\bthreat\b|вирус|вредоносн/i;
const COMMAND_PROMPT =
  /is not recognized as an internal or external command|не является внутренней или внешней/i;
const ORGANIZATION_POLICY =
  /group policy|more specific scope|language mode|групповой политик|режиме языка/i;
/**
 * `Get-FileHash` lives in a script module on Windows PowerShell 5.1: under the
 * default policy of Windows 10 and 11 it looks like a missing command.
 */
const EXECUTION_POLICY =
  /running scripts is disabled|execution ?polic|cannot be loaded because|PSSecurityException|Get-FileHash[^\n]*not recognized|not recognized[^\n]*Get-FileHash|выполнение сценариев отключено/i;
/** Every shell's "no such command", but not curl's own `404 Not Found`. */
const NO_CURL =
  /\b(curl|wget):\s*(command\s+)?not found|command not found:\s*(curl|wget)\b|neither curl nor wget|(curl|wget): команда не найдена/i;
const RUN_AS_ADMIN = /as root|with sudo|as administrator/i;
const CODE_USED = /expired or was already used/i;
const NO_NETWORK =
  /could(n't| not) resolve|name or service not known|name resolution|no such host|remote name could not be resolved|unable to connect to the remote server|failed to connect|could not reach uno|connection (timed out|refused|reset)|underlying connection was closed|network is unreachable|timed out|check your internet|\bssl\b|\btls\b|certificate|trust relationship|не удается соединиться|не удалось разрешить/i;

/**
 * `text` is the helper's report or what the person pasted. Words are checked
 * before the step: Windows Security stops the helper at `start`, and only the
 * message tells that from a helper that crashed.
 */
export function diagnoseInstall(input: {
  readonly text: string;
  readonly step: string | null;
  readonly os: LocalOs;
  readonly commands: MyComputerPairCommands;
  readonly codeUsable: boolean;
}): InstallFix {
  const { text, step, os, commands, codeUsable } = input;
  const plain = { tone: "help", steps: [], showMessage: false } as const;
  type Words = Pick<InstallFix, "id" | "title" | "body"> & Partial<InstallFix>;
  const runAgain = (fix: Words): InstallFix => ({
    ...plain,
    ...fix,
    next: codeUsable ? "run" : "new-code",
    command: codeUsable ? (fix.command ?? commands[os]) : null,
  });
  const stop = (fix: Words): InstallFix => ({ ...plain, ...fix, next: "stop", command: null });

  if (step === "connect") {
    return {
      ...plain,
      id: "cant-connect",
      title: "Installed, but can’t reach Uno yet",
      body: "The helper keeps trying by itself. Check the internet or VPN on that computer.",
      next: "wait",
      command: null,
    };
  }
  if (SMART_APP_CONTROL.test(text)) {
    return stop({
      id: "smart-app-control",
      tone: "warning",
      title: "Windows blocked Uno",
      body: "Smart App Control stopped the helper, and Uno can’t work around it on this computer. You can still upload files to a chat.",
    });
  }
  if (ANTIVIRUS.test(text)) {
    return runAgain({
      id: "defender",
      tone: "warning",
      title: "Windows Security stopped Uno",
      body: "It flagged the helper. You can bring it back:",
      steps: [
        "Open Windows Security, then Protection history.",
        "Find uno-connect and choose Restore.",
        PASTE_AGAIN,
      ],
    });
  }
  if (COMMAND_PROMPT.test(text)) {
    return runAgain({
      id: "wrong-window",
      title: "You opened Command Prompt",
      body: "Paste this one instead. It works there.",
      command: `powershell -c "${commands.windows.replaceAll('"', "'")}"`,
    });
  }
  if (ORGANIZATION_POLICY.test(text)) {
    return stop({
      id: "organization-policy",
      tone: "warning",
      title: "This computer’s rules block the install",
      body: "Your organization controls what can run here. Ask your IT admin, or connect another computer.",
    });
  }
  if (EXECUTION_POLICY.test(text)) {
    return runAgain({
      id: "execution-policy",
      title: "PowerShell blocked the script",
      body: "Paste this one instead. The change applies to this window only.",
      command: `Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned -Force; ${commands.windows}`,
    });
  }
  if (NO_CURL.test(text)) {
    return runAgain(
      os === "linux"
        ? {
            id: "no-curl",
            title: "This computer can’t download yet",
            body: "Paste this. It installs curl and connects, and asks for your password. On Fedora, use dnf instead of apt.",
            command: `sudo apt install -y curl && ${commands.linux}`,
          }
        : {
            id: "no-curl",
            title: "This computer can’t download yet",
            body: "Install curl, then paste the command again.",
          },
    );
  }
  if (step === "root" || RUN_AS_ADMIN.test(text)) {
    return runAgain({
      id: "as-admin",
      title: os === "windows" ? "Don’t run it as administrator" : "Don’t run it with sudo",
      body:
        os === "windows"
          ? "Open a normal PowerShell window and paste the command there."
          : "Paste the command as your normal user, without sudo.",
    });
  }
  if (CODE_USED.test(text)) {
    return CODE_USED_FIX;
  }
  if (step === "os" || step === "arch") {
    return stop({
      id: "unsupported",
      tone: "warning",
      title: "This computer isn’t supported yet",
      body: "The helper can’t run here.",
      showMessage: true,
    });
  }
  if (step === "download" || NO_NETWORK.test(text)) {
    return runAgain({
      id: "no-network",
      title: "This computer can’t reach Uno",
      body: "Check the internet connection. Try without a VPN or company proxy, then paste the command again.",
    });
  }
  if (step === "claim") {
    return runAgain({
      id: "not-linked",
      title: "Uno couldn’t link this computer",
      body: "Wait a minute, then paste the command again.",
      showMessage: true,
    });
  }
  if (step === "checksum") {
    return runAgain({
      id: "damaged",
      title: "The download didn’t pass its check",
      body: PASTE_AGAIN,
      showMessage: true,
    });
  }
  return runAgain({
    id: "unknown",
    title: "Uno can’t tell what went wrong",
    body: STOPPED_TWICE,
    showMessage: true,
  });
}

const STEP_LABELS: Readonly<Record<string, string>> = {
  root: "Checking the user",
  home: "Finding your home folder",
  tools: "Checking curl",
  os: "Checking the system",
  arch: "Checking the processor",
  prepare: "Preparing the folder",
  download: "Downloading the helper",
  checksum: "Checking the download",
  install: "Installing the helper",
  start: "Starting the helper",
  claim: "Linking to your account",
  connect: "Connecting to Uno",
};

const STEP_MAX_CHARS = 60;

/** The install step in plain words. A step Uno doesn't know is the computer's own text. */
export function stepLabel(step: string): string {
  return STEP_LABELS[step] ?? step.slice(0, STEP_MAX_CHARS);
}

// ── Status and journal ─────────────────────────────────────────────────

/** "Connected", "Offline · last seen 2h ago". */
export function computerStatusLine(
  computer: Pick<MyComputer, "online" | "lastSeenAt">,
  nowMs: number,
): string {
  if (computer.online) return "Connected";
  if (computer.lastSeenAt === null || Number.isNaN(Date.parse(computer.lastSeenAt))) {
    return "Offline";
  }
  return `Offline · last seen ${formatElapsedAgoLabel(computer.lastSeenAt, nowMs)}`;
}

export function disconnectNote(computer: Pick<MyComputer, "online">): string {
  return computer.online
    ? "Agents lose access now, and the helper removes itself from this computer."
    : "Agents lose access now. The helper removes itself when this computer is next online.";
}

const ACTIVITY_VERB: Readonly<Record<MyComputerActivityEntry["kind"], string>> = {
  run: "Ran",
  read: "Read",
  write: "Wrote",
  list: "Listed",
};

export function activityLine(
  entry: Pick<MyComputerActivityEntry, "kind" | "summary" | "outcome">,
): string {
  // Refused by policy: it never ran.
  if (entry.outcome === "refused") return `Not run: ${entry.summary}`;
  return `${ACTIVITY_VERB[entry.kind]} ${entry.summary}`;
}

/** The time for today's lines, the date for older ones. */
export function activityTimeLabel(
  at: string,
  nowMs: number,
  formatTime: (iso: string) => string,
): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toDateString() === new Date(nowMs).toDateString()
    ? formatTime(at)
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
