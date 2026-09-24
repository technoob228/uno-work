import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { renderBrief, SOURCE, TARGET } from "../../scripts/embed-agent-context.ts";
import { UNO_WORK_TOOLS } from "../unoWork/tools.ts";
import { buildUnoWorkBrief } from "./unoWorkBrief.ts";
import { UNO_WORK_GUIDE_TOPICS, buildUnoWorkGuide } from "./guides.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("Uno Work environment brief", () => {
  it("is embedded from unoWorkBrief.md (run apps/server/scripts/embed-agent-context.ts)", () => {
    const markdown = readFileSync(path.join(root, SOURCE), "utf8");
    expect(readFileSync(path.join(root, TARGET), "utf8")).toBe(renderBrief(markdown));
  });

  it("stays under ~1.5k tokens", () => {
    // ~4 characters per token for English prose.
    expect(buildUnoWorkBrief().length / 4).toBeLessThan(1500);
  });

  it("names every uno-work tool, and only tools that exist", () => {
    const brief = buildUnoWorkBrief();
    const names = new Set(UNO_WORK_TOOLS.map((tool) => tool.name));
    for (const name of names) {
      expect(brief, `brief should mention ${name}`).toContain(`\`${name}\``);
    }
    const mentioned = [...brief.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((match) => match[1]!);
    for (const name of mentioned) {
      expect(names.has(name), `brief mentions unknown tool ${name}`).toBe(true);
    }
  });

  it("names every guide topic", () => {
    const brief = buildUnoWorkBrief();
    for (const topic of UNO_WORK_GUIDE_TOPICS.filter((entry) => entry !== "overview")) {
      expect(brief).toContain(`\`${topic}\``);
      expect(buildUnoWorkGuide(topic).length).toBeGreaterThan(200);
    }
  });

  it("keeps the safety rules and the plan ladder", () => {
    const brief = buildUnoWorkBrief();
    expect(brief).toContain("request_secret");
    expect(brief).toMatch(/Never ask for passwords, API keys or tokens in the chat/);
    expect(brief).toMatch(/Free: .* Small: .* Plus and up: an always-on cloud Uno Work computer/s);
  });
});
