/**
 * "Uses AI" as a person reads it — in the App Store, the install confirm,
 * Settings → Apps and on app tiles — and the "Answers from" choice of one
 * app. Pure, so the wording and the options are tested without rendering.
 */
import {
  AI_PROVIDER_LABELS,
  APP_SDK_DEFAULT_LIMIT_USD,
  type AppAiApp,
  type AppAiProviderChoice,
  type AppAiProviders,
  type UnoAppAiUse,
} from "@t3tools/contracts";

export function formatLimit(usd: number): string {
  return `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`;
}

/** "answers", "jobs", "answers and jobs". */
export function aiUsesWords(ai: Pick<UnoAppAiUse, "chat" | "tasks">): string {
  return [ai.chat ? "answers" : null, ai.tasks ? "jobs" : null].filter(Boolean).join(" and ");
}

/**
 * The App Store line: "Uses AI for answers · up to $10 · via Uno AI". The
 * limit is the app's Uno AI budget until the person changes it.
 */
export function storeAiLine(ai: UnoAppAiUse): string {
  const limit = formatLimit(ai.limitUsd ?? APP_SDK_DEFAULT_LIMIT_USD);
  return `Uses AI for ${aiUsesWords(ai)} · up to ${limit} · via Uno AI`;
}

/** The install confirm: what the person agrees to, in three short lines. */
export function installAiLines(ai: UnoAppAiUse): string[] {
  const limit = formatLimit(ai.limitUsd ?? APP_SDK_DEFAULT_LIMIT_USD);
  const lines = [
    `Uses this computer's AI for ${aiUsesWords(ai)} — through Uno AI, no key of its own.`,
    `It may spend up to ${limit} of your Uno AI credits; then it stops until you raise the limit.`,
  ];
  if (ai.tasks) {
    lines.push("Its jobs appear as chats you can watch and stop.");
  }
  lines.push(
    "Change the limit, switch it to AI on this computer or your own key, or turn it off in Settings → Apps.",
  );
  return lines;
}

/**
 * A tile's tooltip addition: "Uses AI · Uno AI · $0.40 of $10" or
 * "Uses AI · Ollama on this computer · qwen3:4b". Null: no AI or turned off.
 */
export function tileAiNote(
  app: Pick<
    AppAiApp,
    "chat" | "tasks" | "status" | "providerLabel" | "metered" | "spentUsd" | "limitUsd"
  >,
): string | null {
  if (!app.chat && !app.tasks) return null;
  if (app.status === "revoked") return "AI turned off";
  const via = app.providerLabel ?? "Uno AI";
  const spend =
    app.metered === false
      ? ""
      : ` · ${formatUsdShort(app.spentUsd)} of ${formatLimit(app.limitUsd)}`;
  return `Uses AI for ${aiUsesWords(app)} · ${via}${spend}`;
}

function formatUsdShort(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2).replace(/\.00$/, "")}`;
}

/** Value of the "Answers from" select. */
export function choiceValue(choice: AppAiProviderChoice | undefined): string {
  if (!choice || choice.kind === "uno") return "uno";
  if (choice.kind === "local") return `local:${choice.baseUrl ?? ""}`;
  if (choice.kind === "byok") return `byok:${choice.keyProvider ?? "custom"}`;
  return "personal";
}

export const MANUAL_LOCAL_VALUE = "local-manual";

export interface ProviderOption {
  readonly value: string;
  readonly label: string;
  /** One line under the option. */
  readonly hint: string;
  readonly disabled: boolean;
}

/** What "Answers from" offers on this computer now; the current choice is always there. */
export function providerOptions(
  providers: AppAiProviders | undefined,
  current: AppAiProviderChoice | undefined,
): ProviderOption[] {
  const out: ProviderOption[] = [
    {
      value: "uno",
      label: "Uno AI",
      hint:
        providers && !providers.unoConnected
          ? "Not connected — sign in to Uno"
          : "Counts against the app's limit",
      disabled: false,
    },
  ];
  const seen = new Set<string>(["uno"]);
  for (const endpoint of providers?.local ?? []) {
    const value = `local:${endpoint.baseUrl}`;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({
      value,
      label: `${endpoint.label} on this computer`,
      hint: endpoint.reachable
        ? `${endpoint.models.length} model${endpoint.models.length === 1 ? "" : "s"} · free, no limit`
        : "Not answering right now",
      disabled: false,
    });
  }
  if ((providers?.personal.length ?? 0) > 0) {
    seen.add("personal");
    const price = Math.min(...(providers?.personal ?? []).map((m) => m.priceUsdPerHour));
    out.push({
      value: "personal",
      label: "Personal AI (your GPU)",
      hint: `From $${price}/hour while it's on · no app limit`,
      disabled: false,
    });
  }
  for (const key of providers?.keys ?? []) {
    if (!key.configured) continue;
    const value = `byok:${key.provider}`;
    seen.add(value);
    out.push({
      value,
      label: `${AI_PROVIDER_LABELS[key.provider]} (your key)`,
      hint: `Billed by ${AI_PROVIDER_LABELS[key.provider]} · no app limit`,
      disabled: false,
    });
  }
  const currentValue = choiceValue(current);
  if (!seen.has(currentValue)) {
    out.push({
      value: currentValue,
      label:
        current?.kind === "local"
          ? `${current.baseUrl ?? "AI"} (not found now)`
          : current?.kind === "byok"
            ? `${AI_PROVIDER_LABELS[current.keyProvider ?? "custom"]} (key removed)`
            : "Personal AI (not available now)",
      hint: "The app's calls fail until it's back or you pick another",
      disabled: false,
    });
  }
  out.push({
    value: MANUAL_LOCAL_VALUE,
    label: "Another AI server…",
    hint: "Any OpenAI-compatible address",
    disabled: false,
  });
  return out;
}

/** The choice a select value stands for (keeping the model when the provider stays). */
export function choiceFromValue(
  value: string,
  current: AppAiProviderChoice | undefined,
): AppAiProviderChoice | null {
  if (value === MANUAL_LOCAL_VALUE) return null;
  const sameProvider = choiceValue(current) === value;
  const model = sameProvider ? (current?.model ?? null) : null;
  if (value === "uno") return { kind: "uno", model };
  if (value === "personal") return { kind: "personal", model };
  if (value.startsWith("local:")) return { kind: "local", baseUrl: value.slice(6), model };
  if (value.startsWith("byok:")) {
    const provider = value.slice(5);
    if (
      provider === "xai" ||
      provider === "openrouter" ||
      provider === "openai" ||
      provider === "custom"
    ) {
      return { kind: "byok", keyProvider: provider, model };
    }
  }
  return null;
}

/** "Local models on this computer: Ollama (qwen3:4b)…" — the section's status line. */
export function providersSummary(providers: AppAiProviders | undefined): string | null {
  if (!providers) return null;
  const parts: string[] = [providers.unoConnected ? "Uno AI" : "Uno AI (not connected)"];
  for (const endpoint of providers.local.filter((e) => e.reachable && e.detected)) {
    parts.push(
      `${endpoint.label} on this computer${endpoint.models.length > 0 ? ` (${endpoint.models.slice(0, 3).join(", ")}${endpoint.models.length > 3 ? "…" : ""})` : ""}`,
    );
  }
  if (providers.personal.length > 0) parts.push("Personal AI");
  const keys = providers.keys.filter((k) => k.configured);
  if (keys.length > 0) {
    parts.push(
      `your ${keys.map((k) => AI_PROVIDER_LABELS[k.provider]).join(", ")} key${keys.length === 1 ? "" : "s"}`,
    );
  }
  return `Available here: ${parts.join(" · ")}`;
}

export interface AddAiTarget {
  readonly id: string;
  readonly name: string;
  /** Its code folder (`~/projects/notes`), when known. */
  readonly codeDir: string | null;
  /** Already asks for AI in its manifest. */
  readonly hasAi: boolean;
}

/** The task a new chat opens with after "Add AI to an app". */
export function addAiPrompt(target: AddAiTarget): string {
  const where = target.codeDir ? ` (code in ${target.codeDir})` : "";
  const manifest = `~/.uno/apps/${target.id}.json`;
  return [
    `Add AI to my app "${target.name}"${where}.`,
    "",
    target.hasAi
      ? `It already has an "ai" block in ${manifest}; keep it.`
      : `Add "ai": {"chat": true} to ${manifest} so it gets its own AI token and shows "Uses AI" to me.`,
    'Use the Uno App SDK (not an API key): put a chat into the app\'s main page with the <uno-chat> component and its backend helper (chatHandler in Node, chat_sse in Python), with a short system prompt that knows what this app is about and the data it shows. Keep "model": "default" so I can switch the app between Uno AI, AI on this computer and my own key in Settings → Apps.',
    "Check ~/.uno/ai-providers.md for what AI this computer has. Restart the app when done, and tell me in two sentences what it can do now.",
  ].join("\n");
}
