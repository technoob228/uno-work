import { describe, expect, it } from "vitest";

import {
  formatEta,
  formatHourlyPrice,
  isPersonalAiModel,
  personalAiCanSend,
  personalAiModelId,
} from "./PersonalAiPanel";

const base = {
  id: "qwen3.8-27b-fp8",
  name: "Qwen 3.8 27B",
  size: "l",
  priceUsdPerHour: 6,
  idleSleepS: 60,
} as const;

describe("Personal AI helpers", () => {
  it("recognises a personal model by its metadata and strips the provider prefix", () => {
    expect(isPersonalAiModel({ metadata: { personal: { idleSleepS: 60 } } } as never)).toBe(true);
    expect(isPersonalAiModel({ metadata: { tier: "frontier" } } as never)).toBe(false);
    expect(isPersonalAiModel(undefined)).toBe(false);
    expect(personalAiModelId("uno-personal/qwen3.8-27b-fp8")).toBe("qwen3.8-27b-fp8");
  });

  it("holds the message until the model is up; a sleeping model wakes on send", () => {
    expect(personalAiCanSend({ ...base, state: "off" })).toBe(false);
    expect(personalAiCanSend({ ...base, state: "starting" })).toBe(false);
    expect(personalAiCanSend({ ...base, state: "failed" })).toBe(false);
    expect(personalAiCanSend({ ...base, state: "ready" })).toBe(true);
    expect(personalAiCanSend({ ...base, state: "sleeping" })).toBe(true);
    expect(personalAiCanSend(null)).toBe(true);
  });

  it("formats price per hour and time left in plain words", () => {
    expect(formatHourlyPrice(6)).toBe("$6.00/hour");
    expect(formatHourlyPrice(1.5)).toBe("$1.50/hour");
    expect(formatEta(30)).toBe("almost ready");
    expect(formatEta(70)).toBe("about 1 minute");
    expect(formatEta(290)).toBe("about 5 minutes");
  });
});
