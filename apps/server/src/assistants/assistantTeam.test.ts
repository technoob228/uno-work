import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ASSISTANT_ASK_REQUEST_PREFIX,
  ASSISTANT_PROJECT_ID,
  assistantTokenLabel,
  ManagerTokenId,
  ProjectId,
  ThreadId,
  type AssistantPreset,
  type ManagerProjectAllowlist,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { InboxPost } from "../inbox/inboxModel.ts";
import type { ManagerCaller } from "../manager/Services/ManagerToolService.ts";
import { askCardAnswerText, findAskCardQuestion, isAskCardRequest } from "./askCards.ts";
import {
  makeAssistantTeam,
  parseRevokedAccess,
  setupKickoffText,
  type AssistantTeamDeps,
} from "./assistantTeam.ts";
import { readAppAccess, writeAppAccess } from "./localAssistantStore.ts";
import { normalizeTeam, readTeam, updateTeam, withSetupStep } from "./teamStore.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "uno-assistant-team-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const UNO = ProjectId.make(ASSISTANT_PROJECT_ID);
const SCOUT = ProjectId.make("assistant-scout");

const callerOf = (projectId: string, threadId?: string): ManagerCaller => ({
  tokenId: ManagerTokenId.make(`token-${projectId}`),
  scopes: ["threads:read", "threads:write", "threads:approve"],
  projectAllowlist: "all",
  budget: null,
  autoApprove: true,
  label: assistantTokenLabel(projectId),
  ...(threadId !== undefined ? { callerThreadId: ThreadId.make(threadId) } : {}),
});

/** A computer with Uno and the person's projects; everything recorded. */
function stand(
  options: {
    readonly routines?: boolean;
    readonly sandbox?: boolean;
    /** The person's answer when an "Asks first" assistant asks (default: Allow). */
    readonly answer?: "approved" | "denied" | "timeout" | "queued";
  } = {},
) {
  const stateDir = tempDir();
  const assistants = new Map<string, string>([[UNO, "Assistant"]]);
  const access = new Map<string, { preset: AssistantPreset; allowlist: ManagerProjectAllowlist }>();
  const inbox: InboxPost[] = [];
  const turns: Array<{ threadId: string; text: string; system: boolean }> = [];
  const cards: Array<{ threadId: string; requestId: string; question: UserInputQuestion }> = [];
  const deleted: string[] = [];
  const conversations: Array<{ projectId: string; title: string; threadId: string }> = [];
  const routines: unknown[] = [];
  const asked: Array<{ title: string; detail: string; threadId: string | null }> = [];
  let tick = 0;
  const deps: AssistantTeamDeps = {
    stateDir,
    now: () => new Date(Date.UTC(2026, 9, 22, 10, 0, tick++)),
    listAssistants: () =>
      Effect.succeed(
        [...assistants].map(([projectId, title]) => ({
          projectId: ProjectId.make(projectId),
          title,
        })),
      ),
    listProjects: () =>
      Effect.succeed([
        { id: "p-landing", title: "landing" },
        { id: "p-fishcode", title: "fishcode" },
      ]),
    readAccess: (projectId) =>
      Effect.succeed(access.get(projectId) ?? { preset: "full", allowlist: "all" }),
    writeAccess: (projectId, preset, projects) =>
      Effect.sync(() => {
        access.set(projectId, {
          preset,
          allowlist: (projects === "all" ? "all" : [projectId, ...projects]) as never,
        });
      }),
    createAssistant: (input) =>
      Effect.sync(() => {
        const projectId = ProjectId.make(`assistant-${input.name.toLowerCase()}`);
        assistants.set(projectId, input.name);
        access.set(projectId, {
          preset: input.preset,
          allowlist: (input.projects === "all" ? "all" : [projectId, ...input.projects]) as never,
        });
        return { projectId };
      }),
    deleteAssistant: (projectId) =>
      Effect.sync(() => {
        deleted.push(projectId);
        assistants.delete(projectId);
      }),
    renameAssistant: (projectId, title) => Effect.sync(() => void assistants.set(projectId, title)),
    setEmoji: () => Effect.void,
    createConversation: (projectId, title) =>
      Effect.sync(() => {
        const threadId = ThreadId.make(`t-${conversations.length + 1}`);
        conversations.push({ projectId, title, threadId });
        return { threadId };
      }),
    threadAlive: (threadId) =>
      Effect.succeed(conversations.some((chat) => chat.threadId === threadId)),
    startTurn: (input) => Effect.sync(() => void turns.push(input)),
    showCard: (input) => Effect.sync(() => void cards.push(input)),
    inbox: (post) => Effect.sync(() => void inbox.push(post)),
    routinesAvailable: () => Effect.succeed(options.routines === true),
    assistantSandboxAvailable: () => Effect.succeed(options.sandbox !== false),
    createRoutine: (_caller, input) => Effect.sync(() => void routines.push(input)),
    askPerson: (input) =>
      Effect.sync(() => {
        asked.push(input);
        return options.answer ?? "approved";
      }),
  };
  const addAssistant = (projectId: string, title: string) => assistants.set(projectId, title);
  return {
    deps,
    team: makeAssistantTeam(deps),
    stateDir,
    access,
    inbox,
    turns,
    cards,
    deleted,
    conversations,
    routines,
    asked,
    addAssistant,
  };
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect));

describe("assistant_profile_set: rights only narrow", () => {
  it("saves who it is and narrows its preset, projects and apps", async () => {
    const s = stand();
    s.addAssistant(SCOUT, "Scout");
    const result = await run(
      s.team.profileSet(callerOf(SCOUT), {
        roles: ["Marketing"],
        character: "Friendly",
        preset: "helper",
        projects: ["p-landing"],
        apps: { github: "none" },
        step: "access",
      }),
    );
    expect(result._tag).toBe("Success");
    expect(s.access.get(SCOUT)?.preset).toBe("helper");
    expect(s.access.get(SCOUT)?.allowlist).toEqual([SCOUT, "p-landing"]);
    expect((await readAppAccess(s.stateDir, SCOUT)).permissions.github).toBe("none");
    const team = await readTeam(s.stateDir, SCOUT);
    expect(team.roles).toEqual(["Marketing"]);
    expect(team.setup.answered).toEqual(["access"]);
    expect(team.setup.state).toBe("in-progress");
    const tell = (result as { success: { tell: string } }).success.tell;
    expect(tell).toContain("✓ Saved:");
    expect(tell).toContain("projects — landing");
  });

  it("refuses to widen itself and logs what it wanted", async () => {
    const s = stand();
    s.addAssistant(SCOUT, "Scout");
    s.access.set(SCOUT, { preset: "helper", allowlist: [SCOUT, "p-landing"] as never });
    const result = await run(
      s.team.profileSet(callerOf(SCOUT), { preset: "full", projects: "all" }),
    );
    expect(result._tag).toBe("Failure");
    const error = (result as { failure: { message: string; status: number } }).failure;
    expect(error.status).toBe(403);
    expect(error.message).toContain('"Does it itself" is more than "Asks first"');
    expect(error.message).toContain("every project");
    expect(s.access.get(SCOUT)?.preset).toBe("helper");
    const team = await readTeam(s.stateDir, SCOUT);
    expect(team.activity.at(-1)?.kind).toBe("denied");
  });

  it("can't narrow itself to projects where the sandbox can't hold it (a Mac)", async () => {
    const s = stand({ sandbox: false });
    s.addAssistant(SCOUT, "Scout");
    const result = await run(s.team.profileSet(callerOf(SCOUT), { projects: ["p-landing"] }));
    expect(result._tag).toBe("Failure");
    const error = (result as { failure: { message: string; status: number } }).failure;
    expect(error.status).toBe(409);
    expect(error.message).toContain("Only selected projects needs its own computer");
    expect(s.access.get(SCOUT)).toBeUndefined();
    // Other answers still save.
    expect((await run(s.team.profileSet(callerOf(SCOUT), { roles: ["x"] })))._tag).toBe("Success");
  });

  it("only an assistant's own token may call it", async () => {
    const s = stand();
    const caller = { ...callerOf(SCOUT), label: "settings-token" };
    const result = await run(s.team.profileGet(caller));
    expect(result._tag).toBe("Failure");
  });

  it("a routine needs a cloud computer — on a laptop it says so", async () => {
    const laptop = stand({ routines: false });
    const done = await run(
      laptop.team.profileSet(callerOf(UNO), {
        routine: { name: "Morning plan", cron: "0 8 * * *", prompt: "Plan my day" },
        step: "routine",
      }),
    );
    expect(done._tag).toBe("Success");
    expect(JSON.stringify(done)).toContain("Routines run on a cloud computer");
    expect(laptop.routines).toEqual([]);

    const cloud = stand({ routines: true });
    await run(
      cloud.team.profileSet(callerOf(UNO), {
        routine: { name: "Morning plan", cron: "0 8 * * *", prompt: "Plan my day" },
      }),
    );
    expect(cloud.routines).toHaveLength(1);
  });
});

describe("assistant_profile_set: duties, its own email, where it works", () => {
  it("saves its standing duties as a clean list and says so", async () => {
    const s = stand();
    s.addAssistant(SCOUT, "Scout");
    const result = await run(
      s.team.profileSet(callerOf(SCOUT), {
        duties: ["Watch CI on fishcode", "  Morning plan at 9 ", "Watch CI on fishcode"],
        step: "duties",
      }),
    );
    expect(result._tag).toBe("Success");
    const team = await readTeam(s.stateDir, SCOUT);
    expect(team.duties).toEqual(["Watch CI on fishcode", "Morning plan at 9"]);
    expect(team.setup.answered).toEqual(["duties"]);
    expect(JSON.stringify(result)).toContain("always on you — “Watch CI on fishcode”");
  });

  it("narrows its mail but never widens it", async () => {
    const s = stand();
    s.addAssistant(SCOUT, "Scout");
    const narrowed = await run(
      s.team.profileSet(callerOf(SCOUT), {
        mail: { recipients: "list", allow: ["Ann@Example.com"], dailyLimit: 5 },
        step: "mail",
      }),
    );
    expect(narrowed._tag).toBe("Success");
    expect((await readTeam(s.stateDir, SCOUT)).mail).toEqual({
      enabled: true,
      recipients: "list",
      allow: ["ann@example.com"],
      dailyLimit: 5,
    });
    for (const wider of [
      { recipients: "anyone" },
      { allow: ["ann@example.com", "bob@example.com"] },
      { dailyLimit: 20 },
    ] as const) {
      const refused = await run(s.team.profileSet(callerOf(SCOUT), { mail: wider }));
      expect(refused._tag).toBe("Failure");
      expect((refused as { failure: { status: number } }).failure.status).toBe(403);
    }
    // Off, then on again: on is the person's.
    await run(s.team.profileSet(callerOf(SCOUT), { mail: { enabled: false } }));
    const back = await run(s.team.profileSet(callerOf(SCOUT), { mail: { enabled: true } }));
    expect(back._tag).toBe("Failure");
    // The person widens it on its page.
    await run(s.team.update({ projectId: SCOUT, mail: { enabled: true, recipients: "anyone" } }));
    expect((await readTeam(s.stateDir, SCOUT)).mail.recipients).toBe("anyone");
  });

  it("keeps where the person wants it and says moving is their click; Uno has no such step", async () => {
    const s = stand();
    s.addAssistant(SCOUT, "Scout");
    const result = await run(
      s.team.profileSet(callerOf(SCOUT), { worksOn: "cloud", step: "computer" }),
    );
    expect(result._tag).toBe("Success");
    expect((await readTeam(s.stateDir, SCOUT)).worksOnWish).toBe("cloud");
    expect(JSON.stringify(result)).toContain("one click on your page (Works on)");
    const uno = await run(s.team.profileGet(callerOf(UNO)));
    const left = (uno as { success: { setup: { left: Array<{ id: string }> } } }).success.setup
      .left;
    expect(left.map((step) => step.id)).not.toContain("computer");
    expect(left.map((step) => step.id)).toContain("mail");
  });

  it("shows its own address in the computer's mailbox, or says there is none", async () => {
    const none = stand();
    none.addAssistant(SCOUT, "Scout");
    const without = await run(none.team.profileGet(callerOf(SCOUT)));
    expect(JSON.stringify(without)).toContain('"available":false');

    const s = stand();
    s.addAssistant(SCOUT, "Scout");
    const team = makeAssistantTeam({
      ...s.deps,
      mailboxAddress: () => Effect.succeed("misha-otter@uno4.me"),
    });
    const scout = await run(team.profileGet(callerOf(SCOUT)));
    expect(JSON.stringify(scout)).toContain("misha-otter+scout@uno4.me");
    const uno = await run(team.profileGet(callerOf(UNO)));
    expect(JSON.stringify(uno)).toContain('"address":"misha-otter@uno4.me"');
  });

  it("a helper gets its creator's mail rules and its own duties", async () => {
    const s = stand();
    await updateTeam(s.stateDir, UNO, (current) => ({
      ...current,
      mail: { enabled: true, recipients: "owner", allow: [], dailyLimit: 10 },
    }));
    await run(
      s.team.create(callerOf(UNO), { name: "Scout", duties: ["Weekly competitor digest"] }),
    );
    const team = await readTeam(s.stateDir, SCOUT);
    expect(team.mail).toEqual({ enabled: true, recipients: "owner", allow: [], dailyLimit: 10 });
    expect(team.duties).toEqual(["Weekly competitor digest"]);
  });
});

describe("assistant_create: a helper never wider than its creator", () => {
  it("makes it within the creator's rights, links it and tells the person", async () => {
    const s = stand();
    s.access.set(UNO, { preset: "helper", allowlist: [UNO, "p-landing", "p-fishcode"] as never });
    const result = await run(
      s.team.create(callerOf(UNO), {
        name: "Scout",
        emoji: "🔭",
        roles: ["Marketing"],
        preset: "observer",
        projects: ["p-landing"],
        firstTask: "Every Monday: what competitors shipped",
      }),
    );
    expect(result._tag).toBe("Success");
    expect(s.access.get(SCOUT)).toEqual({ preset: "observer", allowlist: [SCOUT, "p-landing"] });
    const team = await readTeam(s.stateDir, SCOUT);
    expect(team.createdBy).toBe(UNO);
    expect(team.roles).toEqual(["Marketing"]);
    // The Inbox notice, no confirmation (decision 14.10).
    expect(s.inbox).toHaveLength(1);
    expect(s.inbox[0]!.title).toBe("Uno set up assistant Scout");
    expect(s.inbox[0]!.body).toContain("landing");
    expect(s.inbox[0]!.body).toContain("Reads only");
    expect(s.inbox[0]!.open).toEqual({ kind: "url", url: "uno://assistant/this/assistant-scout" });
    // Its first task goes to it as a message.
    expect(s.turns.at(-1)?.text).toContain("Every Monday");
    // The creator's Activity has it.
    expect((await readTeam(s.stateDir, UNO)).activity.at(-1)?.text).toContain("Set up Scout");
  });

  it("defaults to the creator's own rights", async () => {
    const s = stand();
    s.access.set(UNO, { preset: "helper", allowlist: [UNO, "p-fishcode"] as never });
    await writeAppAccess(s.stateDir, UNO, { gmail: "read" });
    await run(s.team.create(callerOf(UNO), { name: "Scout" }));
    expect(s.access.get(SCOUT)).toEqual({ preset: "helper", allowlist: [SCOUT, "p-fishcode"] });
    expect((await readAppAccess(s.stateDir, SCOUT)).permissions.gmail).toBe("read");
  });

  it("refuses anything wider: preset, projects, app levels", async () => {
    const s = stand();
    s.access.set(UNO, { preset: "helper", allowlist: [UNO, "p-landing"] as never });
    await writeAppAccess(s.stateDir, UNO, { github: "read" });
    const result = await run(
      s.team.create(callerOf(UNO), {
        name: "Scout",
        preset: "full",
        projects: ["p-landing", "p-fishcode"],
        apps: { github: "write" },
      }),
    );
    expect(result._tag).toBe("Failure");
    const message = (result as { failure: { message: string } }).failure.message;
    expect(message).toContain('"Does it itself" is more than "Asks first"');
    expect(message).toContain("project fishcode");
    expect(message).toContain("changes in GitHub");
    expect(s.inbox).toHaveLength(0);
  });

  it("an Observer sets up no one", async () => {
    const s = stand();
    s.access.set(UNO, { preset: "observer", allowlist: [UNO] as never });
    const result = await run(s.team.create(callerOf(UNO), { name: "Scout", preset: "observer" }));
    expect(result._tag).toBe("Failure");
    expect((result as { failure: { message: string } }).failure.message).toContain("Reads only");
  });

  it('"Asks first": a new assistant waits for the person\'s Allow (Misha 23.10)', async () => {
    const s = stand();
    s.access.set(UNO, { preset: "helper", allowlist: "all" });
    const made = await run(s.team.create(callerOf(UNO, "t-uno"), { name: "Scout" }));
    expect(made._tag).toBe("Success");
    expect(s.asked).toEqual([
      expect.objectContaining({ title: "Set up assistant Scout", threadId: "t-uno" }),
    ]);

    const denied = stand({ answer: "denied" });
    denied.access.set(UNO, { preset: "helper", allowlist: "all" });
    const refused = await run(denied.team.create(callerOf(UNO), { name: "Scout" }));
    expect(refused._tag).toBe("Failure");
    expect((refused as { failure: { message: string } }).failure.message).toContain("declined");
    expect(denied.access.has(SCOUT)).toBe(false);
    expect(denied.inbox).toHaveLength(0);

    // "Does it itself" sets one up without asking.
    const full = stand();
    await run(full.team.create(callerOf(UNO), { name: "Scout" }));
    expect(full.asked).toEqual([]);
    expect(full.access.get(SCOUT)?.preset).toBe("full");
  });

  it('"Asks first" with nobody answering yet: the turn isn\'t held; a late Allow sets it up', async () => {
    const s = stand({ answer: "queued" });
    s.access.set(UNO, { preset: "helper", allowlist: "all" });
    const made = await run(s.team.create(callerOf(UNO, "t-uno"), { name: "Scout" }));
    expect(made._tag).toBe("Success");
    expect((made as { success: unknown }).success).toMatchObject({ queued: true, name: "Scout" });
    expect(s.access.has(SCOUT)).toBe(false);
    const later = (s.asked[0] as { later?: (o: "approved") => Effect.Effect<void> }).later;
    expect(later).toBeDefined();
    await Effect.runPromise(later!("approved"));
    expect(s.access.get(SCOUT)?.preset).toBe("helper");
    expect(s.turns.at(-1)).toMatchObject({ threadId: "t-uno", system: true });
    expect(s.turns.at(-1)?.text).toContain("Scout is set up");
  });

  it("unknown project ids are refused", async () => {
    const s = stand();
    const result = await run(s.team.create(callerOf(UNO), { name: "Scout", projects: ["nope"] }));
    expect(result._tag).toBe("Failure");
  });
});

describe("cascade: cutting an assistant cuts what it set up", () => {
  it("narrows the whole tree and posts who lost what", async () => {
    const s = stand();
    await run(s.team.create(callerOf(UNO), { name: "Scout", preset: "helper" }));
    await run(s.team.create(callerOf(SCOUT), { name: "Ada", preset: "helper" }));
    s.inbox.length = 0;
    // The person makes Uno an Observer on "landing" only.
    s.access.set(UNO, { preset: "observer", allowlist: [UNO, "p-landing"] as never });
    const losses = await Effect.runPromise(s.team.rightsChanged(UNO));
    expect(losses.map((loss) => loss.projectId)).toEqual(["assistant-scout", "assistant-ada"]);
    expect(s.access.get("assistant-scout")).toEqual({
      preset: "observer",
      allowlist: ["assistant-scout", "p-landing"],
    });
    expect(s.access.get("assistant-ada")?.preset).toBe("observer");
    expect(s.inbox).toHaveLength(1);
    expect(s.inbox[0]!.title).toBe("2 assistants lost some access");
    expect((await readTeam(s.stateDir, "assistant-ada")).activity.at(-1)?.text).toContain(
      "Scout's rights changed",
    );
  });

  it("an assistant narrowing itself cuts its helpers too", async () => {
    const s = stand();
    await run(s.team.create(callerOf(UNO), { name: "Scout", preset: "full" }));
    await run(s.team.profileSet(callerOf(UNO), { preset: "helper" }));
    expect(s.access.get(SCOUT)?.preset).toBe("helper");
  });
});

describe("revoke and delete take the helpers along", () => {
  it("revokes the tree, and brings back one at a time within its creator", async () => {
    const s = stand();
    await run(s.team.create(callerOf(UNO), { name: "Scout", preset: "helper" }));
    await run(s.team.create(callerOf(SCOUT), { name: "Ada", preset: "helper" }));
    const revoked = await run(s.team.revoke({ projectId: SCOUT, revoked: true }));
    expect(revoked._tag).toBe("Success");
    expect((revoked as unknown as { success: { affected: string[] } }).success.affected).toEqual([
      "assistant-scout",
      "assistant-ada",
    ]);
    expect(s.access.get(SCOUT)).toEqual({ preset: "observer", allowlist: [SCOUT] });
    expect((await readTeam(s.stateDir, "assistant-ada")).revokedAt).not.toBeNull();
    // A revoked assistant can't save or create anything.
    expect((await run(s.team.profileSet(callerOf(SCOUT), { roles: ["x"] })))._tag).toBe("Failure");
    // Ada can't come back before Scout.
    const early = await run(
      s.team.revoke({ projectId: ProjectId.make("assistant-ada"), revoked: false }),
    );
    expect(early._tag).toBe("Failure");
    await run(s.team.revoke({ projectId: SCOUT, revoked: false }));
    expect(s.access.get(SCOUT)?.preset).toBe("helper");
    expect((await readTeam(s.stateDir, SCOUT)).revokedAt).toBeNull();
  });

  it("Uno itself can't be revoked", async () => {
    const s = stand();
    expect((await run(s.team.revoke({ projectId: UNO, revoked: true })))._tag).toBe("Failure");
  });

  it("deleting deletes its helpers first and says so", async () => {
    const s = stand();
    await run(s.team.create(callerOf(UNO), { name: "Scout" }));
    await run(s.team.create(callerOf(SCOUT), { name: "Ada" }));
    s.inbox.length = 0;
    await run(s.team.deleteWithHelpers(SCOUT));
    expect(s.deleted).toEqual(["assistant-ada", "assistant-scout"]);
    expect(s.inbox[0]?.title).toBe("Scout was deleted with Ada it set up");
  });
});

describe("the setup chat", () => {
  it("opens a chat that starts the setup, and goes on in it later", async () => {
    const s = stand();
    s.addAssistant(SCOUT, "Scout");
    const first = await Effect.runPromise(s.team.startSetupChat(SCOUT));
    expect(s.conversations[0]).toMatchObject({ projectId: SCOUT, title: "Setting up Scout" });
    expect(s.turns[0]).toMatchObject({ threadId: first.threadId, system: true });
    expect(s.turns[0]!.text.startsWith("[Uno Work — setup]")).toBe(true);
    expect((await readTeam(s.stateDir, SCOUT)).setup).toMatchObject({
      state: "in-progress",
      threadId: first.threadId,
    });
    await run(s.team.profileSet(callerOf(SCOUT), { roles: ["Developer"], step: "role" }));
    const again = await Effect.runPromise(s.team.startSetupChat(SCOUT));
    expect(again.threadId).toBe(first.threadId);
    expect(s.conversations).toHaveLength(1);
    expect(s.turns[1]!.text).toContain("(continue)");
    expect(s.turns[1]!.text).not.toContain("1. role");
  });

  it("the kickoff lists only the steps left", () => {
    const text = setupKickoffText({ name: "Ada", resume: false, left: ["apps", "first-task"] });
    expect(text).toContain("1. apps");
    expect(text).toContain("2. first-task");
    expect(text).not.toContain("role —");
  });
});

describe("ask_user: a question card in its own conversation", () => {
  it("shows the card in the calling conversation", async () => {
    const s = stand();
    const result = await run(
      s.team.askUser(callerOf(UNO, "t-setup"), {
        header: "My job",
        question: "What should I take off your plate?",
        options: [{ label: "Personal assistant" }, { label: "Developer", description: "CI" }],
      }),
    );
    expect(result._tag).toBe("Success");
    expect(s.cards).toHaveLength(1);
    expect(s.cards[0]!.threadId).toBe("t-setup");
    expect(s.cards[0]!.requestId.startsWith(ASSISTANT_ASK_REQUEST_PREFIX)).toBe(true);
    expect(s.cards[0]!.question).toMatchObject({
      header: "My job",
      skippable: true,
      options: [
        { label: "Personal assistant", description: "Personal assistant" },
        { label: "Developer", description: "CI" },
      ],
    });
  });

  it("needs its own conversation", async () => {
    const s = stand();
    expect((await run(s.team.askUser(callerOf(UNO), { header: "x", question: "y" })))._tag).toBe(
      "Failure",
    );
  });
});

describe("askCards", () => {
  it("turns the answer into the person's message", () => {
    expect(askCardAnswerText({ header: "My job" }, { answer: "Developer" })).toBe(
      "My job: Developer",
    );
    expect(askCardAnswerText({ header: "Projects" }, { answer: ["landing", "fishcode"] })).toBe(
      "Projects: landing, fishcode",
    );
    expect(askCardAnswerText({ header: "Apps" }, { answer: "" })).toBe("Apps: Skip");
    expect(isAskCardRequest(`${ASSISTANT_ASK_REQUEST_PREFIX}1`)).toBe(true);
    expect(isAskCardRequest("codex-req-1")).toBe(false);
  });

  it("finds the card's question among the activities", () => {
    const question = { id: "answer", header: "My job", question: "?", options: [] };
    const activities = [
      { kind: "user-input.requested", payload: { requestId: "uno-ask:a", questions: [question] } },
      { kind: "tool.completed", payload: {} },
    ];
    expect(findAskCardQuestion(activities, "uno-ask:a")?.header).toBe("My job");
    expect(findAskCardQuestion(activities, "uno-ask:b")).toBeNull();
  });
});

describe("teamStore", () => {
  it("reads anything as a record and keeps the setup's progress", async () => {
    expect(
      normalizeTeam({ roles: ["a", "a", 3], channel: "fax", setup: { answered: ["role", "x"] } }),
    ).toMatchObject({
      roles: ["a"],
      channel: null,
      setup: { answered: ["role"], state: "not-started" },
    });
    const now = new Date();
    let team = normalizeTeam(null);
    for (const step of [
      "role",
      "duties",
      "character",
      "channel",
      "access",
      "apps",
      "mail",
      "computer",
    ] as const) {
      team = withSetupStep(team, step, false, now);
    }
    expect(team.setup.state).toBe("in-progress");
    team = withSetupStep(team, "first-task", true, now);
    expect(team.setup.state).toBe("done");
    expect(team.setup.skipped).toEqual(["first-task"]);
    const dir = tempDir();
    await updateTeam(dir, "assistant-x", (current) => ({ ...current, character: "Calm" }));
    expect((await readTeam(dir, "assistant-x")).character).toBe("Calm");
  });

  it("an unreadable revoked copy brings it back as Full", () => {
    expect(parseRevokedAccess("{nope")).toEqual({ preset: "full", projects: "all" });
    expect(parseRevokedAccess('{"preset":"helper","projects":["p1",2]}')).toEqual({
      preset: "helper",
      projects: ["p1"],
    });
  });
});
