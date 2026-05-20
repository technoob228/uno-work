import { StepEyebrow, StepTitle } from "./stepShared";

const RULES = [
  {
    n: 1,
    title: "One folder = one project",
    body: "The agent only sees files inside the folder you pick. Keep separate projects in separate folders.",
  },
  {
    n: 2,
    title: "Context lives in the folder",
    body: "Drop docs, specs, examples, and reference files into the project folder. The more context the agent sees, the better it works.",
  },
  {
    n: 3,
    title: "Start with a project map",
    body: "Ask the agent to scan the folder and write a short project description (e.g. AGENTS.md). Future sessions will be faster.",
  },
  {
    n: 4,
    title: "Review before trusting",
    body: "Use the preview and diff panels to check what the agent changed. Tighten permissions if it does too much.",
  },
  {
    n: 5,
    title: "One task = one thread",
    body: "Don't mix unrelated tasks in one chat. Start a new thread for a new goal — the agent stays focused.",
  },
  {
    n: 6,
    title: "The agent uses your AI quota",
    body: "Every message costs tokens against your harness or Uno LLM subscription. Bigger context = bigger cost.",
  },
];

export function RulesStep() {
  return (
    <div>
      <StepEyebrow>How to work with the agent</StepEyebrow>
      <StepTitle>How to get the most out of Uno Work.</StepTitle>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {RULES.map((rule) => (
          <div
            key={rule.n}
            className="flex items-start gap-4 rounded-xl border border-border bg-card p-4"
          >
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
              {rule.n}
            </div>
            <div className="flex flex-col gap-1">
              <div className="text-sm font-semibold">{rule.title}</div>
              <div className="text-sm leading-relaxed text-muted-foreground">{rule.body}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
