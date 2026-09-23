import { describe, expect, it } from "vitest";

import { officeShareInboxPost } from "./http.ts";

describe("Office share saves → Inbox", () => {
  it("names the visitor and the file, and folds repeats of one visitor", () => {
    const post = officeShareInboxPost({
      shareId: "sh1",
      access: "comment",
      filePath: "/home/unowork/Documents/report.docx",
      visitorHeader: encodeURIComponent("Борис"),
    });
    expect(post).toMatchObject({
      kind: "app",
      source: { kind: "app", id: "office", name: "Office" },
      title: "Борис commented on report.docx",
      open: { kind: "file", path: "/home/unowork/Documents/report.docx" },
      groupKey: "office:sh1:comment:борис",
    });
  });

  it("says Someone without a name, and never trusts a broken header", () => {
    expect(
      officeShareInboxPost({
        shareId: "sh1",
        access: "edit",
        filePath: "/h/plan.xlsx",
        visitorHeader: "%E0%A4%A",
      }).title,
    ).toBe("Someone edited plan.xlsx");
  });
});
