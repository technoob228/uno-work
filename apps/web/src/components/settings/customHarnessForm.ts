/**
 * The Add / Edit custom harness form, as data: draft ↔ `providerInstances`
 * entry (`driver: "acp"`). Validation is the shared one the daemon applies
 * to harness files, so the dialog and `~/.uno/harnesses/*.json` reject the
 * same things with the same words.
 *
 * Kept free of React so it can be tested with plain objects.
 *
 * @module components/settings/customHarnessForm
 */
import {
  CUSTOM_HARNESS_DRIVER_KIND,
  type CustomHarnessSettings,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
} from "@t3tools/contracts";
import {
  cleanHarnessIcon,
  cleanHarnessText,
  formatCommandLine,
  HARNESS_ENV_NAME_PATTERN,
  harnessIdFromName,
  splitCommandLine,
  validateHarnessCommandLine,
  validateHarnessConfig,
} from "@t3tools/shared/customHarness";

export interface HarnessEnvDraft {
  /** Stable row key for the form. */
  readonly key: string;
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
  /** A stored secret the form did not change (value is not sent back). */
  readonly redacted: boolean;
}

export interface HarnessDraft {
  readonly name: string;
  readonly icon: string;
  readonly description: string;
  /** Executable + arguments, one line, no shell. */
  readonly commandLine: string;
  readonly workingDirectory: CustomHarnessSettings["workingDirectory"];
  readonly customDirectory: string;
  readonly installLine: string;
  readonly detectLine: string;
  /** One model id per line, optionally `id = Display name`. */
  readonly modelsText: string;
  readonly authMethodId: string;
  readonly env: ReadonlyArray<HarnessEnvDraft>;
  readonly shareUnoGateway: boolean;
  readonly shareUnoAccount: boolean;
  readonly enabled: boolean;
}

export type HarnessDraftField =
  | "name"
  | "commandLine"
  | "customDirectory"
  | "installLine"
  | "detectLine"
  | "env"
  | "modelsText";

export const EMPTY_HARNESS_DRAFT: HarnessDraft = {
  name: "",
  icon: "",
  description: "",
  commandLine: "",
  workingDirectory: "project",
  customDirectory: "",
  installLine: "",
  detectLine: "",
  modelsText: "",
  authMethodId: "",
  env: [],
  shareUnoGateway: false,
  shareUnoAccount: false,
  enabled: true,
};

export function draftFromInstance(
  instance: ProviderInstanceConfig,
  config: CustomHarnessSettings,
): HarnessDraft {
  return {
    name: instance.displayName ?? "",
    icon: config.icon,
    description: config.description,
    commandLine: formatCommandLine([config.command, ...config.args].filter((a) => a.length > 0)),
    workingDirectory: config.workingDirectory,
    customDirectory: config.customDirectory,
    installLine: formatCommandLine(config.installCommand),
    detectLine: formatCommandLine(config.detectCommand),
    modelsText: config.models
      .map((model) => (model.name ? `${model.id} = ${model.name}` : model.id))
      .join("\n"),
    authMethodId: config.authMethodId,
    env: (instance.environment ?? []).map((variable, index) => ({
      key: `stored-${index}-${variable.name}`,
      name: variable.name,
      value: variable.value,
      secret: variable.sensitive,
      redacted: variable.valueRedacted === true && variable.value.length === 0,
    })),
    shareUnoGateway: config.shareUnoGateway,
    shareUnoAccount: config.shareUnoAccount,
    enabled: instance.enabled ?? config.enabled,
  };
}

export function parseModelsText(text: string): CustomHarnessSettings["models"] {
  const models: Array<{ id: string; name?: string }> = [];
  for (const line of text.split(/[\n,]/)) {
    const [rawId, ...rest] = line.split("=");
    const id = cleanHarnessText(rawId, 200);
    if (!id || models.some((model) => model.id === id)) continue;
    const name = cleanHarnessText(rest.join("="), 80);
    models.push(name ? { id, name } : { id });
  }
  return models;
}

export type BuildHarnessResult =
  | {
      readonly ok: true;
      readonly instance: ProviderInstanceConfig;
      readonly config: CustomHarnessSettings;
    }
  | { readonly ok: false; readonly errors: Partial<Record<HarnessDraftField, string>> };

/** Draft → `providerInstances` entry, or per-field errors. */
export function buildHarnessInstance(draft: HarnessDraft): BuildHarnessResult {
  const errors: Partial<Record<HarnessDraftField, string>> = {};
  const name = cleanHarnessText(draft.name, 40);
  if (!name) errors.name = "Give the harness a name.";

  const split = splitCommandLine(draft.commandLine);
  let command = "";
  let args: ReadonlyArray<string> = [];
  if (!split.ok) {
    errors.commandLine = split.reason;
  } else if (split.value.length === 0) {
    errors.commandLine = "Enter the command that starts the agent in ACP mode.";
  } else {
    command = split.value[0]!;
    args = split.value.slice(1);
  }

  const install = validateHarnessCommandLine(draft.installLine.trim(), "install");
  if (!install.ok) errors.installLine = install.reason;
  const detect = validateHarnessCommandLine(draft.detectLine.trim(), "detect");
  if (!detect.ok) errors.detectLine = detect.reason;

  const seen = new Set<string>();
  for (const variable of draft.env) {
    if (!HARNESS_ENV_NAME_PATTERN.test(variable.name)) {
      errors.env = `"${variable.name || "(empty)"}" is not a valid variable name (letters, digits, _).`;
      break;
    }
    if (seen.has(variable.name)) {
      errors.env = `${variable.name} is listed twice.`;
      break;
    }
    seen.add(variable.name);
  }

  const config: CustomHarnessSettings = {
    enabled: draft.enabled,
    command,
    args: [...args],
    workingDirectory: draft.workingDirectory,
    customDirectory: draft.workingDirectory === "custom" ? draft.customDirectory.trim() : "",
    installCommand: install.ok ? [...install.value] : [],
    detectCommand: detect.ok ? [...detect.value] : [],
    models: parseModelsText(draft.modelsText),
    authMethodId: draft.authMethodId.trim(),
    icon: cleanHarnessIcon(draft.icon),
    description: cleanHarnessText(draft.description, 200),
    shareUnoGateway: draft.shareUnoGateway,
    shareUnoAccount: draft.shareUnoAccount,
  };

  if (!errors.commandLine) {
    const checked = validateHarnessConfig(config);
    if (!checked.ok) {
      if (/folder|workingDirectory/i.test(checked.reason)) errors.customDirectory = checked.reason;
      else errors.commandLine = checked.reason;
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const environment: ProviderInstanceEnvironmentVariable[] = draft.env.map((variable) =>
    variable.secret && variable.redacted
      ? { name: variable.name, value: "", sensitive: true, valueRedacted: true }
      : { name: variable.name, value: variable.value, sensitive: variable.secret },
  );
  return {
    ok: true,
    config,
    instance: {
      driver: ProviderDriverKind.make(CUSTOM_HARNESS_DRIVER_KIND),
      displayName: name,
      enabled: draft.enabled,
      ...(environment.length > 0 ? { environment } : {}),
      config,
    },
  };
}

/**
 * Instance id for a new Settings harness, unique among `existing`. Always
 * `custom-…`, so a harness named "Codex" can never take over the built-in
 * `codex` slot (or a file harness's `harness-…`).
 */
export function newHarnessInstanceId(name: string, existing: ReadonlySet<string>): string {
  const base = `custom-${harnessIdFromName(name).replace(/^agent-/, "")}`.slice(0, 56);
  if (!existing.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}
