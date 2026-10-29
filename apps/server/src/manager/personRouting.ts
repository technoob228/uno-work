/**
 * The person's routing rows, applied by the server when an assistant starts
 * a chat (create_thread, chat_create).
 *
 * Until 0.0.160 ROUTING.md only reached the assistant's prompt, and the
 * server spawned on whatever the model passed, else the account default AI
 * (`uno` → Smart). Misha set "Claude everywhere" on the Models page, asked
 * "start it through Claude" — and got Smart (29.10). Now, in this order:
 *
 * 1. the person's `you` rows (the row `taskType` names, or the one harness
 *    they all agree on);
 * 2. what the model passed — and when it marks `personAsked` (the person
 *    named a model in this conversation), that comes first;
 * 3. the account default AI, 4. the project's default (callers, as before).
 *
 * A harness the rows name that isn't ready here (not installed, off, not
 * signed in) is NOT swapped for another: the chat isn't started and the
 * model gets one line to ask the person.
 *
 * @module manager/personRouting
 */
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import {
  type ModelSelection,
  ProviderInstanceId,
  type ServerProvider,
  isProviderAvailable,
} from "@t3tools/contracts";
import { personRoute, thinkingOption, type PersonRoute } from "@t3tools/shared/assistantMemory";
import { normalizeModelSlug } from "@t3tools/shared/model";

import { resolveModel } from "../provider/autoBootstrapModelSelection.ts";

const HARNESS_ALIASES: Readonly<Record<string, string>> = {
  claude: "claudeAgent",
  "claude-code": "claudeAgent",
  claudecode: "claudeAgent",
};

const HARNESS_LABELS: Readonly<Record<string, string>> = {
  claudeAgent: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  hermes: "Hermes",
  uno: "Uno AI",
};

export type PersonRoutedSelection =
  /** No rule of the person's applies: choose as before. */
  | { readonly kind: "none" }
  | { readonly kind: "selection"; readonly selection: ModelSelection; readonly route: PersonRoute }
  /** The person's harness isn't ready here: don't start, ask. */
  | { readonly kind: "not-ready"; readonly message: string };

/** Why a provider can't take a chat now, or null when it can. */
export function providerNotReadyReason(provider: ServerProvider): string | null {
  if (!isProviderAvailable(provider) || !provider.installed) return "not installed";
  if (!provider.enabled || provider.status === "disabled") return "turned off";
  if (provider.auth.status === "unauthenticated") return "not signed in";
  if (provider.status === "error") return provider.message ?? "not working";
  return null;
}

function findProvider(
  harness: string,
  providers: ReadonlyArray<ServerProvider>,
): ServerProvider | undefined {
  const wanted = [harness, HARNESS_ALIASES[harness.toLowerCase()]].filter(
    (value): value is string => value !== undefined,
  );
  for (const name of wanted) {
    const exact = providers.find((provider) => provider.instanceId === name);
    if (exact !== undefined) return exact;
    const byDriver = providers.filter((provider) => provider.driver === name);
    const ready = byDriver.find((provider) => providerNotReadyReason(provider) === null);
    if (ready ?? byDriver[0]) return ready ?? byDriver[0];
  }
  return undefined;
}

const FAMILIES = ["opus", "sonnet", "haiku", "fable", "codex", "mini", "nano"] as const;

/**
 * The table's model as this provider offers it: the slug itself, else the
 * newest of the same family (the ROUTING notes' rule), else as written.
 */
function offeredModel(provider: ServerProvider, model: string): string {
  const slug = normalizeModelSlug(model, provider.driver) ?? model;
  if (provider.models.length === 0 || provider.models.some((entry) => entry.slug === slug)) {
    return slug;
  }
  const family = FAMILIES.find((name) => slug.toLowerCase().includes(name));
  const sameFamily =
    family === undefined
      ? undefined
      : provider.models.find((entry) => entry.slug.toLowerCase().includes(family));
  return sameFamily?.slug ?? slug;
}

export function applyPersonRoute(input: {
  readonly route: PersonRoute | null;
  /** What the model passed (create_thread modelSelection / chat_create provider). */
  readonly requested: ModelSelection | null;
  /** The model says the person named this model in the conversation. */
  readonly personAsked: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
}): PersonRoutedSelection {
  const { route, requested } = input;
  if (route === null) return { kind: "none" };
  if (input.personAsked && requested !== null) return { kind: "none" };
  const provider = findProvider(route.harness, input.providers);
  const label = HARNESS_LABELS[provider?.driver ?? ""] ?? provider?.displayName ?? route.harness;
  const reason = provider === undefined ? "not installed" : providerNotReadyReason(provider);
  if (provider === undefined || reason !== null) {
    const fix =
      reason === "not signed in"
        ? "Settings → Agents → Sign in"
        : reason === "turned off"
          ? "Settings → Agents → turn it on"
          : "Settings → Agents → install it";
    return {
      kind: "not-ready",
      message:
        `The person's routing table says ${label} for this, but ${label} is ${reason} on this computer — ` +
        `the chat was NOT started. Don't start it on another model; ask in one line: ` +
        `"${label} isn't connected on this computer — connect it (${fix}) or run it on <other model>?" ` +
        `If they pick another model, call again with that model and personAsked: true.`,
    };
  }
  const model =
    route.model !== null
      ? offeredModel(provider, route.model)
      : requested !== null && requested.instanceId === provider.instanceId
        ? requested.model
        : resolveModel(provider);
  if (model === null) return { kind: "none" };
  const option = route.thinking === null ? null : thinkingOption(provider.driver, route.thinking);
  const keptOptions =
    requested !== null && requested.instanceId === provider.instanceId && option === null
      ? requested.options
      : undefined;
  const selection: ModelSelection = {
    instanceId: ProviderInstanceId.make(provider.instanceId),
    model,
    ...(option !== null
      ? { options: [option] }
      : keptOptions !== undefined
        ? { options: keptOptions }
        : {}),
  };
  return { kind: "selection", selection, route };
}

/** The person's route from `<workspaceRoot>/ROUTING.md`; null when none / unreadable. */
export async function readPersonRoute(
  workspaceRoot: string,
  taskType?: string,
): Promise<PersonRoute | null> {
  try {
    const content = await fs.readFile(nodePath.join(workspaceRoot, "ROUTING.md"), "utf8");
    return personRoute(content, taskType);
  } catch {
    return null;
  }
}
