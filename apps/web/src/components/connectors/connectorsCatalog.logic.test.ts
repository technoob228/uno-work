import { describe, expect, it } from "vitest";

import { computerConnectorItems, connectedSummary } from "./connectorsCatalog.logic";

describe("computerConnectorItems", () => {
  const computer = { id: "7", name: "mikhail-mbp", online: true, helperVersion: "0.1.0" };

  it("lists a computer the way the others are listed", () => {
    const [item] = computerConnectorItems([computer]);
    expect(item).toMatchObject({
      id: "computer:7",
      kind: "computer",
      name: "mikhail-mbp",
      connected: true,
      account: null,
    });
    expect(item?.tech).toBe("Uno Connect 0.1.0 · MCP uno-work › my_computer_*");
  });

  it("counts an offline computer as not connected right now", () => {
    const items = computerConnectorItems([{ ...computer, online: false, helperVersion: null }]);
    expect(items[0]?.connected).toBe(false);
    expect(items[0]?.tech).toContain("Uno Connect helper");
    expect(connectedSummary(items)).toBe("Nothing connected yet.");
  });
});
