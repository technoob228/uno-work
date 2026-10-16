import { afterEach, describe, expect, it, vi } from "vitest";

import {
  READABLE_PASSWORD_MIN_LENGTH,
  READABLE_PASSWORD_WORDS,
  formatLinkAndPassword,
  generateReadablePassword,
  randomBelow,
} from "./readablePassword";

const SHAPE = /^[a-z]{3,6}-[a-z]{3,6}-\d{4}-[a-z]{3,6}$/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("READABLE_PASSWORD_WORDS", () => {
  it("has 256 distinct short lowercase words", () => {
    expect(READABLE_PASSWORD_WORDS).toHaveLength(256);
    expect(new Set(READABLE_PASSWORD_WORDS).size).toBe(256);
    for (const word of READABLE_PASSWORD_WORDS) expect(word).toMatch(/^[a-z]{3,6}$/);
  });
});

describe("generateReadablePassword", () => {
  it("is words + four digits, at least 16 characters, from the word list", () => {
    for (let i = 0; i < 500; i += 1) {
      const password = generateReadablePassword();
      expect(password.length).toBeGreaterThanOrEqual(READABLE_PASSWORD_MIN_LENGTH);
      expect(password).toMatch(SHAPE);
      const [a, b, , c] = password.split("-");
      for (const word of [a, b, c]) expect(READABLE_PASSWORD_WORDS).toContain(word);
    }
  });

  it("never repeats itself back to back", () => {
    let previous = generateReadablePassword();
    const seen = new Set([previous]);
    for (let i = 0; i < 1000; i += 1) {
      const next = generateReadablePassword();
      expect(next).not.toBe(previous);
      seen.add(next);
      previous = next;
    }
    expect(seen.size).toBeGreaterThan(990);
  });

  it("draws from crypto.getRandomValues, not Math.random", () => {
    const cryptoSpy = vi.spyOn(globalThis.crypto, "getRandomValues");
    const mathSpy = vi.spyOn(Math, "random");
    generateReadablePassword();
    expect(cryptoSpy).toHaveBeenCalled();
    expect(mathSpy).not.toHaveBeenCalled();
  });

  it("re-draws values that would bias the result (rejection sampling)", () => {
    // For max = 10 the last 2^32 % 10 = 6 values are rejected.
    const values = [0xffff_ffff, 0xffff_fffa, 7];
    const random = (array: Uint32Array) => {
      array[0] = values.shift()!;
      return array;
    };
    expect(randomBelow(10, random)).toBe(7);
    expect(values).toHaveLength(0);
  });

  it("rejects a bad range", () => {
    expect(() => randomBelow(0)).toThrow(RangeError);
    expect(() => randomBelow(1.5)).toThrow(RangeError);
  });
});

describe("formatLinkAndPassword", () => {
  it("puts the password on its own line under the link", () => {
    expect(formatLinkAndPassword("https://x.uno4.me/s/abc", "maple-river-4821-quartz")).toBe(
      "https://x.uno4.me/s/abc\nPassword: maple-river-4821-quartz",
    );
  });
});
