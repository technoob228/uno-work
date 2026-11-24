/**
 * T51 (b)(c)(d): requests between the people of a project, on this computer.
 *
 * To this person (`GET requests/inbox`, long poll):
 * - `session` → the computer with the project's folder claims it and the
 *   T50 host shows it (a record with `team`: Start / Decline, 2 hours, the
 *   guard). On "Do tasks" (and (d) on) it starts without a button once the
 *   level, read again, still says so; the journal and the daily digest say
 *   so. `stop_requested` stops its chat.
 * - `question` → on "Answer questions" ((c) on) a chat here that only reads
 *   answers it; else the person presses "Let my agent answer"
 *   (`team.letAgentAnswer`). The answer is scrubbed and goes back.
 * - `message`, `write_access` → only the Telegram copy (the interface
 *   shows them; deciding is the person's, with their sign-in).
 * How each record goes is told to the cloud (`requests/{id}/status`), once
 * per step.
 *
 * From this person's chats (`GET requests/outgoing?source=`): each answer is
 * told to the chat that asked, as a note that isn't the person's words
 * (T50 `tell()`), a colleague's agent's answer fenced as outside text.
 *
 * Telegram: one copy per account (`requests/{id}/telegram`). A session gets
 * Start / Decline when this computer holds it, or reaches the one that does
 * through the T50 tunnel; else no buttons, "open Uno Work".
 *
 * @module team/bridge
 */
import type { ChatRequestPressReply } from "../chatRequests/messenger.ts";
import { outsideNonce } from "../automations/prompt.ts";
import { teamRecordId, type HostRecord } from "../chatRequests/hostLogic.ts";
import {
  answersOnItsOwn,
  answerStep,
  dueReports,
  retiredBy,
  startsOnItsOwn,
  teamFileOf,
} from "./bridge.logic.ts";
import type { TeamPorts } from "./ports.ts";
import { scrubSecrets } from "./scrub.logic.ts";
import { LONG_POLL_WAIT_S, TeamCloudError, type StatusInput } from "./teamCloud.ts";
import { agentOf, personName, type TeamRequest } from "./teamCloud.logic.ts";
import { asNumber, asRecord, readTeamFile, writeTeamFile } from "./teamFiles.ts";
import {
  digestText,
  outgoingNote,
  questionBrief,
  telegramCopy,
  type DigestEntry,
} from "./teamNotes.logic.ts";

const FILE = "bridge.json";
/** A non-target computer waits this long for the target's record to show through the tunnel. */
export const TUNNEL_LOOK_AFTER_MS = 20_000;
/** …and sends the copy without buttons after this long. */
export const NO_BUTTONS_AFTER_MS = 90_000;
/** A read-only chat that takes longer is stopped and the question refused. */
export const ANSWER_MAX_MS = 30 * 60_000;
/** A note for a busy chat waits this long at most. */
export const NOTE_WAIT_MAX_MS = 2 * 60 * 60_000;
export const DIGEST_EVERY_MS = 24 * 60 * 60_000;
const NOTES_KEEP = 1_000;

interface Answering {
  readonly requestId: number;
  readonly threadId: string;
  readonly startedAt: number;
  readonly projectName: string;
  readonly fromName: string;
  readonly folder: string;
  readonly auto: boolean;
}

interface BridgeFile {
  inboxRev: number;
  outgoingRev: number;
  /** Record id → the steps the cloud has. */
  told: Record<string, Array<string>>;
  answering: Record<string, Answering>;
  /** Outgoing notes told to their chat. */
  notes: Array<string>;
  /** Request id → "sent" | "buttons" | "skipped". */
  telegram: Record<string, string>;
  /** Record id → how its session was decided when not by the person here. */
  via: Record<string, "auto" | "telegram">;
  digest: { lastAt: number | null; entries: Array<DigestEntry> };
}

const parseFile = (raw: unknown): BridgeFile => {
  const value = asRecord(raw);
  const told: Record<string, Array<string>> = {};
  for (const [id, keys] of Object.entries(asRecord(value["told"]))) {
    if (Array.isArray(keys))
      told[id] = keys.filter((key): key is string => typeof key === "string");
  }
  const answering: Record<string, Answering> = {};
  for (const [id, entry] of Object.entries(asRecord(value["answering"]))) {
    const item = asRecord(entry);
    if (typeof item["threadId"] !== "string" || typeof item["folder"] !== "string") continue;
    answering[id] = {
      requestId: asNumber(item["requestId"]),
      threadId: item["threadId"],
      startedAt: asNumber(item["startedAt"]),
      projectName: typeof item["projectName"] === "string" ? item["projectName"] : "",
      fromName: typeof item["fromName"] === "string" ? item["fromName"] : "",
      folder: item["folder"],
      auto: item["auto"] === true,
    };
  }
  const telegram: Record<string, string> = {};
  for (const [id, state] of Object.entries(asRecord(value["telegram"]))) {
    if (typeof state === "string") telegram[id] = state;
  }
  const via: Record<string, "auto" | "telegram"> = {};
  for (const [id, how] of Object.entries(asRecord(value["via"]))) {
    if (how === "auto" || how === "telegram") via[id] = how;
  }
  const digest = asRecord(value["digest"]);
  return {
    inboxRev: asNumber(value["inboxRev"]),
    outgoingRev: asNumber(value["outgoingRev"]),
    told,
    answering,
    notes: Array.isArray(value["notes"])
      ? value["notes"].filter((key): key is string => typeof key === "string")
      : [],
    telegram,
    via,
    digest: {
      lastAt: typeof digest["lastAt"] === "number" ? digest["lastAt"] : null,
      entries: Array.isArray(digest["entries"]) ? (digest["entries"] as Array<DigestEntry>) : [],
    },
  };
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A failure the request won't get over by asking again (it's gone, not ours, refused). */
const final = (error: unknown) =>
  error instanceof TeamCloudError &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 401 &&
  error.status !== 429;

interface PendingNote {
  readonly key: string;
  readonly threadId: string;
  readonly text: string;
  readonly outside: boolean;
  readonly firstAt: number;
}

export class TeamBridgeError extends Error {}

export function makeTeamBridge(ports: TeamPorts) {
  let file: BridgeFile | null = null;
  const load = async () => (file ??= await readTeamFile(ports.stateDir, FILE, parseFile));
  const save = async () => {
    if (file !== null) await writeTeamFile(ports.stateDir, FILE, file);
  };

  /** The colleagues' requests to this person, as last read. */
  const inbox = new Map<number, TeamRequest>();
  const firstSeen = new Map<number, number>();
  /** Record id → the computer of the person's that holds it (through the tunnel). */
  const tunnelTargets = new Map<string, { computerId: string; computerName: string }>();
  const notes = new Map<string, PendingNote>();

  const folderOf = async (projectId: number) =>
    (await ports.projectsHere()).find((project) => project.teamProjectId === projectId)?.folder ??
    null;

  const scrubbed = async (text: string, folder: string | null) =>
    scrubSecrets(text, folder === null ? [] : await ports.folderSecrets(folder)).text;

  const report = async (requestId: number, input: StatusInput, folder: string | null) => {
    const source = await ports.source();
    const answer = input.answer === undefined ? undefined : await scrubbed(input.answer, folder);
    await ports.cloud.status(requestId, source, {
      ...input,
      ...(answer !== undefined ? { answer } : {}),
    });
  };

  const addDigest = async (entry: DigestEntry) => {
    const state = await load();
    state.digest.entries.push(entry);
    if (state.digest.entries.length > 200)
      state.digest.entries.splice(0, state.digest.entries.length - 200);
    await save();
  };

  // ── Telegram ──────────────────────────────────────────────────────────

  const sendTelegram = async (request: TeamRequest, holdsIt: boolean): Promise<void> => {
    const telegram = ports.telegram;
    if (telegram === null || request.status !== "waiting") return;
    const state = await load();
    const id = String(request.id);
    if (state.telegram[id] !== undefined) return;
    const now = ports.now();
    const seen = firstSeen.get(request.id) ?? now;
    const recordId = teamRecordId(request.id);
    let buttons = false;
    let computerName = await ports.computerName();
    if (request.kind === "session") {
      if (holdsIt) {
        buttons = true;
      } else {
        // The computer that has the folder claims it first: look for it a bit later.
        if (now - seen < TUNNEL_LOOK_AFTER_MS) return;
        const found = ports.tunnel === null ? null : await ports.tunnel.findWaiting(recordId);
        if (found !== null) {
          tunnelTargets.set(recordId, found);
          buttons = true;
          computerName = found.computerName;
        } else if (now - seen < NO_BUTTONS_AFTER_MS) {
          return;
        } else {
          computerName = "your computer";
        }
      }
    }
    if (!(await telegram.linked())) return;
    const source = await ports.source();
    const mine = await ports.cloud.telegram(request.id, source);
    if (!mine) {
      state.telegram[id] = "skipped";
      await save();
      return;
    }
    const copy = telegramCopy(request, { computerName, buttons });
    const ttl = Math.max(60_000, Date.parse(request.expiresAt) - now || 0) + 10 * 60_000;
    await telegram.send({
      key: `team-request-${request.id}`,
      text: buttons ? copy.text : copy.textWithoutButtons,
      textWithoutButtons: copy.textWithoutButtons,
      buttonsFor: buttons ? recordId : null,
      buttonsTtlMs: ttl,
    });
    state.telegram[id] = buttons ? "buttons" : "sent";
    await save();
  };

  /** Its buttons go once it no longer waits. */
  const retireButtons = async (requestId: number, line: string) => {
    const state = await load();
    const id = String(requestId);
    if (state.telegram[id] !== "buttons" || ports.telegram === null) return;
    state.telegram[id] = "sent";
    await save();
    await ports.telegram.retire(teamRecordId(requestId), line);
  };

  const settledLine = (status: string) =>
    status === "started"
      ? "▶ Started"
      : status === "declined"
        ? "✖ Declined"
        : status === "expired"
          ? "⌛ Expired"
          : "✔ No longer waiting";

  /** A press of Start / Decline in Telegram for a colleague's session. */
  const decideFromTelegram = async (
    recordId: string,
    decision: "start" | "decline",
  ): Promise<ChatRequestPressReply> => {
    const records = await ports.host.records();
    const here = records.find((record) => record.id === recordId);
    if (here !== undefined) {
      if (here.status !== "waiting") {
        return { toast: "This request is no longer waiting.", finalLine: settledLine(here.status) };
      }
      (await load()).via[recordId] = "telegram";
      await save();
      try {
        await ports.host.decide(recordId, decision);
      } catch (error) {
        delete (await load()).via[recordId];
        await save();
        return { toast: message(error), finalLine: null };
      }
      return {
        toast: decision === "start" ? "Started: the chat opens in Uno Work." : "Declined.",
        finalLine: decision === "start" ? "▶ Started" : "✖ Declined",
      };
    }
    const target = tunnelTargets.get(recordId);
    if (target !== undefined && ports.tunnel !== null) {
      try {
        await ports.tunnel.decide(target.computerId, recordId, decision);
      } catch {
        return {
          toast: `${target.computerName} isn't reachable now. Try again, or answer in Uno Work there.`,
          finalLine: null,
        };
      }
      return {
        toast:
          decision === "start"
            ? `Sent to ${target.computerName}: the chat starts there in a few seconds.`
            : `Sent to ${target.computerName}.`,
        finalLine: decision === "start" ? "▶ Started" : "✖ Declined",
      };
    }
    return { toast: "This request is no longer waiting.", finalLine: "✔ Already answered" };
  };

  // ── Questions ─────────────────────────────────────────────────────────

  const startAnswer = async (
    request: TeamRequest,
    auto: boolean,
  ): Promise<{ readonly threadId: string }> => {
    const state = await load();
    const known = state.answering[String(request.id)];
    if (known !== undefined) return { threadId: known.threadId };
    const folder = await folderOf(request.projectId);
    if (folder === null) {
      const name = request.projectName ? ` ${request.projectName}` : "";
      throw new TeamBridgeError(
        `The project${name} isn't on this computer, so your agent can't answer it here.`,
      );
    }
    const source = await ports.source();
    if (!(await ports.cloud.claim(request.id, source))) {
      throw new TeamBridgeError("Another computer of yours is answering it already.");
    }
    const fromName = personName(request.from);
    const asker = request.fromAssistant ? agentOf(fromName, true) : fromName;
    const started = await ports.host.startReadOnly({
      title: `Question from ${asker}: ${request.title || request.gist || "a question"}`.slice(
        0,
        120,
      ),
      text: questionBrief({
        fromName,
        fromAssistant: request.fromAssistant,
        projectName: request.projectName,
        fromChatTitle: request.fromChatTitle,
        title: request.title,
        body: request.body || request.gist,
        auto,
        nonce: outsideNonce(),
      }),
      cwd: folder,
      startedBy: {
        assistantName: `${fromName}'s agent`,
        assistantProjectId: null,
        fromComputerName: `a colleague in ${request.projectName || "a project"}`,
        fromBoxId: null,
        fromThreadId: request.fromThread ?? `team-request-${request.id}`,
      },
    });
    state.answering[String(request.id)] = {
      requestId: request.id,
      threadId: started.threadId,
      startedAt: ports.now(),
      projectName: request.projectName,
      fromName,
      folder,
      auto,
    };
    await save();
    if (auto) {
      await addDigest({
        at: new Date(ports.now()).toISOString(),
        kind: "answered",
        fromName,
        projectName: request.projectName,
        title: request.title || request.gist,
      });
    }
    return started;
  };

  /** "Let my agent answer", from the interface. */
  const letAgentAnswer = async (requestId: number) => {
    let request = inbox.get(requestId);
    if (request === undefined) {
      const all = await ports.cloud.inbox(0, 0);
      for (const entry of all.requests) inbox.set(entry.id, entry);
      request = inbox.get(requestId);
    }
    if (request === undefined) throw new TeamBridgeError("That request isn't in your inbox.");
    if (request.kind !== "question") {
      throw new TeamBridgeError("Only a question can be answered by your agent.");
    }
    if (request.status !== "waiting") {
      throw new TeamBridgeError(`That question is already ${request.status}.`);
    }
    if (!(await ports.parts.get()).requests) {
      throw new TeamBridgeError("Requests from colleagues aren't on for this account.");
    }
    return startAnswer(request, false);
  };

  const answeringRound = async () => {
    const state = await load();
    for (const [id, entry] of Object.entries(state.answering)) {
      let step: StatusInput | null;
      if (ports.now() - entry.startedAt > ANSWER_MAX_MS) {
        await ports.stop(entry.threadId).catch(() => undefined);
        step = { status: "refused", reason: "Answering took too long, so it was stopped." };
      } else {
        step = answerStep(await ports.host.follow(entry.threadId));
      }
      if (step === null) continue;
      if (step.status === "answered") step = { ...step, decidedVia: entry.auto ? "auto" : "here" };
      try {
        await report(entry.requestId, step, entry.folder);
      } catch (error) {
        if (!final(error)) throw error;
        ports.error("bridge", message(error));
      }
      delete state.answering[id];
      await save();
    }
  };

  // ── Requests to this person ───────────────────────────────────────────

  const handleSession = async (request: TeamRequest, records: ReadonlyArray<HostRecord>) => {
    const recordId = teamRecordId(request.id);
    const record = records.find((entry) => entry.id === recordId) ?? null;
    if (record === null) {
      if (request.status !== "waiting" || request.stopRequested) return;
      const folder = await folderOf(request.projectId);
      if (folder === null) {
        await sendTelegram(request, false);
        return;
      }
      const source = await ports.source();
      if (!(await ports.cloud.claim(request.id, source))) return;
      const admitted = await ports.host.admit(teamFileOf(request, folder));
      if (admitted === null || admitted.status !== "waiting") return;
      const parts = await ports.parts.get();
      if (request.auto && parts.tasks) {
        const levels = await ports.cloud.levels(request.projectId).catch(() => null);
        if (startsOnItsOwn(request, parts, levels)) {
          (await load()).via[recordId] = "auto";
          await save();
          await ports.host.autoStart(recordId);
          await addDigest({
            at: new Date(ports.now()).toISOString(),
            kind: "session",
            fromName: personName(request.from),
            projectName: request.projectName,
            title: request.title || request.gist,
          });
          return;
        }
      }
      await sendTelegram(request, true);
      return;
    }
    if (record.status === "waiting") {
      const over = retiredBy(request);
      if (over !== null) await ports.host.retire(recordId, over.status, over.reason);
      else await sendTelegram(request, true);
    }
    const state = await load();
    const told = (state.told[recordId] ??= []);
    if (
      request.stopRequested &&
      record.status === "started" &&
      record.threadId !== null &&
      !told.includes("stopped")
    ) {
      await ports.stop(record.threadId);
      await report(
        request.id,
        { status: "stopped", reason: "Stopped at the colleague's or the project owner's request." },
        record.cwd,
      );
      told.push("stopped");
      await save();
    }
  };

  const handle = async (request: TeamRequest, records: ReadonlyArray<HostRecord>) => {
    if (!firstSeen.has(request.id)) firstSeen.set(request.id, ports.now());
    if (request.status !== "waiting") {
      await retireButtons(request.id, settledLine(request.status));
    }
    switch (request.kind) {
      case "session":
        await handleSession(request, records);
        return;
      case "question": {
        const state = await load();
        const answering = state.answering[String(request.id)];
        if (answering !== undefined && request.stopRequested) {
          await ports.stop(answering.threadId).catch(() => undefined);
          return;
        }
        if (answering === undefined && answersOnItsOwn(request, await ports.parts.get())) {
          if ((await folderOf(request.projectId)) !== null) {
            await startAnswer(request, true).catch((error: unknown) => {
              if (!(error instanceof TeamBridgeError)) throw error;
            });
            return;
          }
        }
        await sendTelegram(request, false);
        return;
      }
      case "message":
      case "write_access":
        await sendTelegram(request, false);
        return;
    }
  };

  /** One long poll of the inbox and what it brought. */
  const inboxRound = async (): Promise<void> => {
    const parts = await ports.parts.get();
    if (!parts.requests) {
      inbox.clear();
      await ports.sleep(60_000);
      return;
    }
    const state = await load();
    let read;
    try {
      read = await ports.cloud.inbox(state.inboxRev, LONG_POLL_WAIT_S);
    } catch (error) {
      if (error instanceof TeamCloudError && error.off) {
        ports.parts.markOff();
        return;
      }
      throw error;
    }
    const records = await ports.host.records();
    for (const request of read.requests) {
      inbox.set(request.id, request);
      try {
        await handle(request, records);
      } catch (error) {
        ports.error("bridge", message(error));
      }
    }
    const rev =
      read.rev ?? Math.max(state.inboxRev, ...read.requests.map((request) => request.rev));
    if (rev !== state.inboxRev) {
      state.inboxRev = rev;
      await save();
    }
  };

  /**
   * Every few seconds: the steps of this computer's colleague records the
   * cloud hasn't heard, the read-only answers, Telegram copies due, the
   * outgoing notes, the digest.
   */
  const followRound = async (): Promise<void> => {
    const parts = await ports.parts.get();
    if (!parts.requests) return;
    const state = await load();
    for (const record of await ports.host.records()) {
      const team = record.team;
      if (team === undefined) continue;
      const told = (state.told[record.id] ??= []);
      if (told.includes("stopped")) continue;
      for (const step of dueReports(record, told)) {
        const decided = step.key === "started" || step.key === "declined";
        try {
          await report(
            team.requestId,
            decided
              ? { ...step.input, decidedVia: state.via[record.id] ?? record.decidedVia ?? "here" }
              : step.input,
            record.cwd,
          );
        } catch (error) {
          if (!final(error)) throw error;
          ports.error("bridge", message(error));
        }
        told.push(step.key);
        await save();
      }
      if (record.status !== "waiting")
        await retireButtons(team.requestId, settledLine(record.status));
    }
    await answeringRound();
    for (const request of inbox.values()) {
      if (request.status !== "waiting" || state.telegram[String(request.id)] !== undefined)
        continue;
      if (request.kind !== "session") continue;
      const holds = (await ports.host.records()).some(
        (record) => record.id === teamRecordId(request.id),
      );
      await sendTelegram(request, holds).catch((error: unknown) =>
        ports.error("telegram", message(error)),
      );
    }
    await deliverNotes();
    await digestRound();
  };

  // ── From this person's chats ──────────────────────────────────────────

  const deliverNotes = async () => {
    if (notes.size === 0) return;
    const state = await load();
    for (const note of notes.values()) {
      if (ports.now() - note.firstAt > NOTE_WAIT_MAX_MS) {
        notes.delete(note.key);
        continue;
      }
      if (note.outside) await ports.markOutside(note.threadId);
      const told = await ports.tell(note.threadId, note.text);
      if (told === "busy") continue;
      notes.delete(note.key);
      if (told === "told") {
        state.notes.push(note.key);
        if (state.notes.length > NOTES_KEEP) state.notes.splice(0, state.notes.length - NOTES_KEEP);
        await save();
      }
    }
  };

  const outgoingRound = async (): Promise<void> => {
    const parts = await ports.parts.get();
    if (!parts.requests) {
      await ports.sleep(60_000);
      return;
    }
    const state = await load();
    const source = await ports.source();
    let read;
    try {
      read = await ports.cloud.outgoing(source, state.outgoingRev, LONG_POLL_WAIT_S);
    } catch (error) {
      if (error instanceof TeamCloudError && error.off) {
        ports.parts.markOff();
        return;
      }
      throw error;
    }
    for (const request of read.requests) {
      if (request.fromThread === null || request.fromThread.length === 0) continue;
      const key = `${request.id}:${request.status}:${request.answer ? "a" : ""}`;
      if (state.notes.includes(key) || notes.has(key)) continue;
      const text = outgoingNote(request, outsideNonce());
      if (text === null) continue;
      notes.set(key, {
        key,
        threadId: request.fromThread,
        text,
        outside: Boolean(request.answer) || Boolean(request.reason),
        firstAt: ports.now(),
      });
    }
    await deliverNotes();
    const rev =
      read.rev ?? Math.max(state.outgoingRev, ...read.requests.map((request) => request.rev));
    if (rev !== state.outgoingRev) {
      state.outgoingRev = rev;
      await save();
    }
  };

  // ── The daily digest ──────────────────────────────────────────────────

  const digestRound = async () => {
    const state = await load();
    const entries = state.digest.entries;
    if (entries.length === 0 || ports.telegram === null) return;
    const since = state.digest.lastAt ?? Date.parse(entries[0]!.at);
    if (!Number.isFinite(since) || ports.now() - since < DIGEST_EVERY_MS) return;
    const text = digestText(entries);
    state.digest = { lastAt: ports.now(), entries: [] };
    await save();
    if (text === null || !(await ports.telegram.linked())) return;
    await ports.telegram.send({
      key: `team-digest-${new Date(ports.now()).toISOString().slice(0, 10)}`,
      text,
      textWithoutButtons: text,
      buttonsFor: null,
    });
  };

  const answering = async () =>
    Object.values((await load()).answering).map((entry) => ({
      requestId: entry.requestId,
      threadId: entry.threadId,
      projectName: entry.projectName,
      fromName: entry.fromName,
      startedAt: new Date(entry.startedAt).toISOString(),
    }));

  return {
    inboxRound,
    outgoingRound,
    followRound,
    letAgentAnswer,
    decideFromTelegram,
    answering,
  };
}

export type TeamBridge = ReturnType<typeof makeTeamBridge>;
