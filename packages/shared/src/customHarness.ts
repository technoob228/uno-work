/**
 * Validation of custom (ACP) harness definitions — shared by the daemon (file
 * registry `~/.uno/harnesses/<id>.json`, Settings saves, Test connection) and
 * the Settings dialog, so both reject the same things with the same words.
 *
 * Everything here treats its input as untrusted: a harness file can be
 * written by anyone (or any agent) who can write to the home folder, and it
 * names a program the daemon will start. The rules:
 *
 *   - commands are argv arrays and are never run through a shell, so there is
 *     no interpolation, globbing, pipes or `$VAR` expansion anywhere;
 *   - the executable is an absolute path, `~/…`, or a bare name looked up on
 *     PATH — never a relative path (which would resolve against whatever
 *     folder a chat happens to run in);
 *   - text shown in the UI is stripped of control and bidi characters;
 *   - sizes are bounded.
 *
 * @module customHarness
 */

export const HARNESS_FILE_MAX_BYTES = 32 * 1024;
export const HARNESS_FILE_MAX_COUNT = 100;
export const HARNESS_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const HARNESS_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const MAX_COMMAND_CHARS = 1024;
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4096;
const MAX_ENV_VARS = 64;
const MAX_ENV_VALUE_CHARS = 32 * 1024;
const MAX_MODELS = 100;
const BARE_COMMAND_PATTERN = /^[A-Za-z0-9._+-]+$/;
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/;
// C0/C1 controls and the bidi overrides that can make a name read backwards.
// oxlint-disable-next-line no-control-regex
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
// oxlint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export type HarnessWorkingDirectory = "project" | "home" | "custom";

export interface HarnessModelDefinition {
  readonly id: string;
  readonly name?: string;
}

/** Normalized driver config (same shape as `CustomHarnessSettings`). */
export interface NormalizedHarnessConfig {
  readonly enabled: boolean;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly workingDirectory: HarnessWorkingDirectory;
  readonly customDirectory: string;
  readonly installCommand: ReadonlyArray<string>;
  readonly detectCommand: ReadonlyArray<string>;
  readonly models: ReadonlyArray<HarnessModelDefinition>;
  readonly authMethodId: string;
  readonly icon: string;
  readonly description: string;
  readonly shareUnoGateway: boolean;
  readonly shareUnoAccount: boolean;
}

export interface ParsedHarnessFile {
  readonly id: string;
  readonly name: string;
  readonly config: NormalizedHarnessConfig;
  /** Plain (non-secret) variables from the file. */
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  /** Names whose values the person enters in Settings (secret store). */
  readonly secretEnv: ReadonlyArray<string>;
}

export type HarnessResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: string };

const ok = <A>(value: A): HarnessResult<A> => ({ ok: true, value });
const fail = <A>(reason: string): HarnessResult<A> => ({ ok: false, reason });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cleanHarnessText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(UNSAFE_TEXT_RE, "").replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, max).join("");
}

/** One emoji or up to two letters; anything path- or markup-like is dropped. */
export function cleanHarnessIcon(value: unknown): string {
  const text = cleanHarnessText(value, 8);
  if (!text || /[<>/\\:"'`]|\.\./.test(text)) return "";
  return text;
}

/* ------------------------------------------------------------------ *
 * Command lines
 * ------------------------------------------------------------------ */

/**
 * Split a command line typed into Settings into argv, POSIX-quote style:
 * `'…'` literal, `"…"` with `\"`/`\\` escapes, `\x` outside quotes. There is
 * no shell behind it, so operators that only make sense in a shell are
 * rejected instead of being silently passed as literal arguments.
 */
export function splitCommandLine(input: string): HarnessResult<ReadonlyArray<string>> {
  const args: string[] = [];
  let current = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\" && (input[index + 1] === '"' || input[index + 1] === "\\")) {
        current += input[index + 1];
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inToken = true;
      continue;
    }
    if (char === "\\") {
      const next = input[index + 1];
      if (next === undefined) return fail("The command ends with a lone backslash.");
      current += next;
      inToken = true;
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      if (inToken) {
        args.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    if ("|;&<>`".includes(char) || (char === "$" && input[index + 1] === "(")) {
      return fail(
        `"${char}" needs a shell, and Uno Work starts the harness without one. Put pipes, redirects or variables into a script and point the command at it.`,
      );
    }
    current += char;
    inToken = true;
  }
  if (quote) return fail("A quote is not closed.");
  if (inToken) args.push(current);
  return ok(args);
}

/** Inverse of {@link splitCommandLine} for showing argv in an input. */
export function formatCommandLine(argv: ReadonlyArray<string>): string {
  return argv
    .map((arg) => (arg.length > 0 && /^[A-Za-z0-9_@%+=:,./~-]+$/.test(arg) ? arg : quoteArg(arg)))
    .join(" ");
}

function quoteArg(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function isAbsoluteCommandPath(command: string): boolean {
  return command.startsWith("/") || WINDOWS_ABSOLUTE_PATTERN.test(command);
}

/** The executable: absolute path, `~/…`, or a bare name found on PATH. */
export function validateHarnessExecutable(command: unknown): HarnessResult<string> {
  if (typeof command !== "string") return fail("The command must be text.");
  const trimmed = command.trim();
  if (trimmed.length === 0) return fail("The command is empty.");
  if (trimmed.length > MAX_COMMAND_CHARS) return fail("The command is too long.");
  if (CONTROL_RE.test(trimmed)) return fail("The command contains control characters.");
  if (isAbsoluteCommandPath(trimmed) || trimmed.startsWith("~/")) {
    if (trimmed.split(/[\\/]/).includes("..")) return fail("The command path must not use `..`.");
    return ok(trimmed);
  }
  if (!BARE_COMMAND_PATTERN.test(trimmed)) {
    return fail(
      "The command must be an absolute path (/usr/local/bin/agent, ~/bin/agent) or a program name on PATH (agent) — not a relative path or a shell line.",
    );
  }
  return ok(trimmed);
}

export function validateHarnessArgs(args: unknown, label = "args"): HarnessResult<string[]> {
  if (args === undefined || args === null) return ok([]);
  if (!Array.isArray(args)) return fail(`"${label}" must be a list of strings.`);
  if (args.length > MAX_ARGS) return fail(`"${label}" has more than ${MAX_ARGS} items.`);
  const out: string[] = [];
  for (const arg of args) {
    if (typeof arg !== "string") return fail(`"${label}" must contain only strings.`);
    if (arg.length > MAX_ARG_CHARS) return fail(`An item of "${label}" is too long.`);
    if (arg.includes("\u0000")) return fail(`"${label}" contains a NUL character.`);
    out.push(arg);
  }
  return ok(out);
}

/** `["kimi", "--version"]` or `"kimi --version"` → validated argv (empty allowed). */
export function validateHarnessCommandLine(
  value: unknown,
  label: string,
): HarnessResult<ReadonlyArray<string>> {
  if (value === undefined || value === null || value === "") return ok([]);
  let argv: ReadonlyArray<string>;
  if (typeof value === "string") {
    const split = splitCommandLine(value);
    if (!split.ok) return fail(`"${label}": ${split.reason}`);
    argv = split.value;
  } else {
    const args = validateHarnessArgs(value, label);
    if (!args.ok) return args;
    argv = args.value;
  }
  if (argv.length === 0) return ok([]);
  const executable = validateHarnessExecutable(argv[0]);
  if (!executable.ok) return fail(`"${label}": ${executable.reason}`);
  return ok([executable.value, ...argv.slice(1)]);
}

export function validateHarnessEnvName(name: unknown): HarnessResult<string> {
  if (typeof name !== "string" || !HARNESS_ENV_NAME_PATTERN.test(name)) {
    return fail(`"${String(name)}" is not a valid environment variable name.`);
  }
  return ok(name);
}

function validateModels(value: unknown): HarnessResult<HarnessModelDefinition[]> {
  if (value === undefined || value === null) return ok([]);
  if (!Array.isArray(value)) return fail('"models" must be a list.');
  const models: HarnessModelDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, MAX_MODELS)) {
    const id = typeof entry === "string" ? entry : isRecord(entry) ? entry["id"] : undefined;
    const cleanId = cleanHarnessText(id, 200);
    if (!cleanId) return fail('Every model needs an "id".');
    if (seen.has(cleanId)) continue;
    seen.add(cleanId);
    const name = isRecord(entry) ? cleanHarnessText(entry["name"], 80) : "";
    models.push(name ? { id: cleanId, name } : { id: cleanId });
  }
  return ok(models);
}

function validateWorkingDirectory(
  value: unknown,
): HarnessResult<{ workingDirectory: HarnessWorkingDirectory; customDirectory: string }> {
  if (value === undefined || value === null || value === "" || value === "project") {
    return ok({ workingDirectory: "project", customDirectory: "" });
  }
  if (value === "home") return ok({ workingDirectory: "home", customDirectory: "" });
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (isAbsoluteCommandPath(trimmed) || trimmed.startsWith("~/")) &&
      !CONTROL_RE.test(trimmed) &&
      !trimmed.split(/[\\/]/).includes("..")
    ) {
      return ok({ workingDirectory: "custom", customDirectory: trimmed });
    }
  }
  return fail('"workingDirectory" must be "project", "home" or an absolute folder.');
}

/**
 * Validate a driver config coming from Settings (already schema-decoded, but
 * the command/args still need the untrusted-input rules).
 */
export function validateHarnessConfig(config: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly workingDirectory: HarnessWorkingDirectory;
  readonly customDirectory: string;
  readonly installCommand: ReadonlyArray<string>;
  readonly detectCommand: ReadonlyArray<string>;
}): HarnessResult<null> {
  const executable = validateHarnessExecutable(config.command);
  if (!executable.ok) return executable;
  const args = validateHarnessArgs(config.args);
  if (!args.ok) return args;
  if (config.workingDirectory === "custom") {
    const dir = validateWorkingDirectory(config.customDirectory);
    if (!dir.ok) return dir;
  }
  for (const [label, argv] of [
    ["install", config.installCommand],
    ["detect", config.detectCommand],
  ] as const) {
    const checked = validateHarnessCommandLine(argv, label);
    if (!checked.ok) return checked;
  }
  return ok(null);
}

/**
 * Parse `~/.uno/harnesses/<id>.json`. `fileId` is the file name without
 * `.json`; unknown keys are ignored so newer files load in older builds.
 */
export function parseHarnessFile(fileId: string, raw: string): HarnessResult<ParsedHarnessFile> {
  if (!HARNESS_ID_PATTERN.test(fileId)) {
    return fail(
      "The file name must be a short lowercase id (letters, digits, - and _), e.g. kimi.json.",
    );
  }
  if (raw.length > HARNESS_FILE_MAX_BYTES) return fail("The file is larger than 32 KB.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return fail(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) return fail("The file must contain a JSON object.");

  const executable = validateHarnessExecutable(parsed["command"]);
  if (!executable.ok) return executable;
  const args = validateHarnessArgs(parsed["args"]);
  if (!args.ok) return args;
  const install = validateHarnessCommandLine(parsed["install"], "install");
  if (!install.ok) return install;
  const detect = validateHarnessCommandLine(parsed["detect"], "detect");
  if (!detect.ok) return detect;
  const models = validateModels(parsed["models"]);
  if (!models.ok) return models;
  const directory = validateWorkingDirectory(parsed["workingDirectory"]);
  if (!directory.ok) return directory;

  const env: Array<{ name: string; value: string }> = [];
  const rawEnv = parsed["env"];
  if (rawEnv !== undefined && rawEnv !== null) {
    if (!isRecord(rawEnv)) return fail('"env" must be an object of NAME: "value".');
    const entries = Object.entries(rawEnv);
    if (entries.length > MAX_ENV_VARS) return fail(`"env" has more than ${MAX_ENV_VARS} entries.`);
    for (const [name, value] of entries) {
      const checked = validateHarnessEnvName(name);
      if (!checked.ok) return checked;
      if (typeof value !== "string") {
        return fail(
          `"env.${name}" must be a string. For a secret, list the name in "secretEnv" and enter the value in Uno Work → Settings → Harnesses.`,
        );
      }
      if (value.length > MAX_ENV_VALUE_CHARS) return fail(`"env.${name}" is too long.`);
      if (value.includes("\u0000")) return fail(`"env.${name}" contains a NUL character.`);
      env.push({ name, value });
    }
  }

  const secretEnv: string[] = [];
  const rawSecrets = parsed["secretEnv"];
  if (rawSecrets !== undefined && rawSecrets !== null) {
    if (!Array.isArray(rawSecrets)) return fail('"secretEnv" must be a list of variable names.');
    for (const name of rawSecrets.slice(0, MAX_ENV_VARS)) {
      const checked = validateHarnessEnvName(name);
      if (!checked.ok) return checked;
      if (env.some((entry) => entry.name === checked.value)) {
        return fail(`"${checked.value}" is in both "env" and "secretEnv".`);
      }
      if (!secretEnv.includes(checked.value)) secretEnv.push(checked.value);
    }
  }

  const name = cleanHarnessText(parsed["name"], 40) || fileId;
  const authMethod = parsed["authMethod"] ?? parsed["authMethodId"];
  return ok({
    id: fileId,
    name,
    env,
    secretEnv,
    config: {
      enabled: parsed["enabled"] !== false,
      command: executable.value,
      args: args.value,
      workingDirectory: directory.value.workingDirectory,
      customDirectory: directory.value.customDirectory,
      installCommand: install.value,
      detectCommand: detect.value,
      models: models.value,
      authMethodId: cleanHarnessText(authMethod, 120),
      icon: cleanHarnessIcon(parsed["icon"]),
      description: cleanHarnessText(parsed["description"], 200),
      shareUnoGateway: parsed["shareUnoGateway"] === true,
      shareUnoAccount: parsed["shareUnoAccount"] === true,
    },
  });
}

/** Slug for a new Settings harness from its name: "Kimi Code" → "kimi-code". */
export function harnessIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length > 0 && /^[a-z]/.test(slug) ? slug : `agent-${slug || "custom"}`;
}
