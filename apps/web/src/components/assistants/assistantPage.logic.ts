/**
 * The parts of an assistant's page that are plain decisions (22.10, Misha:
 * "role, tasks, access, name, connectors, its own mail, its computer — all
 * at once, very simple"): its standing duties as an edited list, its mail
 * rules as the page's choices, and where it can work with the honest
 * consequence of each place in one line.
 *
 * Pure: no React, no I/O.
 */
import {
  ASSISTANT_DUTIES_MAX,
  ASSISTANT_DUTY_MAX_CHARS,
  type AssistantMailPolicy,
  type AssistantWorksOnWish,
} from "@t3tools/contracts";
import { normalizeMailAddress } from "@t3tools/shared/assistantMail";

// ── Duties ────────────────────────────────────────────────────────────────

function cleanDuty(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, ASSISTANT_DUTY_MAX_CHARS);
}

/** The list after one edit: `index` null adds, an empty text removes. Duplicates collapse. */
export function editDuties(
  duties: ReadonlyArray<string>,
  index: number | null,
  text: string,
): ReadonlyArray<string> {
  const line = cleanDuty(text);
  const next =
    index === null ? [...duties, line] : duties.map((duty, at) => (at === index ? line : duty));
  const out: string[] = [];
  for (const duty of next) {
    if (duty.length > 0 && !out.some((kept) => kept.toLowerCase() === duty.toLowerCase())) {
      out.push(duty);
    }
  }
  return out.slice(0, ASSISTANT_DUTIES_MAX);
}

export const DUTY_EXAMPLES = [
  "Watch CI on my main project",
  "Morning plan at 9",
  "Answer support mail within a day",
] as const;

// ── Mail ──────────────────────────────────────────────────────────────────

export const MAIL_RECIPIENT_CHOICES: ReadonlyArray<{
  readonly id: AssistantMailPolicy["recipients"];
  readonly label: string;
}> = [
  { id: "anyone", label: "Anyone" },
  { id: "owner", label: "Only you" },
  { id: "list", label: "These addresses" },
];

/** Addresses typed into the field ("a@b.co, c@d.co"): the valid ones and what wasn't one. */
export function parseAddresses(raw: string): {
  readonly addresses: ReadonlyArray<string>;
  readonly invalid: ReadonlyArray<string>;
} {
  const addresses: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    if (part.length === 0) continue;
    const address = normalizeMailAddress(part);
    if (address === null) invalid.push(part);
    else if (!addresses.includes(address)) addresses.push(address);
  }
  return { addresses, invalid };
}

/** The daily limit from its field: a whole number 0–50, or null when it isn't one. */
export function parseDailyLimit(raw: string, max: number): number | null {
  if (!/^\d{1,3}$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value >= 0 && value <= max ? value : null;
}

// ── Where it works ────────────────────────────────────────────────────────

export interface WorksOnMachine {
  readonly environmentId: string | null;
  /** The console's computer (box) id, when this machine is one. */
  readonly boxId?: number | null;
  /** The console's name for it — wins over the daemon's label. */
  readonly boxName?: string | null;
  readonly label: string;
  /** `computer`: a laptop or desktop; the others are cloud computers. */
  readonly kind: string;
  readonly status: string;
}

export type WorksOnOption =
  | {
      readonly kind: "here";
      readonly label: string;
      readonly line: string;
    }
  | {
      readonly kind: "cloud";
      readonly label: string;
      readonly line: string;
      readonly environmentId: string | null;
      /** Why it can't be chosen now, or null. */
      readonly blocked: string | null;
    }
  | {
      readonly kind: "own";
      readonly label: string;
      readonly line: string;
    };

/** One line each: what working there means for the person. */
export const WORKS_ON_LINE = {
  laptop: "Stops when the laptop sleeps or closes; routines need a cloud computer.",
  cloudHere: "Always on — routines and Telegram answers work while you're away.",
  cloud: "Always on. Your projects arrive there by sync; its chats here stay here.",
  own: "Lite, from your plan's quota, at most $5/mo, sleeps when idle. Your files stay out of its reach.",
} as const;

/**
 * Where an assistant can work: where it is now, the person's other cloud
 * computers (one the app isn't connected to yet can't take it), a new
 * computer of its own. Uno is its computer's own assistant: only "here".
 */
export function worksOnOptions(input: {
  readonly isUno: boolean;
  readonly hereEnvironmentId: string;
  /** The name the page shows for where it is (wins over the machine row's). */
  readonly hereLabel?: string | null;
  readonly machines: ReadonlyArray<WorksOnMachine>;
}): ReadonlyArray<WorksOnOption> {
  const here = input.machines.find((machine) => machine.environmentId === input.hereEnvironmentId);
  const hereBoxId = here?.boxId ?? null;
  // The computer it is on is matched by ids, never by name: two computers can
  // share a name, and one computer can show up as two rows (its connection
  // and its box on the account).
  const isHere = (machine: WorksOnMachine) =>
    machine.environmentId === input.hereEnvironmentId ||
    (hereBoxId !== null && machine.boxId === hereBoxId);
  const hereIsLaptop = here === undefined || here.kind === "computer";
  const options: WorksOnOption[] = [
    {
      kind: "here",
      label: input.hereLabel || here?.label || "This computer",
      line: hereIsLaptop ? WORKS_ON_LINE.laptop : WORKS_ON_LINE.cloudHere,
    },
  ];
  if (input.isUno) return options;
  for (const machine of input.machines) {
    if (machine.kind === "computer" || isHere(machine)) continue;
    options.push({
      kind: "cloud",
      label: machine.boxName?.trim() || machine.label,
      line: WORKS_ON_LINE.cloud,
      environmentId: machine.environmentId,
      blocked:
        machine.environmentId === null
          ? "Open it in Uno Work once, then assistants can move there."
          : machine.status === "online"
            ? null
            : "It's asleep — wake it first.",
    });
  }
  options.push({ kind: "own", label: "A new computer of its own", line: WORKS_ON_LINE.own });
  return options;
}

/** What the person said in its setup, as the page's words. */
export function worksOnWishLine(wish: AssistantWorksOnWish | null): string | null {
  switch (wish) {
    case "cloud":
      return "In its setup you said: one of your cloud computers.";
    case "own":
      return "In its setup you said: a computer of its own.";
    default:
      return null;
  }
}
