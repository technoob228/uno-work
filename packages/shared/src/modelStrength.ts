/**
 * How strong a model is, for the picks nobody made by hand: what a chat an
 * assistant starts runs on when no row of the person's names a model.
 *
 * 13.11: on a test account the assistant's chats ran on GPT-5.6 Luna — the
 * account's onboarding AI was Codex, Codex didn't list `gpt-5.4` (the old
 * default) and the first model of its list won. A machine pick now follows a
 * known order of strength, and never lands on a small / fast model by itself
 * (`luna`, `mini`, `fast`, `haiku`, …). Those stay one explicit choice away.
 *
 * Pure: no I/O. Readiness is the caller's (server: personRouting.ts).
 *
 * @module modelStrength
 */
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

/** Small / fast models: never a machine's default pick. */
const WEAK_MODEL_RE = /(^|[-/_.~])(luna|mini|nano|fast|spark|flash|lite|haiku)([-/_.:]|$)/i;

export function isWeakModel(slug: string): boolean {
  return WEAK_MODEL_RE.test(slug);
}

/**
 * Strongest first, per harness. Codex slugs as the ChatGPT plan serves them
 * (assistantLlm.ts `SUBSCRIPTION_MODELS`, Codex `model/list`).
 */
export const STRONG_MODELS_BY_DRIVER: Readonly<Record<string, ReadonlyArray<string>>> = {
  claudeAgent: [
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
  ],
  codex: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.3-codex"],
};

/** Harnesses whose line-up is known: only weak models listed = no default at all. */
const KNOWN_LINEUP_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "uno",
  "hermes",
]);

type Models = ReadonlyArray<Pick<ServerProvider["models"][number], "slug">>;

/** The strongest model of {@link STRONG_MODELS_BY_DRIVER} the list offers, or null. */
export function strongestListedModel(driver: string, models: Models): string | null {
  const order = STRONG_MODELS_BY_DRIVER[driver] ?? [];
  return order.find((slug) => models.some((model) => model.slug === slug)) ?? null;
}

/**
 * A model to fall back on when the harness's own default isn't listed: the
 * strongest known one, else the first that isn't small / fast. Harnesses
 * with a known line-up get null rather than a weak model; others (OpenCode,
 * Cursor — strength unknown) keep their first model as before.
 */
export function fallbackListedModel(driver: string, models: Models): string | null {
  const strongest = strongestListedModel(driver, models);
  if (strongest !== null) return strongest;
  const notWeak = models.find((model) => !isWeakModel(model.slug));
  if (notWeak !== undefined) return notWeak.slug;
  if (KNOWN_LINEUP_DRIVERS.has(driver)) return null;
  return models[0]?.slug ?? null;
}

const OPUS_SLUG_RE = /claude-opus-(\d+)[-.](\d+)/i;

function opusVersion(slug: string): number | null {
  const match = OPUS_SLUG_RE.exec(slug);
  return match ? Number(match[1]) * 100 + Number(match[2]) : null;
}

/** Uno AI premium: the newest Opus of the gateway, else its first frontier premium model. */
function unoPremiumModel(provider: ServerProvider): string | null {
  const premium = provider.models.filter((model) => {
    const metadata = model.capabilities?.metadata;
    return (
      !isWeakModel(model.slug) &&
      (metadata?.unoGroup === "premium" ||
        (metadata?.unoGroup === undefined && metadata?.tier === "frontier"))
    );
  });
  let best: { slug: string; version: number } | null = null;
  for (const model of premium) {
    const version = opusVersion(model.slug);
    if (version !== null && (best === null || version > best.version)) {
      best = { slug: model.slug, version };
    }
  }
  if (best !== null) return best.slug;
  return premium.find((model) => model.capabilities?.metadata?.tier === "frontier")?.slug ?? null;
}

/** Claude Code with no sign-in of its own runs on Uno credits (ClaudeProvider `auth.type`). */
function claudeOnUnoCredits(provider: ServerProvider): boolean {
  return provider.auth.type === "unoAi";
}

export type StrongestTier = "claude" | "codex" | "uno-premium";

export interface StrongestReady {
  readonly selection: ModelSelection;
  readonly tier: StrongestTier;
}

/**
 * The strongest model a ready harness of this machine offers, for work no
 * row of the person's decided:
 *
 * 1. Claude Opus (5.5 first) on the person's own Claude sign-in;
 * 2. Codex's strong models (GPT-5.6 Terra, Sol, GPT-5.5, GPT-5.4) on their plan;
 * 3. Uno AI premium (paid from Uno credit): Claude Code on Uno credits with
 *    Opus, else Uno Code's newest premium Opus-class model.
 *
 * null: none of them is ready here — the caller falls back to the project's
 * default. `isReady` is the caller's full check (installed, on, signed in,
 * allowed to use Uno credits).
 */
export function strongestReadySelection(
  providers: ReadonlyArray<ServerProvider>,
  isReady: (provider: ServerProvider) => boolean,
): StrongestReady | null {
  const ready = providers.filter(isReady);
  const pick = (
    tier: StrongestTier,
    match: (provider: ServerProvider) => boolean,
    model: (provider: ServerProvider) => string | null,
  ): StrongestReady | null => {
    for (const provider of ready) {
      if (!match(provider)) continue;
      const slug = model(provider);
      if (slug !== null)
        return { tier, selection: { instanceId: provider.instanceId, model: slug } };
    }
    return null;
  };
  const claudeOpus = (provider: ServerProvider) => {
    const slug = strongestListedModel("claudeAgent", provider.models);
    return slug !== null && opusVersion(slug) !== null ? slug : null;
  };
  return (
    pick(
      "claude",
      (provider) => provider.driver === "claudeAgent" && !claudeOnUnoCredits(provider),
      claudeOpus,
    ) ??
    pick(
      "codex",
      (provider) => provider.driver === "codex",
      (provider) => strongestListedModel("codex", provider.models),
    ) ??
    pick(
      "uno-premium",
      (provider) => provider.driver === "claudeAgent" && claudeOnUnoCredits(provider),
      claudeOpus,
    ) ??
    pick("uno-premium", (provider) => provider.driver === "uno", unoPremiumModel)
  );
}
