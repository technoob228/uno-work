import { describe, expect, it } from "vitest";

import { localDocumentsIn, reportCheckPromptText, withReportLink } from "./reportCheck.ts";

describe("localDocumentsIn", () => {
  it("finds documents the person can't open", () => {
    expect(localDocumentsIn("Отчёт в docs/exports/WEEKLY-REPORT-2026-10-30.md готов")).toEqual([
      "docs/exports/WEEKLY-REPORT-2026-10-30.md",
    ]);
    expect(localDocumentsIn("Файл ~/Documents/итоги.pdf")).toEqual(["~/Documents/итоги.pdf"]);
  });

  it("is quiet about an answer with a link, and about plain text", () => {
    expect(localDocumentsIn("[отчёт](https://r-1.uno4.me/?k=a), файл report.md")).toEqual([]);
    expect(localDocumentsIn("Сделал всё, что просил. Версия 1.2.3 в проде.")).toEqual([]);
  });
});

describe("the net", () => {
  it("adds the link in the person's language", () => {
    expect(withReportLink("Готово. ", "https://x/", "ru")).toBe("Готово.\n\n[Отчёт](https://x/)");
    expect(withReportLink("Done.", "https://x/", "en")).toBe("Done.\n\n[Report](https://x/)");
  });

  it("asks Uno in a hidden prompt", () => {
    expect(reportCheckPromptText("a.md")).toMatch(/^\(Uno Work\) Report check:.*a\.md/);
  });
});
