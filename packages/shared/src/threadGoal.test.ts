import { describe, expect, it } from "vitest";

import {
  addReportedCost,
  decideGoalStep,
  goalNoteBody,
  goalNoteLine,
  parseGoalCommand,
  readGoalVerdict,
  stripGoalMarker,
} from "./threadGoal.ts";

const NONCE = "a1b2c3";
const progress = {
  turnsUsed: 3,
  maxTurns: 10,
  costUsd: 1,
  maxCostUsd: 10,
  deadlineMs: 1_000,
};
const step = (input: Partial<Parameters<typeof decideGoalStep>[0]>) =>
  decideGoalStep({ progress, verdict: null, holdsOutsideInput: false, now: 0, ...input });

describe("parseGoalCommand", () => {
  it("reads a goal", () => {
    expect(parseGoalCommand("/goal the site works")).toEqual({
      kind: "set",
      goal: "the site works",
    });
    expect(parseGoalCommand("  /GOAL  tests\npass ")).toEqual({
      kind: "set",
      goal: "tests\npass",
    });
  });

  it("reads help and stop", () => {
    expect(parseGoalCommand("/goal")).toEqual({ kind: "help" });
    expect(parseGoalCommand("/goal stop")).toEqual({ kind: "stop" });
    expect(parseGoalCommand("/goal clear")).toEqual({ kind: "stop" });
  });

  it("leaves other text alone", () => {
    expect(parseGoalCommand("/goals")).toBeNull();
    expect(parseGoalCommand("my /goal is")).toBeNull();
  });
});

describe("readGoalVerdict", () => {
  it("reads met and blocked with this goal's nonce", () => {
    expect(readGoalVerdict(`Done.\n\nGOAL MET ${NONCE}`, NONCE)).toEqual({ verdict: "met" });
    expect(readGoalVerdict(`GOAL BLOCKED ${NONCE}: need the API key`, NONCE)).toEqual({
      verdict: "blocked",
      reason: "need the API key",
    });
  });

  it("takes the marker with markdown around it", () => {
    expect(readGoalVerdict(`**GOAL MET ${NONCE}**`, NONCE)).toEqual({ verdict: "met" });
  });

  it("ignores another goal's marker and a marker inside a sentence", () => {
    expect(readGoalVerdict("GOAL MET ffffff", NONCE)).toBeNull();
    expect(readGoalVerdict(`I will write GOAL MET ${NONCE} when done`, NONCE)).toBeNull();
    expect(readGoalVerdict("no marker here", NONCE)).toBeNull();
  });

  it("takes the last marker", () => {
    expect(readGoalVerdict(`GOAL BLOCKED ${NONCE}: x\nGOAL MET ${NONCE}`, NONCE)).toEqual({
      verdict: "met",
    });
  });
});

describe("stripGoalMarker", () => {
  it("removes the line and keeps the rest", () => {
    expect(stripGoalMarker(`All good.\n\nGOAL MET ${NONCE}`)).toBe("All good.");
    expect(stripGoalMarker("Nothing to strip")).toBe("Nothing to strip");
  });
});

describe("goal notes", () => {
  it("shows one quiet line", () => {
    const body = goalNoteBody({ goal: "site", nonce: NONCE, turn: 2, maxTurns: 10 });
    expect(body).toContain(`GOAL MET ${NONCE}`);
    expect(goalNoteLine(body)).toBe("Goal: turn 2 of 10.");
    expect(goalNoteLine("Something else")).toBeNull();
  });
});

describe("decideGoalStep", () => {
  it("goes on while nothing says stop", () => {
    expect(step({})).toEqual({ next: "continue" });
  });

  it("ends on the agent's word, even at a ceiling", () => {
    const atLimit = { ...progress, turnsUsed: 10 };
    expect(step({ verdict: { verdict: "met" }, progress: atLimit })).toMatchObject({
      status: "met",
      note: "Goal met in 10 turns.",
    });
    expect(step({ verdict: { verdict: "blocked", reason: "need a key" } })).toMatchObject({
      status: "blocked",
      note: "Needs you: need a key",
    });
  });

  it("stops at each ceiling", () => {
    expect(step({ progress: { ...progress, turnsUsed: 10 } })).toMatchObject({ status: "limit" });
    expect(step({ progress: { ...progress, costUsd: 10 } })).toMatchObject({ status: "limit" });
    expect(step({ now: 1_000 })).toMatchObject({ status: "limit" });
  });

  it("does not let unknown cost stop or pass a ceiling", () => {
    expect(step({ progress: { ...progress, costUsd: null } })).toEqual({ next: "continue" });
  });

  it("stops when text from outside reached the chat", () => {
    expect(step({ holdsOutsideInput: true })).toMatchObject({ status: "stopped" });
  });
});

describe("addReportedCost", () => {
  it("counts what a running total grew by, from the first report on", () => {
    let state: { usedUsd: number; lastReportedUsd: number | null } = {
      usedUsd: 0,
      lastReportedUsd: 12,
    };
    state = addReportedCost(state, 13);
    state = addReportedCost(state, 13.5);
    expect(state.usedUsd).toBeCloseTo(1.5);
  });

  it("starts over when a new session reports less", () => {
    const state = addReportedCost({ usedUsd: 2, lastReportedUsd: 5 }, 1);
    expect(state).toEqual({ usedUsd: 3, lastReportedUsd: 1 });
  });

  it("does not bill the first report: it may hold the whole chat's past", () => {
    expect(addReportedCost({ usedUsd: 0, lastReportedUsd: null }, 40).usedUsd).toBe(0);
  });
});
