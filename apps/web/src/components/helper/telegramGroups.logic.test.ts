import type { ManagerTelegramGroupView } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  groupDisplayName,
  pickablePeople,
  selectedIds,
  togglePerson,
} from "./telegramGroups.logic";

const person = (id: string, name: string, flags: { owner?: boolean; selected?: boolean } = {}) => ({
  id,
  name,
  username: null,
  owner: flags.owner ?? false,
  selected: flags.selected ?? false,
  allowed: (flags.owner ?? false) || (flags.selected ?? false),
});

const family: ManagerTelegramGroupView = {
  chatId: "-100111",
  title: "Family",
  members: "selected",
  people: [
    person("42", "Misha", { owner: true }),
    person("7", "Anna", { selected: true }),
    person("8", "Dima"),
  ],
};

describe("the Groups section", () => {
  it("names a group by its Telegram name, then the owner's label, then its id", () => {
    expect(groupDisplayName(family, {})).toBe("Family");
    expect(groupDisplayName({ chatId: "-1", title: null }, { "-1": "Team" })).toBe("Team");
    expect(groupDisplayName({ chatId: "-1", title: null }, {})).toBe("Group -1");
  });

  it("offers everyone but the owner to pick from", () => {
    expect(pickablePeople(family).map((p) => p.name)).toEqual(["Anna", "Dima"]);
    expect(selectedIds(family)).toEqual(["7"]);
  });

  it("a press picks a person, a second press lets them go", () => {
    expect(togglePerson(family, "8")).toEqual(["7", "8"]);
    expect(togglePerson(family, "7")).toEqual([]);
  });
});
