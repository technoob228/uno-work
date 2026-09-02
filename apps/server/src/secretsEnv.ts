/**
 * secretsEnv - Pure helpers for the agent-initiated secret request flow.
 *
 * The agent asks for a credential by env-var name; the user pastes the value
 * into a masked input in the app; the server upserts it into the project's
 * env file. These helpers validate what the agent may ask for and produce the
 * updated file content.
 */

export const SECRET_REQUEST_PATH = "/api/secrets/request";
export const SECRET_RESULT_PATH = "/api/secrets/result";

export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Only dotenv-style files at the project root — no paths, no arbitrary targets. */
export const SECRET_TARGET_FILE_PATTERN = /^\.env(\.[A-Za-z0-9_-]{1,32})*$/;

export const SECRET_VALUE_MAX_LENGTH = 65_536;
export const SECRET_DESCRIPTION_MAX_LENGTH = 2_000;

export const isValidSecretName = (value: unknown): value is string =>
  typeof value === "string" && SECRET_NAME_PATTERN.test(value);

export const isValidSecretTargetFile = (value: unknown): value is string =>
  typeof value === "string" && SECRET_TARGET_FILE_PATTERN.test(value);

/**
 * Values made of plain token characters stay raw; anything else is wrapped in
 * double quotes with `\\`, `"` and newlines escaped (the dotenv double-quote
 * dialect).
 */
export const formatEnvValue = (value: string): string => {
  if (/^[A-Za-z0-9_@.,:/+=-]*$/.test(value)) {
    return value;
  }
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
};

/**
 * Replaces the first active `NAME=`/`export NAME=` line (commented lines are
 * left alone) or appends the assignment at the end. Always returns content
 * with a trailing newline.
 */
export const upsertEnvContent = (content: string, name: string, value: string): string => {
  const assignment = `${name}=${formatEnvValue(value)}`;
  const lines = content.length === 0 ? [] : content.split("\n");
  const linePattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (!replaced && linePattern.test(line)) {
      replaced = true;
      return assignment;
    }
    return line;
  });
  if (!replaced) {
    while (nextLines.length > 0 && nextLines[nextLines.length - 1]?.trim() === "") {
      nextLines.pop();
    }
    nextLines.push(assignment);
  }
  const next = nextLines.join("\n");
  return next.endsWith("\n") ? next : `${next}\n`;
};
