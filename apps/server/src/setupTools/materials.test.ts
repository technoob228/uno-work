import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { writeZip } from "../files/zipPackage.ts";
import {
  gatewayModelFromSelection,
  makeGatewayMaterialsModel,
  parseLearned,
} from "./materialsAdapters.ts";
import { extractFile, extractLink, htmlToText } from "./materialsExtract.ts";
import {
  makeMaterialsJobs,
  MATERIALS_SUMMARY_MARKER,
  NO_GATEWAY_ERROR,
  type MaterialsCloudUpload,
  type MaterialsJobView,
  type MaterialsModel,
} from "./materialsJob.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "uno-materials-"));
  tempDirs.push(dir);
  return dir;
}

const enc = (text: string) => new TextEncoder().encode(text);

function zipFile(filePath: string, entries: Record<string, string>) {
  writeFileSync(
    filePath,
    writeZip(Object.entries(entries).map(([name, text]) => ({ name, data: enc(text) }))),
  );
}

let linkServer: http.Server;
let linkBase = "";

beforeAll(async () => {
  linkServer = http.createServer((req, res) => {
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<html><head><title>Pricing</title><style>.x{}</style></head><body><script>evil()</script><h1>Plans</h1><p>Pro is $20 &amp; up.</p></body></html>",
      );
      return;
    }
    if (req.url === "/image") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end("png");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => linkServer.listen(0, "127.0.0.1", resolve));
  linkBase = `http://127.0.0.1:${(linkServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => linkServer.close(() => resolve()));
});

describe("text extraction", () => {
  it("reads plain text formats directly", async () => {
    const dir = tempDir();
    const cases: Record<string, string> = {
      "notes.md": "# Notes\nShip on Friday.",
      "list.txt": "milk\neggs",
      "data.csv": "name,price\nPro,20",
      "config.json": '{"tone":"friendly"}',
      "spec.yaml": "tone: friendly",
    };
    for (const [name, text] of Object.entries(cases)) {
      writeFileSync(path.join(dir, name), text);
      const result = await extractFile(path.join(dir, name));
      expect(result.state, name).toBe("read");
      expect(result.text, name).toBe(text);
    }
  });

  it("strips HTML and XML", async () => {
    const dir = tempDir();
    writeFileSync(
      path.join(dir, "page.html"),
      "<html><body><script>x()</script><p>Hello &amp; welcome</p><p>Second</p></body></html>",
    );
    writeFileSync(
      path.join(dir, "feed.xml"),
      "<rss><item><title>News &lt;1&gt;</title></item></rss>",
    );
    expect((await extractFile(path.join(dir, "page.html"))).text).toBe("Hello & welcome\nSecond");
    expect((await extractFile(path.join(dir, "feed.xml"))).text).toBe("News <1>");
    expect(htmlToText("<title>T</title><p>Body</p>")).toBe("T\n\nBody");
  });

  it("reads only the first 200 KB of a big text file", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "big.txt"), "a".repeat(300 * 1024));
    const result = await extractFile(path.join(dir, "big.txt"));
    expect(result.state).toBe("read");
    expect(result.note).toContain("first 200 KB");
    expect(result.text!.length).toBeLessThanOrEqual(48_000);
  });

  it("unzips docx, pptx, xlsx and odt", async () => {
    const dir = tempDir();
    zipFile(path.join(dir, "brief.docx"), {
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        '<w:document><w:body><w:p><w:r><w:t>Brand brief</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Colors: navy &amp; gold</w:t></w:r></w:p></w:body></w:document>',
      "word/media/image1.png": "not text",
    });
    zipFile(path.join(dir, "deck.pptx"), {
      "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Roadmap</a:t></a:r></a:p></p:sld>",
      "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Welcome</a:t></a:r></a:p></p:sld>",
    });
    zipFile(path.join(dir, "prices.xlsx"), {
      "xl/workbook.xml": '<workbook><sheets><sheet name="Plans" sheetId="1"/></sheets></workbook>',
      "xl/sharedStrings.xml": "<sst><si><t>Pro</t></si><si><t>Team</t></si></sst>",
    });
    zipFile(path.join(dir, "letter.odt"), {
      mimetype: "application/vnd.oasis.opendocument.text",
      "content.xml":
        "<office:document-content><text:p>Dear team,</text:p><text:p>Thanks</text:p></office:document-content>",
    });
    expect((await extractFile(path.join(dir, "brief.docx"))).text).toBe(
      "Brand brief\nColors: navy & gold",
    );
    expect((await extractFile(path.join(dir, "deck.pptx"))).text).toBe(
      "Slide 1: Welcome\n\nSlide 2: Roadmap",
    );
    expect((await extractFile(path.join(dir, "prices.xlsx"))).text).toBe(
      "Sheets: Plans\n\nPro\nTeam",
    );
    expect((await extractFile(path.join(dir, "letter.odt"))).text).toBe("Dear team,\nThanks");
  });

  it("marks a broken Office file as failed", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "broken.docx"), "not a zip");
    const result = await extractFile(path.join(dir, "broken.docx"));
    expect(result.state).toBe("failed");
    expect(result.note).toContain("damaged");
  });

  it("reads PDFs through pdftotext and skips them when it isn't installed", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "guide.pdf"), "%PDF-1.4");
    const read = await extractFile(path.join(dir, "guide.pdf"), {
      run: async (command, args) => {
        expect(command).toBe("pdftotext");
        expect(args.at(-1)).toBe("-");
        return {
          stdout: "Brand guide\nUse navy.",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        };
      },
    });
    expect(read).toEqual({ state: "read", text: "Brand guide\nUse navy.", note: null });
    const missing = await extractFile(path.join(dir, "guide.pdf"), {
      run: async () => {
        throw new Error("Command not found: pdftotext");
      },
    });
    expect(missing.state).toBe("skipped");
    expect(missing.note).toContain("pdftotext");
  });

  it("names images and lists zip archives", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "logo.png"), "png");
    zipFile(path.join(dir, "assets.zip"), { "a.txt": "a", "fonts/b.ttf": "b" });
    expect(await extractFile(path.join(dir, "logo.png"))).toEqual({
      state: "read",
      text: null,
      note: "image",
    });
    const zip = await extractFile(path.join(dir, "assets.zip"));
    expect(zip.state).toBe("read");
    expect(zip.text).toContain("a.txt");
    expect(zip.text).toContain("fonts/b.ttf");
    expect(zip.note).toContain("2 entries");
  });

  it("skips unknown types", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "movie.mov"), "x");
    expect((await extractFile(path.join(dir, "movie.mov"))).state).toBe("skipped");
  });

  it("fetches a link and keeps only the page's text", async () => {
    const page = await extractLink(`${linkBase}/page`);
    expect(page.state).toBe("read");
    expect(page.text).toBe("Pricing\n\nPlans\nPro is $20 & up.");
    expect((await extractLink(`${linkBase}/image`)).state).toBe("skipped");
    expect((await extractLink(`${linkBase}/missing`)).state).toBe("failed");
    const metadata = await extractLink("http://169.254.169.254/latest/meta-data/");
    expect(metadata.state).toBe("failed");
    expect(metadata.note).toMatch(/internal network/);
    expect((await extractLink("ftp://example.com/x")).state).toBe("failed");
  });
});

function fakeModel(): MaterialsModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    summarizeItem: async ({ name, text }) => {
      calls.push(name);
      return `${name} says ${text.slice(0, 13)}\nignored second line`;
    },
    learned: async (items) =>
      items.slice(0, 3).map((item) => `- Topic: ${item.summary} from ${item.name}`),
  };
}

function fakeCloud(options: { failOn?: string } = {}) {
  const uploaded: string[] = [];
  const cloud: MaterialsCloudUpload = {
    displayPath: "acme/materials",
    upload: async ({ relativeName }) => {
      if (relativeName === options.failOn) throw new Error("storage answered 500");
      uploaded.push(relativeName);
    },
  };
  return { cloud, uploaded };
}

function project(files: Record<string, string>) {
  const root = path.join(tempDir(), "acme");
  mkdirSync(path.join(root, "materials"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, "materials", name)), { recursive: true });
    writeFileSync(path.join(root, "materials", name), text);
  }
  return root;
}

describe("materials job", () => {
  it("reads every item, summarizes, writes README.md and saves to Cloud storage", async () => {
    const root = project({
      "brand-guide.md": "Navy and gold, friendly tone.",
      "notes/meeting.txt": "Launch on Friday.",
      "notes/deeper/too-deep.txt": "not read",
      ".secret.env": "KEY=1",
      "logo.png": "png",
    });
    symlinkSync("/etc/hosts", path.join(root, "materials", "link.txt"));
    const model = fakeModel();
    const { cloud, uploaded } = fakeCloud();
    const jobs = makeMaterialsJobs({ model: async () => model, cloud: async () => cloud });

    const { jobId } = await jobs.start({ projectPath: root, links: [`${linkBase}/page`] });
    const first = jobs.get(jobId)!;
    expect(first.state).toBe("running");
    expect(first.items.map((item) => [item.name, item.kind])).toEqual([
      ["brand-guide.md", "file"],
      ["logo.png", "file"],
      ["notes/meeting.txt", "file"],
      [`${linkBase}/page`, "link"],
    ]);
    expect(first.items.every((item) => item.state === "queued" || item.state === "reading")).toBe(
      true,
    );

    await jobs.settled(jobId);
    const done = jobs.get(jobId)!;
    expect(done.state).toBe("done");
    expect(done.error).toBeNull();
    expect(done.items.map((item) => item.state)).toEqual(["read", "read", "read", "read"]);
    expect(done.items[0]!.note).toBe("brand-guide.md says Navy and gold");
    expect(done.items[1]!.note).toBe("image");
    expect(done.learned).toHaveLength(3);
    expect(done.learned[0]).toBe("Topic: brand-guide.md says Navy and gold from brand-guide.md");
    expect(done.savedToCloud).toBe("acme/materials");
    expect(uploaded.toSorted()).toEqual(["brand-guide.md", "logo.png", "notes/meeting.txt"]);
    expect(model.calls).not.toContain("logo.png");

    expect(done.summaryPath).toBe(path.join(await realRoot(root), "materials", "README.md"));
    const readme = readFileSync(done.summaryPath!, "utf8");
    expect(readme).toContain(MATERIALS_SUMMARY_MARKER);
    expect(readme).toContain("# What your AI learned from this folder");
    expect(readme).toContain("- `brand-guide.md` — brand-guide.md says Navy and gold");
    expect(readme).toContain(`- ${linkBase}/page — `);
    expect(readme).toContain("acme/materials");

    // A second read skips the README it wrote itself.
    const again = await jobs.start({ projectPath: root, links: [] });
    await jobs.settled(again.jobId);
    expect(jobs.get(again.jobId)!.items.map((item) => item.name)).not.toContain("README.md");
  });

  it("moves items through queued → reading → read as the UI polls", async () => {
    const root = project({ "a.txt": "A", "b.txt": "B" });
    const states: Array<MaterialsJobView["items"]> = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const jobs = makeMaterialsJobs({
      model: async () => ({
        summarizeItem: async ({ name }) => {
          if (name === "a.txt") await gate;
          return `about ${name}`;
        },
        learned: async () => ["Topic: letters from a.txt"],
      }),
      cloud: async () => null,
    });
    const { jobId } = await jobs.start({ projectPath: root, links: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    states.push(jobs.get(jobId)!.items);
    release();
    await jobs.settled(jobId);
    states.push(jobs.get(jobId)!.items);
    expect(states[0]!.map((item) => item.state)).toEqual(["reading", "queued"]);
    expect(states[1]!.map((item) => item.state)).toEqual(["read", "read"]);
    expect(jobs.get(jobId)!.savedToCloud).toBeNull();
  });

  it("still extracts without Uno AI and says why nothing was learned", async () => {
    const root = project({ "a.txt": "A" });
    const jobs = makeMaterialsJobs({ model: async () => null, cloud: async () => null });
    const { jobId } = await jobs.start({ projectPath: root, links: [] });
    await jobs.settled(jobId);
    const job = jobs.get(jobId)!;
    expect(job.state).toBe("done");
    expect(job.items[0]!.state).toBe("read");
    expect(job.learned).toEqual([]);
    expect(job.error).toBe(NO_GATEWAY_ERROR);
    expect(readFileSync(job.summaryPath!, "utf8")).toContain("Uno AI wasn't available");
  });

  it("notes a failed Cloud upload on the item and leaves savedToCloud null", async () => {
    const root = project({ "a.txt": "A", "b.txt": "B" });
    const { cloud, uploaded } = fakeCloud({ failOn: "b.txt" });
    const jobs = makeMaterialsJobs({ model: async () => fakeModel(), cloud: async () => cloud });
    const { jobId } = await jobs.start({ projectPath: root, links: [] });
    await jobs.settled(jobId);
    const job = jobs.get(jobId)!;
    expect(job.state).toBe("done");
    expect(uploaded).toEqual(["a.txt"]);
    expect(job.savedToCloud).toBeNull();
    expect(job.items[1]!.note).toContain("not saved to Cloud storage: storage answered 500");
    expect(job.items[0]!.note).not.toContain("Cloud");
  });

  it("notes an unreachable Cloud storage on every file", async () => {
    const root = project({ "a.txt": "A" });
    const jobs = makeMaterialsJobs({
      model: async () => fakeModel(),
      cloud: async () => {
        throw new Error("Couldn't reach Cloud storage.");
      },
    });
    const { jobId } = await jobs.start({ projectPath: root, links: [] });
    await jobs.settled(jobId);
    expect(jobs.get(jobId)!.items[0]!.note).toContain("not saved to Cloud storage");
    expect(jobs.get(jobId)!.savedToCloud).toBeNull();
  });

  it("keeps a README.md the person wrote and writes the summary next to it", async () => {
    const root = project({ "README.md": "My own notes", "a.txt": "A" });
    const jobs = makeMaterialsJobs({ model: async () => fakeModel(), cloud: async () => null });
    const { jobId } = await jobs.start({ projectPath: root, links: [] });
    await jobs.settled(jobId);
    const job = jobs.get(jobId)!;
    expect(job.items.map((item) => item.name)).toEqual(["a.txt"]);
    expect(readFileSync(path.join(root, "materials", "README.md"), "utf8")).toBe("My own notes");
    expect(job.summaryPath!.endsWith("UNO-SUMMARY.md")).toBe(true);
  });

  it("refuses a missing folder, a relative path and a second run on the same folder", async () => {
    const root = project({ "a.txt": "A" });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const jobs = makeMaterialsJobs({
      model: async () => {
        await gate;
        return null;
      },
      cloud: async () => null,
    });
    await expect(jobs.start({ projectPath: "relative/path", links: [] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      jobs.start({ projectPath: path.join(root, "nope"), links: [] }),
    ).rejects.toMatchObject({ status: 404 });
    const first = await jobs.start({ projectPath: root, links: [] });
    await expect(jobs.start({ projectPath: root, links: [] })).rejects.toMatchObject({
      status: 409,
      jobId: first.jobId,
    });
    release();
    await jobs.settled(first.jobId);
    const owned = makeMaterialsJobs({
      model: async () => null,
      cloud: async () => null,
      ownerUid: 123_456,
    });
    await expect(owned.start({ projectPath: root, links: [] })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("forgets finished jobs after an hour", async () => {
    const root = project({ "a.txt": "A" });
    let clock = 0;
    const jobs = makeMaterialsJobs({
      model: async () => null,
      cloud: async () => null,
      now: () => clock,
    });
    const { jobId } = await jobs.start({ projectPath: root, links: [] });
    await jobs.settled(jobId);
    clock += 59 * 60 * 1000;
    expect(jobs.get(jobId)).not.toBeNull();
    clock += 2 * 60 * 1000;
    expect(jobs.get(jobId)).toBeNull();
  });
});

async function realRoot(root: string) {
  const { realpath } = await import("node:fs/promises");
  return realpath(root);
}

const driverOf = (id: string) => ({ uno: "uno", codex: "codex" })[id];

describe("gateway model", () => {
  it("uses the Uno text-generation model and the gateway key", async () => {
    const requests: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const model = makeGatewayMaterialsModel({
      baseUrl: "https://gateway.test/v1/",
      apiKey: "unollm_key",
      model: "~deepseek/deepseek-v4-flash-latest",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          auth: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        const isLearned = requests.length === 2;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: isLearned
                    ? '```json\n{"learned":["Brand: colors from brand-guide.pdf"]}\n```'
                    : "A brand guide.",
                },
              },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(await model.summarizeItem({ name: "brand-guide.pdf", kind: "file", text: "Navy" })).toBe(
      "A brand guide.",
    );
    expect(await model.learned([{ name: "brand-guide.pdf", summary: "A brand guide." }])).toEqual([
      "Brand: colors from brand-guide.pdf",
    ]);
    expect(requests[0]).toMatchObject({
      url: "https://gateway.test/v1/chat/completions",
      auth: "Bearer unollm_key",
      body: {
        model: "~deepseek/deepseek-v4-flash-latest",
        max_tokens: 400,
        reasoning: { enabled: false },
      },
    });
    expect(JSON.stringify(requests[0]!.body)).toContain("untrusted_thread_output");
  });

  it("falls back to a second model when the first answers with no text", async () => {
    const models: string[] = [];
    const model = makeGatewayMaterialsModel({
      baseUrl: "https://gateway.test/v1",
      apiKey: "unollm_key",
      model: "~deepseek/deepseek-v4-flash-latest",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        models.push(body.model);
        const content =
          body.model === "~deepseek/deepseek-v4-flash-latest" ? null : "A price list.";
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
        });
      }) as typeof fetch,
    });
    expect(await model.summarizeItem({ name: "p.csv", kind: "file", text: "a,b" })).toBe(
      "A price list.",
    );
    expect(models).toEqual(["~deepseek/deepseek-v4-flash-latest", "moonshotai/kimi-k2.6"]);
  });

  it("picks the gateway model id out of the text-generation setting", () => {
    expect(gatewayModelFromSelection({ instanceId: "uno", model: "uno/~x/y" }, driverOf)).toBe(
      "~x/y",
    );
    expect(
      gatewayModelFromSelection({ instanceId: "codex", model: "gpt-5.4-mini" }, driverOf),
    ).toBe("~deepseek/deepseek-v4-flash-latest");
    expect(gatewayModelFromSelection(null, driverOf)).toBe("~deepseek/deepseek-v4-flash-latest");
  });

  it("parses bullets from JSON or a plain list", () => {
    expect(parseLearned('{"learned":["A: x from a.md"]}')).toEqual(["A: x from a.md"]);
    expect(parseLearned("Here:\n- A: x from a.md\n2. B: y from b.md")).toEqual([
      "A: x from a.md",
      "B: y from b.md",
    ]);
  });
});
