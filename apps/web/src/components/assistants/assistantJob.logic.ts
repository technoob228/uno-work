/**
 * "What should it do?" (Misha 28.10) — the pure part: the three jobs of a new
 * assistant, the account form's checks, the schedule line and the first
 * message the assistant gets from the answers.
 *
 * Every assistant works like Uno: it answers fast and hands the real work —
 * code, edits, signing in and working in an account — to chats on the
 * person's computers, then tells the result. The first message asks for
 * exactly that.
 *
 * A password typed in the account form goes only to the vault of the
 * assistant's computer ({@link vaultInputOf}); nothing here puts it into a
 * message, a store or a log. The message names the site, and
 * `browser_command {login: "<site>"}` in the chat on that computer types the
 * saved password into the page itself.
 */
import {
  ASSISTANT_DUTY_MAX_CHARS,
  type AssistantJob,
  type AssistantJobAccount,
  type AssistantJobKind,
  type AssistantJobRepeat,
  type CredentialInput,
} from "@t3tools/contracts";

export const JOB_COPY: Readonly<
  Record<AssistantJobKind, { readonly title: string; readonly line: string }>
> = {
  development: {
    title: "Development",
    line: "Leads your projects and repos: plans, starts coding chats, reports.",
  },
  accounts: {
    title: "Accounts",
    line: "Works in your accounts — socials, shops, admin panels — signed in in a browser.",
  },
  tasks: {
    title: "Tasks",
    line: "Helps with mail, docs and notes through apps you connect.",
  },
};

/** What every assistant does with real work (the line under the question). */
export const HANDS_WORK_LINE =
  "It hands the work to chats on your computers and tells you the result.";

// ── Accounts ─────────────────────────────────────────────────────────────

/** One row of the account form while it is being filled (the password lives only here). */
export interface AccountDraft {
  readonly service: string;
  readonly site: string;
  readonly username: string;
  readonly password: string;
}

export const EMPTY_ACCOUNT: AccountDraft = { service: "", site: "", username: "", password: "" };

/** `https://www.Instagram.com/accounts/login` / `instagram.com` → `instagram.com`; null if not a site. */
export function siteOf(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return null;
  let host: string;
  try {
    host = new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  // A real host: letters/digits/dashes, at least one dot, a TLD of letters.
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host) ? host : null;
}

export interface AccountProblems {
  readonly service?: string;
  readonly site?: string;
  readonly username?: string;
  readonly password?: string;
}

/** What's wrong with one row, said plainly; empty when it can be saved. */
export function accountProblems(row: AccountDraft): AccountProblems {
  const out: { -readonly [K in keyof AccountProblems]: string } = {};
  if (row.service.trim().length === 0) out.service = "Name the account.";
  if (siteOf(row.site) === null) out.site = "Type the site, e.g. instagram.com.";
  if (row.username.trim().length === 0) out.username = "Type the login.";
  if (row.password.length === 0) out.password = "Type the password.";
  return out;
}

export function hasProblems(problems: AccountProblems): boolean {
  return Object.keys(problems).length > 0;
}

/** Rows the person started filling (a blank last row is just room for one more). */
export function filledAccounts(rows: ReadonlyArray<AccountDraft>): ReadonlyArray<AccountDraft> {
  return rows.filter(
    (row) =>
      row.service.trim() !== "" ||
      row.site.trim() !== "" ||
      row.username.trim() !== "" ||
      row.password !== "",
  );
}

/** The vault entry for a row — the only place the password goes. */
export function vaultInputOf(row: AccountDraft): CredentialInput {
  const site = siteOf(row.site) ?? row.site.trim();
  return {
    label: row.service.trim(),
    url: `https://${site}`,
    username: row.username.trim(),
    password: row.password,
  };
}

/** The account as the job keeps it: no password. */
export function jobAccountOf(row: AccountDraft): AssistantJobAccount {
  return {
    service: row.service.trim(),
    site: siteOf(row.site) ?? row.site.trim(),
    username: row.username.trim(),
  };
}

// ── Repeat ───────────────────────────────────────────────────────────────

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function hourMinute(time: string): readonly [number, number] | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? [hour, minute] : null;
}

/** Five-field cron of a repeat; null for "once" or a bad time. */
export function cronOf(repeat: AssistantJobRepeat): string | null {
  if (repeat.kind === "once") return null;
  const at = hourMinute(repeat.time);
  if (!at) return null;
  const [hour, minute] = at;
  if (repeat.kind === "daily") return `${minute} ${hour} * * *`;
  const day = Math.trunc(repeat.weekday);
  return day >= 0 && day <= 6 ? `${minute} ${hour} * * ${day}` : null;
}

/** "once", "every day at 09:00", "every Monday at 09:00". */
export function repeatLine(repeat: AssistantJobRepeat): string {
  if (repeat.kind === "once") return "once, now";
  const time = repeat.time.trim();
  if (repeat.kind === "daily") return `every day at ${time}`;
  return `every ${WEEKDAYS[repeat.weekday] ?? "week"} at ${time}`;
}

// ── The first message ────────────────────────────────────────────────────

export interface FirstMessageInput {
  readonly name: string;
  readonly role: string;
  /** Where its chats run: the label of its computer ("uno-work", "MacBook"). */
  readonly computer: string;
  /** The person's time zone for a schedule (IANA). */
  readonly timeZone: string;
  readonly job: AssistantJob;
}

function list(items: ReadonlyArray<string>): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * The first message to a new assistant, from the answers: who it is, the job,
 * and that the work goes to chats on its computer. Never a password — the
 * account rows here carry none.
 */
export function firstMessage(input: FirstMessageInput): string {
  const { job, computer } = input;
  const role = input.role.trim();
  const hello = role ? `Hi ${input.name}! You're my ${role.toLowerCase()}.` : `Hi ${input.name}!`;
  const handOff = `Don't do the work yourself: start a chat on ${computer} for it (chat_create), keep an eye on it, and tell me the result in a few lines.`;
  const task = job.task.trim();

  if (job.kind === "development") {
    const what = list([...job.projects, ...job.repos]);
    const lines = [
      hello,
      what
        ? `Your job: lead development of ${what}.`
        : "Your job: lead development of my projects.",
    ];
    if (job.repos.length > 0) {
      lines.push(`Clone ${list(job.repos)} on ${computer} first if it isn't there yet.`);
    }
    lines.push(
      task
        ? `First: ${task}`
        : `First: look at ${what || "them"} and tell me in a few lines where things stand.`,
      handOff,
    );
    return lines.join("\n\n");
  }

  if (job.kind === "accounts") {
    const sites = job.accounts.map((account) => `${account.service} (${account.site})`);
    const logins = job.accounts.map(
      (account) => `browser_command {"login": "${account.site}"} for ${account.service}`,
    );
    const cron = cronOf(job.repeat);
    const lines = [
      hello,
      `Your job: work in my accounts — ${list(sites)}.`,
      `Their passwords are saved in the password vault on ${computer}. Never ask me for a password in chat.`,
      `Start a chat on ${computer} for this (chat_create) — signing in and the work happen there, not in our chat. In that chat, sign in with ${list(logins)} — it types the saved password itself. If a site asks for a 2FA code or a captcha, ask me with requestHelp and wait for me.`,
      task ? `Then: ${task}` : "Then: tell me what you see there and what you'd do first.",
    ];
    if (cron) {
      lines.push(
        `Do it now, then make it regular — ${repeatLine(job.repeat)} (${input.timeZone}): create a schedule with schedule_create, cron "${cron}", timezone "${input.timeZone}", that does the same and tells me the result.`,
      );
    } else {
      lines.push("This is a one-time task: do it now and tell me the result.");
    }
    return lines.join("\n\n");
  }

  const tools = list([...job.apps, ...job.servers.map((server) => `${server} (my own tool)`)]);
  return [
    hello,
    tools
      ? `Your job: help me with tasks using ${tools}. They're connected on ${computer}; the chats you start there can use them.`
      : "Your job: help me with everyday tasks.",
    task ? `First: ${task}` : "First: tell me in two lines what you can do for me with them.",
    handOff,
  ].join("\n\n");
}

/** The standing duty saved on its page (what it does, in one line). */
export function dutyOf(job: AssistantJob): string {
  return dutyText(job).slice(0, ASSISTANT_DUTY_MAX_CHARS);
}

function dutyText(job: AssistantJob): string {
  if (job.kind === "development") {
    const what = list([...job.projects, ...job.repos]);
    return what ? `Leads development of ${what}` : "Leads development";
  }
  if (job.kind === "accounts") {
    const services = list(job.accounts.map((account) => account.service));
    const task = job.task.trim();
    const when = job.repeat.kind === "once" ? "" : ` · ${repeatLine(job.repeat)}`;
    return `Works in ${services}${task ? `: ${task}` : ""}${when}`;
  }
  const tools = list([...job.apps, ...job.servers]);
  return tools ? `Helps with tasks using ${tools}` : "Helps with tasks";
}

// ── The step's draft ─────────────────────────────────────────────────────

/** "What should it do?" while it's being answered (no passwords: they went to the vault). */
export interface JobDraft {
  readonly kind: AssistantJobKind | null;
  /** Development: project names it leads. */
  readonly devProjects: ReadonlyArray<string>;
  /** Development: repos to clone, as typed (comma / space / line separated). */
  readonly repos: string;
  readonly task: string;
  /** Accounts: the logins saved for it (site and login only). */
  readonly accounts: ReadonlyArray<AssistantJobAccount>;
  /** The computer those logins were saved on. */
  readonly accountsOn: string | null;
  readonly repeat: AssistantJobRepeat;
  /** Tasks: connected apps it should NOT use (provider ids). */
  readonly appsOff: ReadonlyArray<string>;
}

export const EMPTY_JOB: JobDraft = {
  kind: null,
  devProjects: [],
  repos: "",
  task: "",
  accounts: [],
  accountsOn: null,
  repeat: { kind: "once" },
  appsOff: [],
};

/** `owner/name`, `github.com/owner/name` or an https/ssh git address. */
export function parseRepos(text: string): {
  readonly repos: ReadonlyArray<string>;
  readonly bad: ReadonlyArray<string>;
} {
  const repos: string[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const item = raw.trim().replace(/\/+$/, "");
    if (!item) continue;
    const ok =
      /^[\w.-]+\/[\w.-]+$/.test(item) ||
      /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}\/[\w.-]+\/[\w.-]+(\.git)?$/i.test(item) ||
      /^git@[\w.-]+:[\w.-]+\/[\w.-]+(\.git)?$/.test(item);
    (ok ? repos : bad).push(item);
  }
  return { repos: [...new Set(repos)], bad };
}

/** Why the step can't finish yet, said plainly; null when it can. */
export function jobProblem(
  draft: JobDraft,
  input: { readonly environmentId: string; readonly computer: string },
): string | null {
  if (draft.kind === "development") {
    const { bad } = parseRepos(draft.repos);
    if (bad.length > 0) return `“${bad[0]}” isn't a repo address. Use owner/name or a git URL.`;
    return null;
  }
  if (draft.kind === "accounts") {
    if (draft.accounts.length === 0) return "Add at least one account.";
    if (draft.accountsOn !== null && draft.accountsOn !== input.environmentId) {
      return `Those logins are saved on another computer. Add them again for ${input.computer}.`;
    }
    if (draft.repeat.kind !== "once" && cronOf(draft.repeat) === null) {
      return "Pick a time like 09:00.";
    }
    return null;
  }
  return null;
}

/** The job from the draft (null: no job picked — it just greets). */
export function jobOf(
  draft: JobDraft,
  tools: {
    /** Connected apps on its computer: provider id → name. */
    readonly apps: ReadonlyArray<{ readonly provider: string; readonly name: string }>;
    readonly servers: ReadonlyArray<string>;
  },
): AssistantJob | null {
  switch (draft.kind) {
    case "development":
      return {
        kind: "development",
        projects: draft.devProjects,
        repos: parseRepos(draft.repos).repos,
        task: draft.task,
      };
    case "accounts":
      return { kind: "accounts", accounts: draft.accounts, task: draft.task, repeat: draft.repeat };
    case "tasks":
      return {
        kind: "tasks",
        apps: tools.apps
          .filter((app) => !draft.appsOff.includes(app.provider))
          .map((app) => app.name),
        servers: tools.servers,
        task: draft.task,
      };
    default:
      return null;
  }
}
