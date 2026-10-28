import { describe, expect, it } from "vitest";

import { EnvironmentHttpError } from "../../environments/http/target";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  AGENT_MAIL_RESERVED,
  agentMailChangeError,
  agentMailDomain,
  agentMailLocalProblem,
  agentMailPreview,
  agentMailRowVisible,
} from "./agentMail.logic";

const ENV = "env-1" as EnvironmentId;

describe("Email for your AI: the row", () => {
  it("shows only for a mailbox the console reports", () => {
    const mailbox = {
      address: "misha-otter@uno4.me",
      local: "misha-otter",
      createdAt: null,
      dailyLimit: 50,
      sentToday: 0,
    };
    expect(agentMailRowVisible({ available: true, reason: null, mailbox })).toBe(true);
    expect(agentMailRowVisible({ available: false, reason: "not_enabled", mailbox: null })).toBe(
      false,
    );
    expect(agentMailRowVisible({ available: false, reason: "not_enabled", mailbox })).toBe(false);
    expect(agentMailRowVisible({ available: true, reason: null, mailbox: null })).toBe(false);
    expect(
      agentMailRowVisible({ available: true, reason: null, mailbox: { ...mailbox, address: "" } }),
    ).toBe(false);
    expect(agentMailRowVisible(undefined)).toBe(false);
  });
});

describe("Email for your AI: Change name", () => {
  it("accepts names by the console's rule", () => {
    for (const name of ["misha-agent", "abc", "a.b-c9", "MISHA-Agent ", "x".repeat(40)]) {
      expect(agentMailLocalProblem(name), name).toBeNull();
    }
  });

  it("says what is wrong with a name, in one sentence", () => {
    expect(agentMailLocalProblem("")).toBe("Type a name.");
    expect(agentMailLocalProblem("ab")).toBe("At least 3 characters.");
    expect(agentMailLocalProblem("x".repeat(41))).toBe("At most 40 characters.");
    expect(agentMailLocalProblem("-misha")).toBe("Start with a letter or a digit.");
    expect(agentMailLocalProblem(".misha")).toBe("Start with a letter or a digit.");
    expect(agentMailLocalProblem("misha_agent")).toBe(
      "Only lowercase letters, digits, dots and dashes.",
    );
    expect(agentMailLocalProblem("misha agent")).toMatch(/Only lowercase/);
    expect(agentMailLocalProblem("misha--agent")).toBe("No two dashes in a row.");
    for (const reserved of AGENT_MAIL_RESERVED) {
      if (reserved.length < 3) continue;
      expect(agentMailLocalProblem(reserved), reserved).toMatch(/reserved/);
    }
    expect(agentMailLocalProblem("Postmaster")).toMatch(/reserved/);
  });

  it("previews the address on the mailbox's own domain", () => {
    expect(agentMailDomain("misha-otter@uno4.me")).toBe("uno4.me");
    expect(agentMailDomain(null)).toBe("uno4.me");
    expect(agentMailPreview(" Misha-Agent ", "uno4.me")).toBe("misha-agent@uno4.me");
    expect(agentMailPreview("", "uno4.me")).toBe("name@uno4.me");
  });

  it("turns the daemon's answers into the dialog's line", () => {
    expect(
      agentMailChangeError(
        new EnvironmentHttpError(409, "This name is taken. Try another one.", ENV),
      ),
    ).toBe("This name is taken. Try another one.");
    expect(agentMailChangeError(new EnvironmentHttpError(409, "", ENV))).toBe(
      "This name is taken. Try another one.",
    );
    expect(
      agentMailChangeError(new EnvironmentHttpError(422, "Names can't end with a dot.", ENV)),
    ).toBe("Names can't end with a dot.");
    expect(agentMailChangeError(new EnvironmentHttpError(422, "", ENV))).toMatch(/3–40 characters/);
    expect(
      agentMailChangeError(new EnvironmentHttpError(500, "Request failed with status 500.", ENV)),
    ).toBe("Couldn't change the name. Try again.");
    expect(agentMailChangeError("boom")).toBe("Couldn't change the name. Try again.");
  });
});
