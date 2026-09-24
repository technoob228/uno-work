import { describe, expect, it } from "vitest";

import { cleanUnoFinalAnswerText } from "./unoFinalAnswer.ts";

describe("cleanUnoFinalAnswerText", () => {
  it("leaves ordinary text alone", () => {
    expect(cleanUnoFinalAnswerText("Hello <b>world</b>\n")).toBe("Hello <b>world</b>\n");
    expect(cleanUnoFinalAnswerText("a < b")).toBe("a < b");
  });

  it("drops the thinking before the opening marker and the closing marker", () => {
    expect(
      cleanUnoFinalAnswerText(
        "The user wants X. I should answer.\n<uno_final_answer>\nГотово: 12 машин.\n</uno_final_answer>",
      ),
    ).toBe("Готово: 12 машин.");
  });

  it("removes a lone opening or closing tag (Kimi K2.7)", () => {
    expect(cleanUnoFinalAnswerText("<uno_final_answer>\nDone.")).toBe("Done.");
    expect(cleanUnoFinalAnswerText("Done.\n</uno_final_answer>")).toBe("Done.");
  });

  it("handles casing, spaces and self-closing forms", () => {
    expect(cleanUnoFinalAnswerText("< UNO_FINAL_ANSWER >Done.< /uno_final_answer >")).toBe("Done.");
    expect(cleanUnoFinalAnswerText("<uno_final_answer/>Done.")).toBe("Done.");
  });

  it("removes a marker cut off at the end of a stream, but not a bare '<'", () => {
    expect(cleanUnoFinalAnswerText("Done.\n</uno_fin")).toBe("Done.");
    expect(cleanUnoFinalAnswerText("thinking <uno_f")).toBe("thinking");
    expect(cleanUnoFinalAnswerText("x <")).toBe("x <");
  });
});
