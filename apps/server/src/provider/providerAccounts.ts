/**
 * A second Claude / ChatGPT account on one computer (Settings → AI → "Use more
 * than one account", off by default; upstream 560ddb14d9 + their provider
 * docs). An account is a provider instance with a sign-in folder of its own:
 *
 * - Claude: `CLAUDE_CONFIG_DIR=<folder>`, HOME untouched — changing HOME hides
 *   the Mac's Keychain; with this variable Claude Code keeps a Keychain item
 *   per folder ("Claude Code-credentials-<hash>"), `.credentials.json` in the
 *   folder elsewhere. Chats of one account can't resume on the other (the
 *   CLI's transcripts stay in the folder): "Continue with <account>" starts
 *   the other account fresh and carries the visible history over.
 * - ChatGPT: a shadow `CODEX_HOME` — `auth.json` in the folder, everything else
 *   linked to `~/.codex`, so the same chat goes on with its history.
 *
 * Tokens stay in the folder (or that Keychain item): settings hold only its
 * path, nothing about them reaches logs or the database.
 *
 * @module provider/providerAccounts
 */
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, rm, symlink } from "node:fs/promises";
import nodePath from "node:path";

import {
  type ProviderAuthDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";

export const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";
const ACCOUNTS_DIR_NAME = ".uno-accounts";
const PROVIDER_NAME: Readonly<Record<ProviderAuthDriver, string>> = {
  claudeAgent: "Claude",
  codex: "ChatGPT",
};

/**
 * What a second Claude account shares with the first: the person's skills,
 * commands and preferences. Never `.credentials.json` / `.claude.json` (who is
 * signed in) or `projects` (the transcripts, tied to the account's signatures).
 */
const CLAUDE_SHARED_ENTRIES = [
  "skills",
  "commands",
  "agents",
  "plugins",
  "hooks",
  "settings.json",
  "CLAUDE.md",
] as const;

export function accountsRoot(home: string): string {
  return nodePath.join(home, ACCOUNTS_DIR_NAME);
}

export function accountFolder(home: string, instanceId: ProviderInstanceId): string {
  return nodePath.join(accountsRoot(home), instanceId);
}

/** Only a direct child of the accounts folder is ever removed. */
export function isAccountFolder(home: string, folder: string): boolean {
  const relative = nodePath.relative(accountsRoot(home), nodePath.resolve(folder));
  return relative.length > 0 && !relative.includes(nodePath.sep) && !relative.startsWith("..");
}

export function newAccountInstanceId(driver: ProviderAuthDriver): ProviderInstanceId {
  return ProviderInstanceId.make(`${driver}_account_${randomBytes(4).toString("hex")}`);
}

export function accountDisplayName(driver: ProviderAuthDriver, name: string): string {
  return `${PROVIDER_NAME[driver]} · ${name.trim()}`;
}

/** The instance's own `CLAUDE_CONFIG_DIR`: the one set on it, not the daemon's. */
export function instanceClaudeConfigDir(
  environment: ProviderInstanceConfig["environment"],
): string | null {
  const value = environment?.find((entry) => entry.name === CLAUDE_CONFIG_DIR_ENV)?.value.trim();
  return value ? value : null;
}

/** The sign-in folder of a provider instance that has one of its own. */
export function accountFolderOf(instance: ProviderInstanceConfig): string | null {
  if (instance.driver === "claudeAgent") return instanceClaudeConfigDir(instance.environment);
  if (instance.driver === "codex") {
    const shadow = (instance.config as { readonly shadowHomePath?: unknown } | undefined)
      ?.shadowHomePath;
    return typeof shadow === "string" && shadow.trim().length > 0 ? shadow.trim() : null;
  }
  return null;
}

export function accountInstanceConfig(input: {
  readonly driver: ProviderAuthDriver;
  readonly name: string;
  readonly folder: string;
}): ProviderInstanceConfig {
  const base = {
    driver: ProviderDriverKind.make(input.driver),
    displayName: accountDisplayName(input.driver, input.name),
    enabled: true,
  };
  return input.driver === "claudeAgent"
    ? {
        ...base,
        environment: [{ name: CLAUDE_CONFIG_DIR_ENV, value: input.folder, sensitive: false }],
        config: {},
      }
    : { ...base, config: { shadowHomePath: input.folder } };
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/** The folder, private to the daemon's user; Claude's shared entries linked in. */
export async function prepareAccountFolder(input: {
  readonly driver: ProviderAuthDriver;
  readonly home: string;
  readonly folder: string;
  /** `~/.claude`: what a second Claude account shares with the first. */
  readonly claudeDir: string;
}): Promise<void> {
  await mkdir(accountsRoot(input.home), { recursive: true, mode: 0o700 });
  await chmod(accountsRoot(input.home), 0o700);
  await mkdir(input.folder, { recursive: true, mode: 0o700 });
  await chmod(input.folder, 0o700);
  if (input.driver !== "claudeAgent") return;
  for (const entry of CLAUDE_SHARED_ENTRIES) {
    const source = nodePath.join(input.claudeDir, entry);
    const target = nodePath.join(input.folder, entry);
    if ((await exists(source)) && !(await exists(target))) await symlink(source, target);
  }
}

/** Refuses anything but a folder this module made. Links inside aren't followed. */
export async function removeAccountFolder(home: string, folder: string): Promise<boolean> {
  if (!isAccountFolder(home, folder)) return false;
  await rm(nodePath.resolve(folder), { recursive: true, force: true });
  return true;
}
