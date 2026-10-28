import { describe, expect, it } from "vitest";

import {
  EMPTY_ACCOUNT,
  type AccountDraft,
  accountProblems,
  dutyOf,
  emptyJob,
  filledAccounts,
  firstMessage,
  firstMessageOf,
  hasProblems,
  jobAccountOf,
  jobOf,
  jobProblem,
  parseRepos,
  siteOf,
  vaultInputOf,
} from "./assistantJob.logic";
import { isAsleep, personaWorksOn } from "./personaChannels";

const PASSWORD = "Sup3r-Secret-Pa55!";
const ROW: AccountDraft = {
  service: "Instagram",
  site: "https://www.Instagram.com/accounts/login",
  username: "leo@shop.example",
  password: PASSWORD,
};
const BASE = { name: "Leo", role: "Accounts manager", computer: "uno-work" };
const EMPTY_JOB = emptyJob("development");

describe("siteOf", () => {
  it("keeps the host of an address or a domain", () => {
    expect(siteOf("https://www.Instagram.com/accounts/login")).toBe("instagram.com");
    expect(siteOf("x.com")).toBe("x.com");
    expect(siteOf("  shop.example.co.uk/admin ")).toBe("shop.example.co.uk");
  });
  it("is null for something that isn't a site", () => {
    expect(siteOf("")).toBeNull();
    expect(siteOf("my instagram")).toBeNull();
    expect(siteOf("localhost")).toBeNull();
  });
});

describe("the account form", () => {
  it("an empty password can't be saved", () => {
    const problems = accountProblems({ ...ROW, password: "" });
    expect(problems.password).toBe("Type the password.");
    expect(hasProblems(problems)).toBe(true);
  });
  it("a full row has no problems", () => {
    expect(hasProblems(accountProblems(ROW))).toBe(false);
  });
  it("names every missing field", () => {
    expect(Object.keys(accountProblems({ ...EMPTY_ACCOUNT, site: "nope" })).toSorted()).toEqual([
      "password",
      "service",
      "site",
      "username",
    ]);
  });
  it("a blank row is just room for another one", () => {
    expect(filledAccounts([ROW, EMPTY_ACCOUNT])).toEqual([ROW]);
  });
  it("the password goes to the vault entry only", () => {
    expect(vaultInputOf(ROW)).toEqual({
      label: "Instagram",
      url: "https://instagram.com",
      username: "leo@shop.example",
      password: PASSWORD,
    });
    const kept = jobAccountOf(ROW);
    expect(kept).toEqual({
      service: "Instagram",
      site: "instagram.com",
      username: "leo@shop.example",
    });
    expect(JSON.stringify(kept)).not.toContain(PASSWORD);
  });
});

describe("firstMessage", () => {
  it("accounts: signs in with the vault in a chat on its computer — never the password", () => {
    const text = firstMessage({
      ...BASE,
      job: {
        kind: "accounts",
        accounts: [jobAccountOf(ROW)],
        task: "Post the weekly update",
      },
    });
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("leo@shop.example");
    expect(text).toContain("Hi Leo! You're my accounts manager.");
    expect(text).toContain('browser_command {"login": "instagram.com"}');
    expect(text).toContain("Start a chat on uno-work for this (chat_create)");
    expect(text).toContain("requestHelp");
    expect(text).toContain("Then: Post the weekly update");
    // Regular tasks are Automations, not the setup.
    expect(text).not.toContain("schedule_create");
    expect(text).not.toContain("cron");
  });
  it("only when I ask (the default): no first message at all", () => {
    const draft = emptyJob("accounts");
    expect(draft.start).toBe("ask");
    const job = { kind: "accounts" as const, accounts: [jobAccountOf(ROW)], task: "" };
    expect(firstMessageOf(draft, job, BASE)).toBeNull();
    expect(firstMessageOf({ ...draft, start: "now" }, job, BASE)).toContain("Your job:");
  });
  it("development: projects and repos, handed to a chat", () => {
    const text = firstMessage({
      ...BASE,
      role: "Developer",
      job: { kind: "development", projects: ["landing"], repos: ["acme/shop"], task: "" },
    });
    expect(text).toContain("Your job: lead development of landing and acme/shop.");
    expect(text).toContain("Clone acme/shop on uno-work first");
    expect(text).toContain("tell me in a few lines where things stand");
    expect(text).toContain("Don't do the work yourself: start a chat on uno-work");
  });
  it("tasks: the apps it was given and the person's own tools", () => {
    const text = firstMessage({
      ...BASE,
      role: "",
      job: { kind: "tasks", apps: ["Notion"], servers: ["crm"], task: "Sum up new mail" },
    });
    expect(text.startsWith("Hi Leo!\n\n")).toBe(true);
    expect(text).toContain("using Notion and crm (my own tool)");
    expect(text).toContain("First: Sum up new mail");
  });
});

describe("the step's draft", () => {
  const where = { environmentId: "env-cloud", computer: "uno-work" };
  it("accounts need one saved on this computer", () => {
    expect(jobProblem({ ...EMPTY_JOB, kind: "accounts", start: "now" }, where)).toBe(
      "Add at least one account.",
    );
    expect(jobProblem({ ...EMPTY_JOB, kind: "accounts" }, where)).toBeNull();
    expect(
      jobProblem(
        { ...EMPTY_JOB, kind: "accounts", accounts: [jobAccountOf(ROW)], accountsOn: "env-mac" },
        where,
      ),
    ).toContain("saved on another computer");
    expect(
      jobProblem(
        {
          ...EMPTY_JOB,
          kind: "accounts",
          accounts: [jobAccountOf(ROW)],
          accountsOn: "env-cloud",
        },
        where,
      ),
    ).toBeNull();
  });
  it("repos: owner/name or a git address", () => {
    expect(
      parseRepos("acme/shop, https://github.com/acme/api.git\ngit@github.com:a/b.git"),
    ).toEqual({
      repos: ["acme/shop", "https://github.com/acme/api.git", "git@github.com:a/b.git"],
      bad: [],
    });
    expect(parseRepos("just-a-word").bad).toEqual(["just-a-word"]);
    expect(jobProblem({ ...EMPTY_JOB, kind: "development", repos: "oops" }, where)).toContain(
      "isn't a repo address",
    );
  });
  it("the role decides the job", () => {
    expect(jobOf(emptyJob("development"), { apps: [], servers: [] })).toEqual({
      kind: "development",
      projects: [],
      repos: [],
      task: "",
    });
  });
  it("tasks: apps switched off are left out", () => {
    const job = jobOf(
      { ...EMPTY_JOB, kind: "tasks", appsOff: ["gmail"] },
      {
        apps: [
          { provider: "gmail", name: "Gmail & Calendar" },
          { provider: "notion", name: "Notion" },
        ],
        servers: ["crm"],
      },
    );
    expect(job).toEqual({ kind: "tasks", apps: ["Notion"], servers: ["crm"], task: "" });
  });
  it("the duty line stays within the limit", () => {
    const duty = dutyOf({
      kind: "accounts",
      accounts: [jobAccountOf(ROW)],
      task: "x".repeat(400),
    });
    expect(duty.length).toBeLessThanOrEqual(200);
    expect(duty.startsWith("Works in Instagram (instagram.com), signed in from the vault")).toBe(
      true,
    );
  });
});

describe("where it works", () => {
  const machines = [
    { environmentId: "env-cloud", boxId: 1, label: "uno-work", kind: "uno_box", status: "online" },
    { environmentId: "env-mac", label: "MacBook", kind: "computer", status: "online" },
    { environmentId: "env-2", boxId: 2, label: "uno-product", kind: "uno_box", status: "online" },
    { environmentId: null, boxId: 3, label: "free-cloud", kind: "uno_box", status: "sleeping" },
  ];
  it("its home, other cloud computers, a computer of its own", () => {
    const options = personaWorksOn({ homeEnvironmentId: "env-cloud", machines });
    expect(options.map((option) => [option.kind, option.target, option.why])).toEqual([
      ["here", "env-cloud", null],
      ["cloud", "env-2", null],
      ["cloud", null, "Open it in Uno Work once, then assistants can move there."],
      ["own", null, null],
    ]);
  });
  it("an asleep home can't take it", () => {
    const options = personaWorksOn({
      homeEnvironmentId: "env-cloud",
      machines: machines.map((machine) =>
        machine.environmentId === "env-cloud" ? { ...machine, status: "sleeping" } : machine,
      ),
    });
    expect(options[0]?.why).toBe("uno-work is asleep — wake it first.");
    expect(isAsleep("offline")).toBe(true);
    expect(isAsleep("unknown")).toBe(false);
  });
  it("a laptop home is marked as one", () => {
    const options = personaWorksOn({ homeEnvironmentId: "env-mac", machines });
    expect(options[0]?.laptop).toBe(true);
    expect(personaWorksOn({ homeEnvironmentId: null, machines })).toEqual([]);
  });
});

describe("the gallery", () => {
  it("three roles, each with its job", async () => {
    const { GALLERY } = await import("./personaChannels");
    expect(GALLERY.map((persona) => [persona.role, persona.job])).toEqual([
      ["Developer", "development"],
      ["Accounts manager", "accounts"],
      ["Helper", "tasks"],
    ]);
  });
});
