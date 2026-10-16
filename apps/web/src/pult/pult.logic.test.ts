import { describe, expect, it } from "vitest";

import { PULT_DEMO_DATA } from "../demo/pultFixtures";
import { dispatch, glanceLine, groupTasks, indexPult, openNeeds, ownerMinutes, relTime } from "./pult.logic";
import { effectiveTasks } from "./pultStore";

const ix = indexPult(PULT_DEMO_DATA);

describe("pult board", () => {
  it("puts a task that waits for the owner only under «Нужен ты»", () => {
    const needs = openNeeds(PULT_DEMO_DATA.tasks).map((t) => t.id);
    const inGroups = groupTasks(PULT_DEMO_DATA.tasks).flatMap((g) => g.tasks.map((t) => t.id));
    expect(needs).toContain("T07");
    expect(inGroups).not.toContain("T07");
    expect(needs.filter((id) => inGroups.includes(id))).toEqual([]);
  });

  it("folds later and done, keeps blocked/doing/review open", () => {
    const groups = groupTasks(PULT_DEMO_DATA.tasks);
    expect(groups.filter((g) => g.folded).map((g) => g.id)).toEqual(["later", "done"]);
  });

  it("says where and how long in one line", () => {
    const line = glanceLine(PULT_DEMO_DATA.tasks);
    expect(line.count).toBe(openNeeds(PULT_DEMO_DATA.tasks).length);
    expect(line.minutes).toBe(ownerMinutes(PULT_DEMO_DATA.tasks));
    expect(glanceLine([]).text).toMatch(/не нужен/);
  });

  it("an answer takes the task out of «Нужен ты» and back to work", () => {
    const tasks = effectiveTasks({
      data: PULT_DEMO_DATA,
      answers: { T07: { label: "Всем по промокоду", at: 1 } },
      order: [],
      priority: {},
    });
    const t07 = tasks.find((t) => t.id === "T07")!;
    expect(t07.status).toBe("doing");
    expect(openNeeds(tasks).map((t) => t.id)).not.toContain("T07");
  });

  it("manual order becomes the rank", () => {
    const tasks = effectiveTasks({ data: PULT_DEMO_DATA, answers: {}, order: ["T21", "T07"], priority: { T21: "P0" } });
    expect(tasks.find((t) => t.id === "T21")).toMatchObject({ rank: 1, priority: "P0" });
  });

  it("relative time", () => {
    const now = Date.parse("2026-10-16T00:20:00Z");
    expect(relTime("2026-10-16T00:15:00Z", now)).toBe("5 мин назад");
    expect(relTime("2026-10-16T02:20:00Z", now)).toBe("через 2 ч");
  });
});

describe("pult dispatcher", () => {
  it("«нужна ли помощь спаркам» → yes, with the request", () => {
    const a = dispatch("нужна ли помощь спаркам?", 0, ix);
    expect(a.intent).toBe("need-one");
    expect(a.cards[0]).toEqual({ type: "need", task: "T33" });
  });

  it("a screenshot with a fix goes to the chat of the task", () => {
    const a = dispatch("на экране биллинга кнопку переделать", 1, ix);
    expect(a.intent).toBe("feedback");
    expect(a.actions[0]?.act).toMatchObject({ type: "send", task: "T30" });
  });

  it("«пинг всем» goes to the live chats only", () => {
    const a = dispatch("пинг всем: статус одной строкой", 0, ix);
    const card = a.cards[0];
    expect(card?.type).toBe("broadcast");
    if (card?.type === "broadcast") expect(card.chats).not.toContain("ch-billing");
  });
});
