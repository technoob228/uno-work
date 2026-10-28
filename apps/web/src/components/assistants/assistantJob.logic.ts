/**
 * "What should it do?" (Misha 28.10) — the pure part: the three parts of a
 * new assistant's job (development, accounts, tasks — any of them together;
 * the role only turns its own part on first), the account form's checks and
 * the first message the assistant gets from the answers.
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
    line: "Works in your accounts — socials, shops, admin panels — signed in through a browser.",
  },
  tasks: {
    title: "Tasks",
    line: "Helps with mail, docs and notes through apps you connect or your own MCP server.",
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

// ── The first message ────────────────────────────────────────────────────

export interface FirstMessageInput {
  readonly name: string;
  readonly role: string;
  /** Where its chats run: the label of its computer ("uno-work", "MacBook"). */
  readonly computer: string;
  readonly job: AssistantJob;
}

function list(items: ReadonlyArray<string>): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Each part that's on, as "what it does" — in the order of the step. */
function jobLines(job: AssistantJob): ReadonlyArray<string> {
  const lines: string[] = [];
  if (job.development) {
    const what = list([...job.development.projects, ...job.development.repos]);
    lines.push(what ? `lead development of ${what}` : "lead development of my projects");
  }
  if (job.accounts) {
    const sites = job.accounts.accounts.map((account) => `${account.service} (${account.site})`);
    lines.push(sites.length > 0 ? `work in my accounts — ${list(sites)}` : "work in my accounts");
  }
  if (job.tasks) {
    const tools = list([
      ...job.tasks.apps,
      ...job.tasks.servers.map((server) => `${server} (my own tool)`),
    ]);
    lines.push(tools ? `help me with tasks using ${tools}` : "help me with everyday tasks");
  }
  return lines;
}

/**
 * The first message to a new assistant, from the answers: who it is, every
 * part of the job that's on, and that the work goes to chats on its computer.
 * Never a password — the account rows here carry none.
 */
export function firstMessage(input: FirstMessageInput): string {
  const { job, computer } = input;
  const role = input.role.trim();
  const hello = role ? `Hi ${input.name}! You're my ${role.toLowerCase()}.` : `Hi ${input.name}!`;
  const parts = jobLines(job);
  const lines = [hello];
  if (parts.length === 1) lines.push(`Your job: ${parts[0]}.`);
  else if (parts.length > 1) {
    lines.push(
      `Your job:\n${parts.map((part) => `- ${part[0]!.toUpperCase()}${part.slice(1)}.`).join("\n")}`,
    );
  }

  if (job.development && job.development.repos.length > 0) {
    lines.push(`Clone ${list(job.development.repos)} on ${computer} first if it isn't there yet.`);
  }
  if (job.accounts && job.accounts.accounts.length > 0) {
    const logins = job.accounts.accounts.map(
      (account) => `browser_command {"login": "${account.site}"} for ${account.service}`,
    );
    lines.push(
      `Their passwords are saved in the password vault on ${computer}. Never ask me for a password in chat.`,
      `Signing in and the work in those accounts happen in a chat you start on ${computer}, not in ours. There, sign in with ${list(logins)} — it types the saved password itself. If a site asks for a 2FA code or a captcha, ask me with requestHelp and wait for me.`,
    );
  }
  if (job.tasks && job.tasks.apps.length + job.tasks.servers.length > 0) {
    lines.push(`Those apps are connected on ${computer}; the chats you start there can use them.`);
  }

  const task = job.task.trim();
  lines.push(
    task
      ? `First: ${task}`
      : "First: look around and tell me in a few lines where things stand and what you'd do first.",
    `Don't do the work yourself: start a chat on ${computer} for it (chat_create), keep an eye on it, and tell me the result in a few lines.`,
  );
  return lines.join("\n\n");
}

/** The standing duty saved on its page (what it does, in one line). */
export function dutyOf(job: AssistantJob): string {
  return dutyText(job).slice(0, ASSISTANT_DUTY_MAX_CHARS);
}

function dutyText(job: AssistantJob): string {
  const parts: string[] = [];
  if (job.development) {
    const what = list([...job.development.projects, ...job.development.repos]);
    parts.push(what ? `Leads development of ${what}` : "Leads development");
  }
  if (job.accounts) {
    const services = list(job.accounts.accounts.map((account) => account.service));
    const sites = list(job.accounts.accounts.map((account) => account.site));
    parts.push(
      services
        ? `Works in ${services} (${sites}), signed in from the vault in a chat it starts`
        : "Works in your accounts, signed in from the vault in a chat it starts",
    );
  }
  if (job.tasks) {
    const tools = list([...job.tasks.apps, ...job.tasks.servers]);
    parts.push(tools ? `Helps with tasks using ${tools}` : "Helps with tasks");
  }
  if (parts.length === 0) return "Helps when you ask";
  return parts
    .map((part, index) => (index === 0 ? part : `${part[0]!.toLowerCase()}${part.slice(1)}`))
    .join("; ");
}

// ── The step's draft ─────────────────────────────────────────────────────

/** "What should it do?" while it's being answered (no passwords: they went to the vault). */
export interface JobDraft {
  /** The parts that are on — any of the three; the role turns its own on first. */
  readonly on: Readonly<Record<AssistantJobKind, boolean>>;
  /**
   * "ask" (default): it's made and waits for your message; "now": the first
   * message with the task goes at once. Regular tasks are Automations, later.
   */
  readonly start: JobStart;
  /** Development: project names it leads. */
  readonly devProjects: ReadonlyArray<string>;
  /** Development: repos to clone, as typed (comma / space / line separated). */
  readonly repos: string;
  readonly task: string;
  /** Accounts: the logins saved for it (site and login only). */
  readonly accounts: ReadonlyArray<AssistantJobAccount>;
  /** The computer those logins were saved on. */
  readonly accountsOn: string | null;
  /** Tasks: connected apps it should NOT use (provider ids). */
  readonly appsOff: ReadonlyArray<string>;
}

export const JOB_KINDS: ReadonlyArray<AssistantJobKind> = ["development", "accounts", "tasks"];

export type JobStart = "ask" | "now";

export const START_COPY: Readonly<
  Record<JobStart, { readonly label: string; readonly line: string }>
> = {
  ask: { label: "Only when I ask", line: "It's made and waits for your message." },
  now: { label: "Start now", line: "It gets the task below right away." },
};

/** The step's starting answers for a role: its own part on, the rest off. */
export function emptyJob(kind: AssistantJobKind): JobDraft {
  return {
    on: {
      development: kind === "development",
      accounts: kind === "accounts",
      tasks: kind === "tasks",
    },
    start: "ask",
    devProjects: [],
    repos: "",
    task: "",
    accounts: [],
    accountsOn: null,
    appsOff: [],
  };
}

/** Turns one part on or off; what was filled in it stays for when it's back on. */
export function togglePart(draft: JobDraft, kind: AssistantJobKind): JobDraft {
  return { ...draft, on: { ...draft.on, [kind]: !draft.on[kind] } };
}

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

/** Why the step can't finish yet, said plainly; null when it can. Off parts don't count. */
export function jobProblem(
  draft: JobDraft,
  input: { readonly environmentId: string; readonly computer: string },
): string | null {
  if (draft.on.development) {
    const { bad } = parseRepos(draft.repos);
    if (bad.length > 0) return `“${bad[0]}” isn't a repo address. Use owner/name or a git URL.`;
  }
  if (draft.on.accounts) {
    // To start now it needs one; "only when I ask" can wait for them.
    if (draft.accounts.length === 0) {
      if (draft.start === "now") return "Add at least one account, or turn Accounts off.";
    } else if (draft.accountsOn !== null && draft.accountsOn !== input.environmentId) {
      return `Those logins are saved on another computer. Add them again for ${input.computer}.`;
    }
  }
  return null;
}

/** The job from the draft: the parts that are on. */
export function jobOf(
  draft: JobDraft,
  tools: {
    /** Connected apps on its computer: provider id → name. */
    readonly apps: ReadonlyArray<{ readonly provider: string; readonly name: string }>;
    readonly servers: ReadonlyArray<string>;
  },
): AssistantJob {
  return {
    development: draft.on.development
      ? { projects: draft.devProjects, repos: parseRepos(draft.repos).repos }
      : null,
    accounts: draft.on.accounts ? { accounts: draft.accounts } : null,
    tasks: draft.on.tasks
      ? {
          apps: tools.apps
            .filter((app) => !draft.appsOff.includes(app.provider))
            .map((app) => app.name),
          servers: tools.servers,
        }
      : null,
    task: draft.task,
  };
}

/** The first message, only when the person said "Start now" (else it waits for them). */
export function firstMessageOf(
  draft: JobDraft,
  job: AssistantJob,
  input: Omit<FirstMessageInput, "job">,
): string | null {
  return draft.start === "now" ? firstMessage({ ...input, job }) : null;
}
