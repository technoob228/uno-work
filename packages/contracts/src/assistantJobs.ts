/**
 * Assistants D (28.10): "What should it do?" — the answers of a new persona's
 * setup the web turns into its first message (`assistantJob.logic.ts`).
 *
 * Three jobs (Misha 28.10): leading development (projects / repos), working
 * in accounts (sign in in a browser, then a task once or on a schedule) and
 * helping with tasks through connectors or an MCP server of your own. Every
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

/** How often an accounts task runs: once now, every day, or one weekday. */
export const AssistantJobRepeat = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("once") }),
  Schema.Struct({
    kind: Schema.Literal("daily"),
    /** "HH:MM", 24 h, the person's own time zone. */
    time: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("weekly"),
    /** 0 = Sunday … 6 = Saturday (cron's numbering). */
    weekday: Schema.Number,
    time: TrimmedNonEmptyString,
  }),
]);
export type AssistantJobRepeat = typeof AssistantJobRepeat.Type;

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

export const AssistantJob = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("development"),
    /** Project names on its computer it leads. */
    projects: Schema.Array(TrimmedNonEmptyString),
    /** Repositories to clone first (owner/name or a URL). */
    repos: Schema.Array(TrimmedNonEmptyString),
    /** What to lead first, in the person's words. */
    task: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("accounts"),
    accounts: Schema.Array(AssistantJobAccount),
    task: Schema.String,
    repeat: AssistantJobRepeat,
  }),
  Schema.Struct({
    kind: Schema.Literal("tasks"),
    /** Connector names it was given ("Gmail & Calendar", "Notion"). */
    apps: Schema.Array(TrimmedNonEmptyString),
    /** MCP servers of the person's own, by name. */
    servers: Schema.Array(TrimmedNonEmptyString),
    task: Schema.String,
  }),
]);
export type AssistantJob = typeof AssistantJob.Type;
