/**
 * "Set up your computer" — the guided setup after the welcome screen.
 *
 * Two ways through it, picked on the welcome screen:
 * - just a computer: a three-stop tour (Home, Files, App Store) and done;
 * - a computer with AI: eight steps, each one skippable, each doing the real
 *   thing (default AI, project, AGENTS.md, skills, tools, channels, material).
 *
 * This module is the pure part: step order, copy, the AGENTS.md it writes,
 * progress arithmetic. Progress itself lives on the machine
 * (`settings.setup`, see `UnoSetupProgress`).
 */
import type { UnoSetupProgress, UnoSetupProject } from "@t3tools/contracts";

export const SETUP_STEPS = [
  "ai",
  "project",
  "instructions",
  "skills",
  "connectors",
  "channels",
  "materials",
  "done",
] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];

export const SETUP_STEP_LABEL: Readonly<Record<SetupStepId, string>> = {
  ai: "AI",
  project: "Project",
  instructions: "Instructions",
  skills: "Skills",
  connectors: "Connectors",
  channels: "Channels",
  materials: "Material",
  done: "Done",
};

export const TOUR_STEPS = ["home", "files", "apps"] as const;
export type TourStepId = (typeof TOUR_STEPS)[number];

/**
 * `/setup?step=` values: the welcome screen (two ways to use the computer),
 * the eight steps, and the tour's closing screen.
 */
export type SetupRouteStep = SetupStepId | "welcome" | "tour-done";

export function parseSetupRouteStep(value: unknown): SetupRouteStep | null {
  if (value === "tour-done" || value === "welcome") return value;
  return typeof value === "string" && (SETUP_STEPS as ReadonlyArray<string>).includes(value)
    ? (value as SetupStepId)
    : null;
}

export function parseTourStep(value: unknown): TourStepId | null {
  return typeof value === "string" && (TOUR_STEPS as ReadonlyArray<string>).includes(value)
    ? (value as TourStepId)
    : null;
}

export const EMPTY_SETUP_PROGRESS: UnoSetupProgress = {
  mode: null,
  visited: [],
  skipped: [],
  finished: false,
  dismissed: false,
  project: null,
  answers: {},
};

export function nextStep(step: SetupStepId): SetupStepId | null {
  const index = SETUP_STEPS.indexOf(step);
  return SETUP_STEPS[index + 1] ?? null;
}

export function previousStep(step: SetupStepId): SetupStepId | null {
  const index = SETUP_STEPS.indexOf(step);
  return index > 0 ? (SETUP_STEPS[index - 1] ?? null) : null;
}

function withItem(list: ReadonlyArray<string>, item: string): ReadonlyArray<string> {
  return list.includes(item) ? list : [...list, item];
}

function withoutItem(list: ReadonlyArray<string>, item: string): ReadonlyArray<string> {
  return list.filter((entry) => entry !== item);
}

export function markVisited(progress: UnoSetupProgress, step: SetupStepId): UnoSetupProgress {
  if (progress.visited.includes(step)) return progress;
  return { ...progress, visited: withItem(progress.visited, step) };
}

/** Continue on a step: it counts as done, not skipped. */
export function markCompleted(progress: UnoSetupProgress, step: SetupStepId): UnoSetupProgress {
  return {
    ...progress,
    visited: withItem(progress.visited, step),
    skipped: withoutItem(progress.skipped, step),
    finished: progress.finished || step === "done",
  };
}

export function markSkipped(progress: UnoSetupProgress, step: SetupStepId): UnoSetupProgress {
  return {
    ...progress,
    visited: withItem(progress.visited, step),
    skipped: withItem(progress.skipped, step),
  };
}

/** "Skip setup": every step not seen yet is skipped, and the setup is over. */
export function skipRemaining(progress: UnoSetupProgress): UnoSetupProgress {
  let next = progress;
  for (const step of SETUP_STEPS) {
    if (step === "done") continue;
    if (!next.visited.includes(step)) next = markSkipped(next, step);
  }
  return { ...next, finished: true };
}

export interface SetupSidebarState {
  /** Nothing to show: never started, the simple path, or all done. */
  readonly hidden: boolean;
  /** "Set up" while in progress, "Finish setup" once only skipped steps remain. */
  readonly label: "Set up" | "Finish setup";
  /** "3/8", "2 left" or "Tour". */
  readonly meta: string;
  /** 0..1 for the ring. */
  readonly ratio: number;
  /** Where the row goes. */
  readonly step: SetupRouteStep;
}

/** Where the person is right now, for the sidebar row (not saved). */
export interface SetupSidebarContext {
  /** The welcome screen is open. */
  readonly onWelcome?: boolean;
  /** The "just a computer" tour is running: the stop, or "done" on its last screen. */
  readonly tour?: TourStepId | "done" | null;
}

export function setupSidebarState(
  progress: UnoSetupProgress,
  context: SetupSidebarContext = {},
): SetupSidebarState {
  const total = SETUP_STEPS.length;
  if (context.tour) {
    const index = context.tour === "done" ? TOUR_STEPS.length : TOUR_STEPS.indexOf(context.tour);
    return {
      hidden: false,
      label: "Set up",
      meta: "Tour",
      ratio: Math.max(index, 0.5) / TOUR_STEPS.length,
      step: "tour-done",
    };
  }
  if (context.onWelcome && !progress.finished) {
    return { hidden: false, label: "Set up", meta: `0/${total}`, ratio: 0, step: "welcome" };
  }
  const skipped = SETUP_STEPS.filter((step) => progress.skipped.includes(step));
  const doneCount = SETUP_STEPS.filter(
    (step) => progress.visited.includes(step) && !progress.skipped.includes(step),
  ).length;
  const firstOpen =
    SETUP_STEPS.find((step) => !progress.visited.includes(step)) ?? skipped[0] ?? "done";
  if (progress.finished) {
    return {
      hidden: progress.mode !== "ai" || progress.dismissed || skipped.length === 0,
      label: "Finish setup",
      meta: `${skipped.length} left`,
      ratio: (total - skipped.length) / total,
      step: "done",
    };
  }
  return {
    hidden: progress.mode !== "ai" || progress.dismissed,
    label: "Set up",
    meta: `${doneCount}/${total}`,
    ratio: doneCount / total,
    step: firstOpen,
  };
}

// ── Project ──────────────────────────────────────────────────────────

export const WORK_KINDS = [
  { id: "site", label: "Website" },
  { id: "bot", label: "Bot" },
  { id: "data", label: "Data & reports" },
  { id: "docs", label: "Documents" },
  { id: "other", label: "Something else" },
] as const;
export type WorkKind = (typeof WORK_KINDS)[number]["id"];

export function parseWorkKind(value: string | null | undefined): WorkKind {
  return WORK_KINDS.some((kind) => kind.id === value) ? (value as WorkKind) : "other";
}

export function workKindLabel(kind: string | null | undefined): string {
  return WORK_KINDS.find((entry) => entry.id === kind)?.label ?? "Something else";
}

/** A folder name from a project name: lower-case, dashes, no surprises. */
export function projectSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "my-project"
  );
}

export function joinFolder(home: string, name: string): string {
  return `${home.replace(/\/+$/, "")}/${name}`;
}

/** `/home/unowork/acme` → `~/acme` for display. */
export function tildePath(path: string, home: string | null): string {
  if (!home) return path;
  const base = home.replace(/\/+$/, "");
  if (path === base) return "~";
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}

// ── Instructions (AGENTS.md interview) ───────────────────────────────

export interface SetupQuestion {
  readonly id: "who" | "what" | "how" | "never";
  readonly question: (projectName: string) => string;
  readonly chips: (kind: WorkKind) => ReadonlyArray<string>;
  readonly placeholder: string;
}

const KIND_WHAT: Readonly<Record<WorkKind, ReadonlyArray<string>>> = {
  site: ["Landing page for my candle shop", "Portfolio site", "Website for a local café"],
  bot: [
    "Telegram bot that takes orders",
    "Support bot for my customers",
    "Bot that reminds my team",
  ],
  data: ["Monthly sales report", "Ad spend vs. results", "Stock and prices tracker"],
  docs: ["Proposals and contracts", "Grant application", "Company handbook"],
  other: ["A bit of everything for my business", "Research for a new idea", "My personal admin"],
};

export const SETUP_QUESTIONS: ReadonlyArray<SetupQuestion> = [
  {
    id: "who",
    question: () =>
      "Let's write your instructions together. First: who are you? One line is enough.",
    chips: () => ["I run a small online shop", "Freelance designer", "Marketing lead at a startup"],
    placeholder: "e.g. I run a candle shop in Lisbon",
  },
  {
    id: "what",
    question: (projectName) => `What is ${projectName || "this project"} about?`,
    chips: (kind) => KIND_WHAT[kind],
    placeholder: "e.g. a landing page for our new candles",
  },
  {
    id: "how",
    question: () => "How should I answer you?",
    chips: () => ["Short and to the point", "Explain step by step", "Show two options, then wait"],
    placeholder: "e.g. short, in plain words",
  },
  {
    id: "never",
    question: () => "Anything I should never do?",
    chips: () => [
      "Never delete files without asking",
      "Never send anything to anyone without asking",
      "Never spend money",
    ],
    placeholder: "e.g. never touch the invoices folder",
  },
];

/** What a skipped question is stored as. */
export const NO_PREFERENCE = "No preference";

export function nextQuestionIndex(answers: Readonly<Record<string, string>>): number {
  return SETUP_QUESTIONS.findIndex((question) => !answers[question.id]);
}

function sentence(text: string): string {
  const trimmed = text.trim().replace(/[.!]+$/, "");
  return trimmed.length > 0 ? `${trimmed}.` : "";
}

function answered(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0 && value !== NO_PREFERENCE;
}

export const AGENTS_MD_WAITING = "_Waiting for your answer_";

/**
 * AGENTS.md from the four answers. Sections still waiting for an answer show
 * a placeholder (the live preview); `final` leaves them out of the file.
 */
export function buildAgentsMd(input: {
  readonly answers: Readonly<Record<string, string>>;
  readonly projectName: string;
  readonly projectFolder: string;
  readonly kind: string;
  readonly final?: boolean;
}): string {
  const { answers } = input;
  const waiting = input.final ? null : AGENTS_MD_WAITING;
  const sections: Array<{ title: string; body: string | null }> = [
    { title: "About me", body: answered(answers.who) ? sentence(answers.who) : waiting },
    {
      title: "This project",
      body: answered(answers.what)
        ? `${workKindLabel(input.kind)}: ${sentence(answers.what)} Files live in \`${input.projectFolder}\`.`
        : waiting,
    },
    {
      title: "How to answer",
      body: answered(answers.how)
        ? [`- ${sentence(answers.how)}`, "- Plain words. No jargon unless I ask."].join("\n")
        : waiting,
    },
    {
      title: "Never",
      body: answered(answers.never)
        ? [
            `- ${sentence(answers.never.replace(/^never\s+/i, "").replace(/^\w/, (c) => c.toUpperCase()))}`,
            "- Share my files outside this computer.",
          ].join("\n")
        : waiting,
    },
    {
      title: "On this computer",
      body: [
        "- The working disk is small: big files and finished documents belong in Cloud storage. Ask before filling it.",
        "- Ask before installing apps or opening ports.",
      ].join("\n"),
    },
  ];
  const parts = [`# AGENTS.md — ${input.projectName || "my project"}`];
  for (const section of sections) {
    if (section.body === null) continue;
    parts.push(`## ${section.title}\n${section.body}`);
  }
  return `${parts.join("\n\n")}\n`;
}

const POINTER_BEGIN = "<!-- uno-workspace:begin -->";
const POINTER_END = "<!-- uno-workspace:end -->";

/**
 * The file to write over an existing AGENTS.md. The workspace pointer block
 * (Settings → Workspace → "Write to project", see instructionLayers.ts on the
 * daemon) is kept, so the machine's own instructions still reach the agent.
 */
export function mergeAgentsMd(existing: string | null, generated: string): string {
  if (!existing) return generated;
  const begin = existing.indexOf(POINTER_BEGIN);
  const end = existing.indexOf(POINTER_END);
  if (begin < 0 || end < begin) return generated;
  const block = existing.slice(begin, end + POINTER_END.length);
  return `${generated.trimEnd()}\n\n${block}\n`;
}

// ── Done ─────────────────────────────────────────────────────────────

export const FIRST_TASKS: Readonly<Record<WorkKind, ReadonlyArray<string>>> = {
  site: [
    "Make a first version of the landing page from my files",
    "Write the About page in my brand voice",
    "Publish the page at its own address",
  ],
  bot: [
    "Make a Telegram bot that answers questions from my files",
    "Keep the bot running when my laptop is off",
    "Show me how to change what the bot says",
  ],
  data: [
    "Make a report from the sheets in materials/",
    "Chart this quarter by month",
    "Find the three biggest changes and explain them",
  ],
  docs: [
    "Turn my notes into a one-page brief",
    "Draft a proposal in Office from my files",
    "Check all documents for typos and tone",
  ],
  other: [
    "Read my files and suggest where to start",
    "Make a to-do list from my notes",
    "Tell me what you can do on this computer",
  ],
};

export function setupProjectOf(progress: UnoSetupProgress): UnoSetupProject | null {
  return progress.project ?? null;
}
