import { describe, expect, it } from "vitest";

import {
  isPasteAsTextShortcut,
  nextPastedTextFileName,
  PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES,
  pastedTextDisposition,
  wouldTextPasteExceedLimit,
} from "./textPaste";

const big = "x".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES);

describe("pastedTextDisposition", () => {
  it("makes a big paste a file and leaves a small one in the box", () => {
    expect(pastedTextDisposition({ text: big, canAttach: true })).toBe("attachment");
    expect(pastedTextDisposition({ text: "hello", canAttach: true })).toBe("inline");
  });

  it("counts bytes, not characters", () => {
    const cyrillic = "я".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES / 2);
    expect(pastedTextDisposition({ text: cyrillic, canAttach: true })).toBe("attachment");
  });

  it("keeps text in the box when asked or when nothing can be attached", () => {
    expect(pastedTextDisposition({ text: big, canAttach: true, bypassAutoAttachment: true })).toBe(
      "inline",
    );
    expect(pastedTextDisposition({ text: big, canAttach: false })).toBe("inline");
  });

  it("makes a small paste a file when it would not fit the message", () => {
    expect(
      pastedTextDisposition({ text: "hello", canAttach: true, wouldExceedInputLimit: true }),
    ).toBe("attachment");
  });
});

describe("the rest of the paste rule", () => {
  it("names files without a clash", () => {
    expect(nextPastedTextFileName([])).toBe("pasted-text.txt");
    expect(nextPastedTextFileName(["Pasted-Text.txt", "pasted-text-2.txt"])).toBe(
      "pasted-text-3.txt",
    );
  });

  it("knows the paste-as-text shortcut per platform", () => {
    const event = { key: "V", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true };
    expect(isPasteAsTextShortcut(event, true)).toBe(true);
    expect(isPasteAsTextShortcut(event, false)).toBe(false);
  });

  it("checks the message limit against the selection", () => {
    const input = { valueLength: 10, textLength: 5, maxLength: 12 };
    expect(wouldTextPasteExceedLimit({ ...input, selection: { start: 10, end: 10 } })).toBe(true);
    expect(wouldTextPasteExceedLimit({ ...input, selection: { start: 0, end: 5 } })).toBe(false);
  });
});
