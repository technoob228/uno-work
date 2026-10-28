/**
 * The hook of a variant (A/B/C/D, 28.10): the one file a variant's branch
 * changes to put its own assistants, scripts and scenes into the base. Runs
 * once before the demo starts (demoBoot imports it).
 *
 * The base itself leaves it empty: Uno on every computer, the base scripts.
 * Examples (see README_DEMO.md):
 *
 *   DEMO_PERSONAS.push({ projectId: "assistant-mila", machine: "work", name: "Mila",
 *     emoji: "🦊", tone: "amber", roles: ["Research"], character: "Curious", duties: [],
 *     setUp: true, chats: [] });
 *   addTrigger({ id: "mila-news", persona: "assistant-mila", match: /news/i,
 *     script: () => [{ work: "Reading 40 sources…" }, { say: "3 things matter today: …" }] });
 *   addScene({ id: "two-assistants", title: "…", hint: "…", run: ({ play }) => void play([...]) });
 *   setGreeting((ctx) => [{ say: `Hi, I'm ${ctx.persona.name}…` }, ...connectorsCard(ctx)]);
 */
export const VARIANT: { readonly id: string; readonly title: string } = {
  id: "base",
  title: "База (без варианта)",
};
