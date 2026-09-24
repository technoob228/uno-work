/**
 * Pure decisions behind the assistant's engine panel (0.0.84): is Hermes
 * usable on this machine, and how the model list reads.
 *
 * @module manager/assistantLlm
 */
import {
  ASSISTANT_DEFAULT_GATEWAY_MODEL,
  type AssistantHarnessStatus,
  type AssistantLlmModel,
  type ProviderInstallJobStatus,
  type ServerProvider,
} from "@t3tools/contracts";
import { grokReleaseVersion } from "@t3tools/shared/assistantLlm";

/** The initial Hermes snapshot says this until the first probe lands (HermesProvider.ts). */
const CHECKING_MESSAGE_PREFIX = "Checking Hermes";

function logTail(log: string | undefined, lines = 3): string | null {
  if (!log) return null;
  const tail = log
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-lines)
    .join("\n");
  return tail.length > 0 ? tail : null;
}

/**
 * Hermes, as the assistant needs it. An install job in flight wins; then what
 * the provider probe saw; a failed job explains a Hermes that is still
 * missing.
 */
export function deriveAssistantHarnessStatus(input: {
  readonly snapshot: ServerProvider | undefined;
  readonly job: ProviderInstallJobStatus | null;
}): AssistantHarnessStatus {
  const { snapshot, job } = input;
  if (job !== null && (job.state === "queued" || job.state === "running")) {
    return {
      state: "installing",
      message: "Installing Hermes — Uno's engine. This takes a minute or two the first time.",
      version: null,
      logTail: logTail(job.log),
    };
  }
  if (snapshot === undefined) {
    return { state: "checking", message: null, version: null, logTail: null };
  }
  if (snapshot.installed) {
    if (snapshot.version === null && snapshot.message?.startsWith(CHECKING_MESSAGE_PREFIX)) {
      return { state: "checking", message: null, version: null, logTail: null };
    }
    const probeFailed = snapshot.version === null && snapshot.status === "error";
    if (probeFailed) {
      return {
        state: "failed",
        message: snapshot.message ?? "Hermes is installed but does not start.",
        version: null,
        logTail: null,
      };
    }
    return { state: "ready", message: null, version: snapshot.version, logTail: null };
  }
  if (job !== null && job.state === "failed") {
    return {
      state: job.error?.includes("not available on this machine") ? "unsupported" : "failed",
      message: job.error ?? "Installing Hermes failed.",
      version: null,
      logTail: logTail(job.log, 5),
    };
  }
  return {
    state: "missing",
    message: "Hermes — Uno's engine — is not installed on this computer yet.",
    version: null,
    logTail: null,
  };
}

function grokRank(id: string): number {
  if (id === ASSISTANT_DEFAULT_GATEWAY_MODEL || /(^|\/)grok-latest$/.test(id)) return 0;
  return /(^|\/)grok-/i.test(id) ? 1 : 2;
}

/**
 * Picker order: the latest-Grok alias, then Grok releases newest first, then
 * everything else by name. The gateway alias is always offered on the gateway
 * even when the catalog hides it.
 */
export function orderAssistantModels(
  models: ReadonlyArray<AssistantLlmModel>,
  options?: { readonly ensureGatewayAlias?: boolean },
): ReadonlyArray<AssistantLlmModel> {
  const list = [...models];
  if (
    options?.ensureGatewayAlias &&
    !list.some((model) => model.id === ASSISTANT_DEFAULT_GATEWAY_MODEL)
  ) {
    list.push({ id: ASSISTANT_DEFAULT_GATEWAY_MODEL, name: "Grok (latest)" });
  }
  return list.toSorted((a, b) => {
    const rank = grokRank(a.id) - grokRank(b.id);
    if (rank !== 0) return rank;
    if (grokRank(a.id) === 1) {
      // Releases newest first (4.7 before 4.20 — xAI numbers them as
      // decimals); variants after their release.
      const release = (grokReleaseVersion(b.id) ?? -1) - (grokReleaseVersion(a.id) ?? -1);
      if (release !== 0) return release;
    }
    return a.name.localeCompare(b.name);
  });
}
