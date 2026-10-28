/**
 * Assistants D (28.10): "What should it do?" — the answers of a new persona's
 * setup the web turns into its first message (`assistantJob.logic.ts`).
 *
 * Three parts, any of them together (Misha 28.10): development (projects /
 * repos it leads), accounts (it signs in through a browser) and tasks
 * (connectors or an MCP server of your own). The role picked in the gallery
 * (Developer / Accounts manager / Helper) only turns its part on first. It
 * starts only when asked, or at once with a first task — regular
 * tasks are a separate feature (Automations), not part of the setup. Every
 * assistant hands the real work to chats on the person's computers and tells
 * the result — the first message asks for that, never "do it yourself".
 *
 * Passwords are NOT part of these answers: the account form saves them into
 * the credentials vault of the assistant's computer (`vault.upsert`) and the
 * job only names the site; `browser_command {login: "<site>"}` there types
 * the password into the page without the model seeing it.
 *
 * @module AssistantJobs
 */
import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AssistantJobKind = Schema.Literals(["development", "accounts", "tasks"]);
export type AssistantJobKind = typeof AssistantJobKind.Type;

/** One account it works in, without the password (that one is in the vault). */
export const AssistantJobAccount = Schema.Struct({
  /** What the person calls it: "Instagram", "X", "our shop admin". */
  service: TrimmedNonEmptyString,
  /** Where to sign in: a domain or https:// address. */
  site: TrimmedNonEmptyString,
  /** The login (email / username) — stored in the vault entry, not in the chat. */
  username: TrimmedNonEmptyString,
});
export type AssistantJobAccount = typeof AssistantJobAccount.Type;

/** Development: projects it leads and repos to clone first. */
export const AssistantJobDevelopment = Schema.Struct({
  /** Project names on its computer it leads. */
  projects: Schema.Array(TrimmedNonEmptyString),
  /** Repositories to clone first (owner/name or a URL). */
  repos: Schema.Array(TrimmedNonEmptyString),
});
export type AssistantJobDevelopment = typeof AssistantJobDevelopment.Type;

/** Accounts: where it signs in (the passwords are in the vault). */
export const AssistantJobAccounts = Schema.Struct({
  accounts: Schema.Array(AssistantJobAccount),
});
export type AssistantJobAccounts = typeof AssistantJobAccounts.Type;

/** Tasks: the connected apps and own MCP servers it uses. */
export const AssistantJobTasks = Schema.Struct({
  /** Connector names it was given ("Gmail & Calendar", "Notion"). */
  apps: Schema.Array(TrimmedNonEmptyString),
  /** MCP servers of the person's own, by name. */
  servers: Schema.Array(TrimmedNonEmptyString),
});
export type AssistantJobTasks = typeof AssistantJobTasks.Type;

/** What it does: each part on (an object) or off (null), plus the first task. */
export const AssistantJob = Schema.Struct({
  development: Schema.NullOr(AssistantJobDevelopment),
  accounts: Schema.NullOr(AssistantJobAccounts),
  tasks: Schema.NullOr(AssistantJobTasks),
  /** What to do first, in the person's words ("" — it asks what's first). */
  task: Schema.String,
});
export type AssistantJob = typeof AssistantJob.Type;
