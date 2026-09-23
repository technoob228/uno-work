/**
 * "Can comment" links on real files. The fixtures:
 *
 * - `comment-base.docx` — made by python-docx (not by our engine): heading,
 *   bold/italic runs, a tab, escaped characters, a hyperlink, a picture, a
 *   table, an empty paragraph and a line break;
 * - `comment-engine-added.docx` — that file opened in the ONLYOFFICE engine
 *   in comment mode (the exact config of a comment link), two comments added
 *   (start and end of the document, one with `<b>&"` in its text and a
 *   Cyrillic author), exported by the engine the way the share page saves;
 * - `comment-engine-text-edited.docx` — the same file opened in edit mode with
 *   "HACKED" typed in (what a crafted request through a comment link sends);
 * - `comment-engine-removed.docx` — the merged file (base + the two comments)
 *   reopened in the engine with every comment deleted.
 *
 * Recorded 2026-09-23 with the engine package the Work image ships (oo13).
 */
import fs from "node:fs";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import { COMMENT_ONLY_MESSAGE, docxBodyText, mergeDocxComments } from "./docxComments.ts";
import { readZip, writeZip } from "./zipPackage.ts";

const fixture = (name: string) =>
  new Uint8Array(fs.readFileSync(nodePath.join(import.meta.dirname, "fixtures", name)));

const BASE = fixture("comment-base.docx");
const ADDED = fixture("comment-engine-added.docx");
const EDITED = fixture("comment-engine-text-edited.docx");
const REMOVED = fixture("comment-engine-removed.docx");

const COMMENT_PARTS = [
  "word/comments.xml",
  "word/commentsExtended.xml",
  "word/commentsIds.xml",
  "word/commentsExtensible.xml",
  "word/people.xml",
];
const CHANGED_BY_MERGE = new Set([
  "word/document.xml",
  "word/_rels/document.xml.rels",
  "[Content_Types].xml",
  ...COMMENT_PARTS,
]);

function parts(bytes: Uint8Array): Map<string, Uint8Array> {
  return new Map(readZip(bytes).map((entry) => [entry.name, entry.data]));
}
const text = (bytes: Uint8Array, name: string) =>
  new TextDecoder().decode(parts(bytes).get(name) ?? new Uint8Array());

function merged(current: Uint8Array, upload: Uint8Array): Uint8Array {
  const result = mergeDocxComments({ current, upload });
  if (result.kind !== "merged") throw new Error(`rejected: ${result.message}`);
  return result.bytes;
}

describe("mergeDocxComments", () => {
  it("takes only the comments from the engine's file into the current one", () => {
    const result = mergeDocxComments({ current: BASE, upload: ADDED });
    expect(result.kind).toBe("merged");
    if (result.kind !== "merged") return;
    expect(result.comments).toBe(2);

    // Same text as before; every part but the comment wiring is the original, byte for byte.
    expect(docxBodyText(result.bytes)).toBe(docxBodyText(BASE));
    const before = parts(BASE);
    const after = parts(result.bytes);
    for (const [name, data] of before) {
      if (CHANGED_BY_MERGE.has(name)) continue;
      expect(Buffer.from(after.get(name)!).equals(Buffer.from(data)), name).toBe(true);
    }
    // Nothing of the engine's own package (its 1 MB styles, fonts, settings) came along.
    expect([...after.keys()].toSorted()).toEqual(
      [...new Set([...before.keys(), ...COMMENT_PARTS])].toSorted(),
    );

    const document = text(result.bytes, "word/document.xml");
    expect(document.match(/<w:commentRangeStart /g)).toHaveLength(2);
    expect(document.match(/<w:commentRangeEnd /g)).toHaveLength(2);
    expect(document.match(/<w:commentReference /g)).toHaveLength(2);
    const comments = text(result.bytes, "word/comments.xml");
    expect(comments).toContain(`Start &lt;b&gt;&amp;amp; "quoted"`);
    expect(comments).toContain('w:author="Другой гость"');
    expect(text(result.bytes, "word/_rels/document.xml.rels")).toContain('Target="comments.xml"');
    expect(text(result.bytes, "[Content_Types].xml")).toContain('PartName="/word/comments.xml"');
  });

  it("anchors a comment on the same words, splitting the run", () => {
    const document = text(merged(BASE, ADDED), "word/document.xml");
    // The engine anchored the first comment on the heading's first word.
    expect(document).toMatch(
      /<w:commentRangeStart w:id="\d+"\/><w:r[^>]*>(?:<w:rPr>.*?<\/w:rPr>)?<w:t xml:space="preserve">Uno<\/w:t><\/w:r><w:commentRangeEnd w:id="\d+"\/><w:r><w:commentReference w:id="\d+"\/><\/w:r><w:r[^>]*>(?:<w:rPr>.*?<\/w:rPr>)?<w:t xml:space="preserve"> comment fixture<\/w:t>/,
    );
  });

  it("refuses a file whose text changed", () => {
    const result = mergeDocxComments({ current: BASE, upload: EDITED });
    expect(result).toEqual({
      kind: "rejected",
      reason: "text_changed",
      message: COMMENT_ONLY_MESSAGE,
    });
  });

  it("a second save replaces the comments: deleting them removes the parts", () => {
    const withComments = merged(BASE, ADDED);
    // Saving the same comments again changes nothing but the zip packing.
    const again = merged(withComments, ADDED);
    expect(text(again, "word/document.xml")).toBe(text(withComments, "word/document.xml"));

    const cleared = mergeDocxComments({ current: withComments, upload: REMOVED });
    expect(cleared.kind).toBe("merged");
    if (cleared.kind !== "merged") return;
    expect(cleared.comments).toBe(0);
    const after = parts(cleared.bytes);
    for (const name of COMMENT_PARTS) expect(after.has(name), name).toBe(false);
    expect(text(cleared.bytes, "word/document.xml")).not.toMatch(/w:comment(Range|Reference)/);
    expect(text(cleared.bytes, "word/_rels/document.xml.rels")).not.toContain("comments");
    expect(text(cleared.bytes, "[Content_Types].xml")).not.toContain("comments");
  });

  it("ignores everything else a crafted upload carries", () => {
    // A request made by hand: the engine's file plus a macro part, new
    // styles and a changed picture — same text, so it isn't refused, but
    // none of it may land in the file.
    const entries = readZip(ADDED).map((entry) =>
      entry.name === "word/styles.xml"
        ? { name: entry.name, data: new TextEncoder().encode("<w:styles/>") }
        : entry.name.startsWith("word/media/")
          ? { name: entry.name, data: new Uint8Array([1, 2, 3]) }
          : entry,
    );
    entries.push({ name: "word/vbaProject.bin", data: new Uint8Array([0xde, 0xad]) });
    const result = merged(BASE, writeZip(entries));
    const after = parts(result);
    expect(after.has("word/vbaProject.bin")).toBe(false);
    expect(
      Buffer.from(after.get("word/styles.xml")!).equals(
        Buffer.from(parts(BASE).get("word/styles.xml")!),
      ),
    ).toBe(true);
    for (const [name, data] of parts(BASE)) {
      if (name.startsWith("word/media/")) {
        expect(Buffer.from(after.get(name)!).equals(Buffer.from(data))).toBe(true);
      }
    }
  });

  it("keeps comment text plain: no markup or relationships from the upload", () => {
    const entries = readZip(ADDED).map((entry) =>
      entry.name === "word/comments.xml"
        ? {
            name: entry.name,
            data: new TextEncoder().encode(
              new TextDecoder()
                .decode(entry.data)
                .replace(
                  "</w:comment>",
                  '<w:p><w:r><w:drawing><a:blip r:embed="rId99"/></w:drawing></w:r><w:hyperlink r:id="rId98"><w:r><w:t>click</w:t></w:r></w:hyperlink></w:p></w:comment>',
                ),
            ),
          }
        : entry,
    );
    const comments = text(merged(BASE, writeZip(entries)), "word/comments.xml");
    expect(comments).not.toContain("drawing");
    expect(comments).not.toContain("r:id");
    expect(comments).not.toContain("r:embed");
    expect(comments).toContain(">click<"); // the words survive, the link doesn't
  });

  it("refuses junk", () => {
    const junk = mergeDocxComments({
      current: BASE,
      upload: new Uint8Array([0x50, 0x4b, 3, 4, 0]),
    });
    expect(junk.kind).toBe("rejected");
    const doctype = readZip(ADDED).map((entry) =>
      entry.name === "word/document.xml"
        ? {
            name: entry.name,
            data: new TextEncoder().encode(
              '<!DOCTYPE x [<!ENTITY a "aaaa">]>' + new TextDecoder().decode(entry.data),
            ),
          }
        : entry,
    );
    const refused = mergeDocxComments({ current: BASE, upload: writeZip(doctype) });
    expect(refused.kind).toBe("rejected");
  });
});

describe("zip package", () => {
  it("round-trips entries", () => {
    const entries = readZip(BASE);
    const again = readZip(writeZip(entries));
    expect(again.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.name));
    for (const [index, entry] of again.entries()) {
      expect(Buffer.from(entry.data).equals(Buffer.from(entries[index]!.data))).toBe(true);
    }
  });

  it("stops at an entry that inflates past its declared size", () => {
    const big = new Uint8Array(1_000_000); // compresses to ~1 KB
    const zip = writeZip([{ name: "a.xml", data: big }]);
    // Lie about the size in the central directory: 10 bytes.
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const cd = view.getUint32(zip.length - 22 + 16, true);
    view.setUint32(cd + 24, 10, true);
    expect(() => readZip(zip)).toThrow();
  });
});
