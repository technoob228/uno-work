import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OFFICE_ENGINE_VERSION_HEADER,
  officeEngineApiUrl,
  officeEngineBase,
  probeOfficeEngine,
} from "./officeEngine";
import { isOfficeStandaloneLocation, officeStandaloneHref, OFFICE_SOURCE_URL } from "./officeLinks";
import { buildOfficePreview } from "./officePreviewModel";
import { officeEngineCacheName, officeEngineFilesFor } from "./officePrewarm";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function slideXml(title: string, line: string): string {
  return `<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p><a:p><a:r><a:t>${line}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
}

function response(headers: Record<string, string>, ok = true): Response {
  return { ok, headers: new Headers(headers) } as Response;
}

async function zipOf(parts: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(parts)) zip.file(name, body);
  return zip.generateAsync({ type: "uint8array" });
}

describe("office preview", () => {
  it("reads headings, paragraphs, lists and tables of a docx", async () => {
    const body = [
      '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Plan &amp; budget</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Q1</w:t></w:r></w:p>',
      '<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:tab/><w:t>world</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>first</w:t></w:r></w:p>',
      "<w:p/>",
      "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>",
      "<w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>",
    ].join("");
    const bytes = await zipOf({
      "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
    });
    const model = await buildOfficePreview(bytes, "docx");
    expect(model?.blocks).toEqual([
      { kind: "heading", level: 1, text: "Plan & budget" },
      { kind: "heading", level: 2, text: "Q1" },
      { kind: "paragraph", text: "Hello world" },
      { kind: "listItem", text: "first" },
      {
        kind: "table",
        rows: [
          ["A1", "B1"],
          ["A2", ""],
        ],
      },
    ]);
    expect(model?.truncated).toBe(false);
  });

  it("reads the first sheet of an xlsx with shared and inline strings", async () => {
    const bytes = await zipOf({
      "xl/workbook.xml":
        '<workbook xmlns:r="r"><sheets><sheet name="Data" sheetId="7" r:id="rId3"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId3" Target="worksheets/sheet9.xml"/></Relationships>',
      "xl/sharedStrings.xml":
        "<sst><si><t>Region</t></si><si><r><t>No</t></r><r><t>rth</t></r></si></sst>",
      "xl/worksheets/sheet9.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Q1</t></is></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><f>1+1</f><v>2</v></c><c r="C2" t="b"><v>1</v></c></row></sheetData></worksheet>',
    });
    const model = await buildOfficePreview(bytes, "xlsx");
    expect(model?.blocks).toEqual([
      {
        kind: "table",
        rows: [
          ["Region", "", "Q1"],
          ["North", "2", "TRUE"],
        ],
      },
    ]);
  });

  it("reads slide text in slide order", async () => {
    const bytes = await zipOf({
      "ppt/slides/slide10.xml": slideXml("Ten", "last"),
      "ppt/slides/slide2.xml": slideXml("Two", "middle"),
      "ppt/slides/slide1.xml": slideXml("One", "first"),
    });
    const model = await buildOfficePreview(bytes, "pptx");
    expect(model?.blocks).toEqual([
      { kind: "slide", index: 1, lines: ["One", "first"] },
      { kind: "slide", index: 2, lines: ["Two", "middle"] },
      { kind: "slide", index: 10, lines: ["Ten", "last"] },
    ]);
  });

  it("gives up quietly on other formats and broken files", async () => {
    expect(await buildOfficePreview(new Uint8Array([1, 2, 3]), "docx")).toBeNull();
    expect(await buildOfficePreview(await zipOf({ "a.txt": "x" }), "doc")).toBeNull();
    expect(await buildOfficePreview(await zipOf({ "a.txt": "x" }), "docx")).toBeNull();
  });
});

describe("office engine probe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("switches engine URLs to the versioned path the daemon reports", async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        "content-type": "text/javascript",
        [OFFICE_ENGINE_VERSION_HEADER]: "0123456789ab",
      }),
    );
    expect(await probeOfficeEngine(fetchImpl as unknown as typeof fetch)).toEqual({
      installed: true,
      version: "0123456789ab",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/office-engine/vendor/web-apps/apps/api/documents/api.js",
      expect.objectContaining({ method: "HEAD", cache: "no-store" }),
    );
    expect(officeEngineBase()).toBe("/office-engine/v/0123456789ab/");
    expect(officeEngineApiUrl()).toBe(
      "/office-engine/v/0123456789ab/vendor/web-apps/apps/api/documents/api.js",
    );
  });

  it("keeps the old path for an older daemon and ignores junk versions", async () => {
    const old = vi.fn(async () => response({ "content-type": "text/javascript" }));
    expect(await probeOfficeEngine(old as unknown as typeof fetch)).toEqual({
      installed: true,
      version: null,
    });
    expect(officeEngineBase()).toBe("/office-engine/");
    const junk = vi.fn(async () =>
      response({ "content-type": "text/javascript", [OFFICE_ENGINE_VERSION_HEADER]: "../x" }),
    );
    expect((await probeOfficeEngine(junk as unknown as typeof fetch)).version).toBeNull();
  });

  it("an SPA fallback page is not the engine", async () => {
    const spa = vi.fn(async () => response({ "content-type": "text/html" }));
    expect(await probeOfficeEngine(spa as unknown as typeof fetch)).toEqual({
      installed: false,
      version: null,
    });
  });
});

describe("office prewarm lists", () => {
  it("names each editor's files and the worker's cache", () => {
    expect(officeEngineFilesFor("word")).toContain("vendor/sdkjs/word/sdk-all.js");
    expect(officeEngineFilesFor("cell")).toContain(
      "vendor/web-apps/apps/spreadsheeteditor/main/app.js",
    );
    expect(officeEngineFilesFor("slide")).toContain("vendor/sdkjs/slide/sdk-all-min.js");
    expect(officeEngineCacheName("0123456789ab")).toBe("uno-office-engine-0123456789ab");
  });
});

describe("office links", () => {
  it("builds the standalone tab URL for local and cloud documents", () => {
    expect(officeStandaloneHref({ path: "/home/u/Plan Q1.docx" })).toBe(
      "/office?path=%2Fhome%2Fu%2FPlan+Q1.docx&tab=1",
    );
    expect(
      officeStandaloneHref({
        path: "docs/a.xlsx",
        cloud: { bucketId: 4, key: "docs/a.xlsx" },
        environmentId: "env-b",
        primaryEnvironmentId: "env-a",
      }),
    ).toBe("/office?bucket=4&key=docs%2Fa.xlsx&tab=1&env=env-b");
    expect(
      officeStandaloneHref({
        path: "/a.docx",
        environmentId: "env-a",
        primaryEnvironmentId: "env-a",
      }),
    ).toBe("/office?path=%2Fa.docx&tab=1");
  });

  it("recognises the standalone tab", () => {
    expect(isOfficeStandaloneLocation("/office", { path: "/a.docx", tab: true })).toBe(true);
    expect(isOfficeStandaloneLocation("/office", { path: "/a.docx", tab: "1" })).toBe(true);
    expect(isOfficeStandaloneLocation("/office", { path: "/a.docx" })).toBe(false);
    expect(isOfficeStandaloneLocation("/files", { tab: true })).toBe(false);
  });

  it("points at the published patches", () => {
    expect(OFFICE_SOURCE_URL).toBe("https://github.com/technoob228/onlyoffice-uno-patches");
  });
});
