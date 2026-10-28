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
  togglePart,
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

const NONE = { development: null, accounts: null, tasks: null, task: "" } as const;

describe("firstMessage", () => {
  it("accounts: signs in with the vault in a chat on its computer — never the password", () => {
    const text = firstMessage({
      ...BASE,
      job: { ...NONE, accounts: { accounts: [jobAccountOf(ROW)] }, task: "Post the weekly update" },
    });
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("leo@shop.example");
    expect(text).toContain("Hi Leo! You're my accounts manager.");
    expect(text).toContain("Your job: work in my accounts — Instagram (instagram.com).");
    expect(text).toContain('browser_command {"login": "instagram.com"}');
    expect(text).toContain("happen in a chat you start on uno-work, not in ours");
    expect(text).toContain("requestHelp");
    expect(text).toContain("First: Post the weekly update");
    expect(text).toContain("start a chat on uno-work for it (chat_create)");
    // Regular tasks are Automations, not the setup.
    expect(text).not.toContain("schedule_create");
    expect(text).not.toContain("cron");
  });
  it("only when I ask (the default): no first message at all", () => {
    const draft = emptyJob("accounts");
    expect(draft.start).toBe("ask");
    const job = { ...NONE, accounts: { accounts: [jobAccountOf(ROW)] } };
    expect(firstMessageOf(draft, job, BASE)).toBeNull();
    expect(firstMessageOf({ ...draft, start: "now" }, job, BASE)).toContain("Your job:");
  });
  it("development: projects and repos, handed to a chat", () => {
    const text = firstMessage({
      ...BASE,
      role: "Developer",
      job: { ...NONE, development: { projects: ["landing"], repos: ["acme/shop"] } },
    });
    expect(text).toContain("Your job: lead development of landing and acme/shop.");
    expect(text).toContain("Clone acme/shop on uno-work first");
    expect(text).toContain("where things stand");
    expect(text).toContain("Don't do the work yourself: start a chat on uno-work");
    expect(text).not.toContain("browser_command");
  });
  it("tasks: the apps it was given and the person's own tools", () => {
    const text = firstMessage({
      ...BASE,
      role: "",
      job: { ...NONE, tasks: { apps: ["Notion"], servers: ["crm"] }, task: "Sum up new mail" },
    });
    expect(text.startsWith("Hi Leo!\n\n")).toBe(true);
    expect(text).toContain("using Notion and crm (my own tool)");
    expect(text).toContain("First: Sum up new mail");
  });
  it("all three parts at once: one message with each of them", () => {
    const text = firstMessage({
      ...BASE,
      role: "Developer",
      job: {
        development: { projects: ["landing"], repos: [] },
        accounts: { accounts: [jobAccountOf(ROW)] },
        tasks: { apps: ["Notion"], servers: [] },
        task: "Ship the landing and post about it",
      },
    });
    expect(text).toContain(
      "Your job:\n- Lead development of landing.\n- Work in my accounts — Instagram (instagram.com).\n- Help me with tasks using Notion.",
    );
    expect(text).toContain('browser_command {"login": "instagram.com"}');
    expect(text).toContain("Those apps are connected on uno-work");
    expect(text).toContain("First: Ship the landing and post about it");
    expect(text).not.toContain(PASSWORD);
  });
});

describe("the step's draft", () => {
  const where = { environmentId: "env-cloud", computer: "uno-work" };
  const accountsOn = { ...EMPTY_JOB.on, development: false, accounts: true };
  it("the role only turns its own part on; the others can be turned on too", () => {
    expect(emptyJob("accounts").on).toEqual({ development: false, accounts: true, tasks: false });
    const all = togglePart(togglePart(emptyJob("accounts"), "development"), "tasks");
    expect(all.on).toEqual({ development: true, accounts: true, tasks: true });
    expect(togglePart(all, "accounts").on.accounts).toBe(false);
  });
  it("accounts need one saved on this computer (to start now)", () => {
    expect(jobProblem({ ...EMPTY_JOB, on: accountsOn, start: "now" }, where)).toBe(
      "Add at least one account, or turn Accounts off.",
    );
    expect(jobProblem({ ...EMPTY_JOB, on: accountsOn }, where)).toBeNull();
    expect(
      jobProblem(
        { ...EMPTY_JOB, on: accountsOn, accounts: [jobAccountOf(ROW)], accountsOn: "env-mac" },
        where,
      ),
    ).toContain("saved on another computer");
    expect(
      jobProblem(
        { ...EMPTY_JOB, on: accountsOn, accounts: [jobAccountOf(ROW)], accountsOn: "env-cloud" },
        where,
      ),
    ).toBeNull();
    // Off: no accounts needed.
    expect(jobProblem({ ...EMPTY_JOB, start: "now" }, where)).toBeNull();
  });
  it("repos: owner/name or a git address", () => {
    expect(
      parseRepos("acme/shop, https://github.com/acme/api.git\ngit@github.com:a/b.git"),
    ).toEqual({
      repos: ["acme/shop", "https://github.com/acme/api.git", "git@github.com:a/b.git"],
      bad: [],
    });
    expect(parseRepos("just-a-word").bad).toEqual(["just-a-word"]);
    expect(jobProblem({ ...EMPTY_JOB, repos: "oops" }, where)).toContain("isn't a repo address");
    // A part that's off doesn't hold the step.
    expect(
      jobProblem(
        { ...EMPTY_JOB, on: { ...EMPTY_JOB.on, development: false }, repos: "oops" },
        where,
      ),
    ).toBeNull();
  });
  it("only the parts that are on make the job", () => {
    expect(jobOf(emptyJob("development"), { apps: [], servers: [] })).toEqual({
      development: { projects: [], repos: [] },
      accounts: null,
      tasks: null,
      task: "",
    });
  });
  it("tasks: apps switched off are left out", () => {
    const job = jobOf(
      { ...emptyJob("tasks"), appsOff: ["gmail"] },
      {
        apps: [
          { provider: "gmail", name: "Gmail & Calendar" },
          { provider: "notion", name: "Notion" },
        ],
        servers: ["crm"],
      },
    );
    expect(job).toEqual({ ...NONE, tasks: { apps: ["Notion"], servers: ["crm"] } });
  });
  it("the duty line names every part and stays within the limit", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      ...jobAccountOf(ROW),
      service: `Instagram ${index}`,
    }));
    const duty = dutyOf({ ...NONE, accounts: { accounts: many } });
    expect(duty.length).toBeLessThanOrEqual(200);
    expect(duty.startsWith("Works in Instagram 0")).toBe(true);
    expect(
      dutyOf({
        ...NONE,
        development: { projects: ["landing"], repos: [] },
        tasks: { apps: ["Notion"], servers: [] },
      }),
    ).toBe("Leads development of landing; helps with tasks using Notion");
    expect(dutyOf(NONE)).toBe("Helps when you ask");
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
