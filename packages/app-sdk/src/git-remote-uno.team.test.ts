/**
 * `uno::team/<id>/<name>` against a fake console and fake storage on a local
 * port: real git, the real helper process, real `fetch`. The fake keeps the
 * contract of TEAM_API.md (redaction 3) as strictly as storage would: a link
 * signed with `If-None-Match` and `Content-Length` refuses anything else with
 * a 403, an object that exists answers 412. The same server answers the
 * routes of a project without a team, so the second half of this file pins
 * down that nothing changed for them.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ObjectExists, addressOf, consoleStorage, logKey, remoteUrl } from "./git-remote-uno.mjs";

const helperModule = path.join(path.dirname(fileURLToPath(import.meta.url)), "git-remote-uno.mjs");

const OWNER_TOKEN = "uno_usr_owner_test_token_value";
const MEMBER_TOKEN = "uno_usr_member_test_token_value";
const TEAM_ID = 12;
const TEAM_ROOT = `/api/v1/work/team/projects/${TEAM_ID}/git`;
const BUCKET_ROOT = "/api/v1/buckets/7";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly who: "owner" | "member" | "nobody";
  readonly headers: Record<string, string | string[] | undefined>;
  readonly raw: string[];
}

interface Upload {
  readonly key: string;
  readonly size: number;
  readonly partSize: number;
  readonly parts: Map<number, Buffer>;
}

/** The console and storage, on one port. */
async function fakeCloud() {
  const objects = new Map<string, { bytes: Buffer; at: number }>();
  const uploads = new Map<string, Upload>();
  const calls: Call[] = [];
  const faults = {
    /** A team `put` over this size goes by parts (like Hostkey's 50 MiB). */
    singlePutLimit: 1 << 30,
    partSize: 64 * 1024,
    /** The object lands, the answer doesn't: one time, on the next bundle PUT. */
    loseNextBundleAnswer: false,
    /** `complete` finds the name taken: this many times. */
    takenOnComplete: 0,
    /** `complete` finds the upload dropped: this many times. */
    droppedOnComplete: 0,
    quotaFull: false,
    removed: false,
    teamsOff: false,
  };
  let uploadSeq = 0;
  let base = "";

  const send = (
    response: http.ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    response.writeHead(status, {
      "content-type": "application/json",
      date: new Date().toUTCString(),
      ...headers,
    });
    response.end(JSON.stringify(body));
  };
  const refuse = (response: http.ServerResponse, status: number, error: string) =>
    send(response, status, { error, detail: `echoed ${MEMBER_TOKEN}` });

  const listing = (prefix: string) => {
    const under = [...objects.entries()].filter(([key]) => key.startsWith(prefix));
    const rest = under.map(([key, value]) => ({ key, rest: key.slice(prefix.length), value }));
    return {
      prefix,
      objects: rest
        .filter((item) => !item.rest.includes("/"))
        .map((item) => ({
          key: item.key,
          size: item.value.bytes.length,
          last_modified: new Date(item.value.at).toISOString(),
        })),
      folders: [
        ...new Set(
          rest
            .filter((item) => item.rest.includes("/"))
            .map((item) => `${prefix}${item.rest.split("/")[0]}/`),
        ),
      ],
      truncated: false,
    };
  };

  const startParts = (key: string, size: number) => {
    uploadSeq += 1;
    const uploadId = `up-${uploadSeq}`;
    const partSize = faults.partSize;
    const parts = Math.ceil(size / partSize);
    uploads.set(uploadId, { key, size, partSize, parts: new Map() });
    return {
      method: "put",
      multipart: true,
      key,
      upload_id: uploadId,
      size,
      part_size: partSize,
      parts,
      first: 1,
      part_urls: Array.from(
        { length: parts },
        (_, index) => `${base}/storage/part?upload=${uploadId}&n=${index + 1}`,
      ),
      expires_in: 900,
    };
  };

  const finishParts = (response: http.ServerResponse, uploadId: string) => {
    const upload = uploads.get(uploadId);
    if (!upload) return refuse(response, 404, "UPLOAD_NOT_FOUND");
    if (faults.droppedOnComplete > 0) {
      faults.droppedOnComplete -= 1;
      uploads.delete(uploadId);
      return refuse(response, 404, "UPLOAD_NOT_FOUND");
    }
    if (faults.takenOnComplete > 0) {
      faults.takenOnComplete -= 1;
      uploads.delete(uploadId);
      return refuse(response, 409, "OBJECT_EXISTS");
    }
    const chunks = [...upload.parts.entries()]
      .toSorted(([a], [b]) => a - b)
      .map(([, bytes]) => bytes);
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== upload.size) return refuse(response, 400, "INVALID_UPLOAD");
    objects.set(upload.key, { bytes, at: Date.now() });
    uploads.delete(uploadId);
    send(response, 200, { method: "complete", status: "done", key: upload.key });
  };

  const presignTeam = (response: http.ServerResponse, body: any) => {
    const method = body.method ?? "get";
    if (body.upload_id) {
      if (method === "complete") return finishParts(response, body.upload_id);
      if (method === "abort") {
        uploads.delete(body.upload_id);
        return send(response, 200, { method: "abort", status: "aborted" });
      }
      return refuse(response, 400, "INVALID_REQUEST");
    }
    if (typeof body.key !== "string" || !body.key.startsWith(".uno-git/notes/")) {
      return refuse(response, 403, "GIT_KEY_OUTSIDE_PROJECT");
    }
    if (method === "get") {
      return send(response, 200, {
        url: `${base}/storage/object?key=${encodeURIComponent(body.key)}`,
        method: "get",
        expires_in: 900,
      });
    }
    if (method !== "put") return refuse(response, 400, "INVALID_METHOD");
    if (!(body.size > 0)) return refuse(response, 400, "SIZE_REQUIRED");
    if (faults.quotaFull) return refuse(response, 402, "STORAGE_QUOTA_EXCEEDED");
    if (objects.has(body.key)) return refuse(response, 409, "OBJECT_EXISTS");
    if (body.size > faults.singlePutLimit) {
      return send(response, 200, startParts(body.key, body.size));
    }
    return send(response, 200, {
      url: `${base}/storage/object?key=${encodeURIComponent(body.key)}&signed=${body.size}`,
      method: "put",
      max_bytes: 2147483648,
      headers: { "If-None-Match": "*", "Content-Length": String(body.size) },
      expires_in: 900,
    });
  };

  const presignOwner = (response: http.ServerResponse, body: any) => {
    const method = body.method ?? "get";
    const url = `${base}/storage/object?key=${encodeURIComponent(body.key)}`;
    if (method === "get") return send(response, 200, { url, method, expires_in: 3600 });
    return send(response, 200, { url, method: "put", max_bytes: 1 << 30, expires_in: 3600 });
  };

  const storagePut = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    bytes: Buffer,
  ) => {
    if (url.pathname === "/storage/part") {
      const upload = uploads.get(url.searchParams.get("upload") ?? "");
      if (!upload) return refuse(response, 404, "NoSuchUpload");
      const part = Number(url.searchParams.get("n"));
      const want = Math.min(upload.partSize, upload.size - (part - 1) * upload.partSize);
      if (bytes.length !== want) return refuse(response, 400, "EntityTooSmall");
      upload.parts.set(part, bytes);
      return send(response, 200, {});
    }
    const key = url.searchParams.get("key") ?? "";
    const signed = url.searchParams.get("signed");
    const conditional = request.headers["if-none-match"];
    // A signed header missing or different: storage answers 403 before anything else.
    if (signed !== null) {
      const lengths = request.rawHeaders.filter(
        (_, index, all) => index % 2 === 1 && all[index - 1]?.toLowerCase() === "content-length",
      );
      if (conditional !== "*" || lengths.length !== 1 || lengths[0] !== signed) {
        return refuse(response, 403, "SignatureDoesNotMatch");
      }
      if (bytes.length !== Number(signed)) return refuse(response, 403, "SignatureDoesNotMatch");
    }
    if (conditional === "*" && objects.has(key)) return refuse(response, 412, "PreconditionFailed");
    objects.set(key, { bytes, at: Date.now() });
    if (faults.loseNextBundleAnswer && key.endsWith(".bundle")) {
      faults.loseNextBundleAnswer = false;
      request.socket.destroy();
      return;
    }
    send(response, 200, {});
  };

  const route = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    bytes: Buffer,
  ) => {
    const url = new URL(request.url ?? "/", base);
    const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
    const who = token === OWNER_TOKEN ? "owner" : token === MEMBER_TOKEN ? "member" : "nobody";
    calls.push({
      method: request.method ?? "",
      path: url.pathname,
      who,
      headers: request.headers,
      raw: request.rawHeaders,
    });
    if (url.pathname.startsWith("/storage/")) {
      if (request.method === "PUT") return storagePut(request, response, url, bytes);
      const object = objects.get(url.searchParams.get("key") ?? "");
      if (!object) return refuse(response, 404, "NoSuchKey");
      response.writeHead(200, { "content-length": object.bytes.length });
      response.end(object.bytes);
      return;
    }
    if (who === "nobody") return refuse(response, 401, "UNAUTHORIZED");
    if (url.pathname === "/api/v1/drive") return send(response, 200, { bucket_id: 7 });
    if (url.pathname.startsWith(BUCKET_ROOT)) {
      if (who !== "owner") return refuse(response, 403, "FORBIDDEN");
      if (url.pathname.endsWith("/presign")) {
        return presignOwner(response, JSON.parse(bytes.toString()));
      }
      if (request.method === "DELETE") {
        objects.delete(url.searchParams.get("key") ?? "");
        return send(response, 200, {});
      }
      return send(response, 200, listing(url.searchParams.get("prefix") ?? ""));
    }
    if (url.pathname.startsWith(TEAM_ROOT)) {
      if (faults.teamsOff) return refuse(response, 404, "WORK_TEAM_DISABLED");
      if (faults.removed) return refuse(response, 404, "NOT_FOUND");
      if (url.pathname.endsWith("/presign")) {
        return presignTeam(response, JSON.parse(bytes.toString()));
      }
      const prefix = url.searchParams.get("prefix") ?? "";
      if (!prefix.startsWith(".uno-git/notes/") || !prefix.endsWith("/")) {
        return refuse(response, 403, "GIT_KEY_OUTSIDE_PROJECT");
      }
      return send(response, 200, listing(prefix));
    }
    refuse(response, 404, "NO_SUCH_ROUTE");
  };

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void route(request, response, Buffer.concat(chunks)).catch((error) => {
        response.writeHead(500);
        response.end(String(error));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, objects, calls, faults, close: () => server.close() };
}

type Cloud = Awaited<ReturnType<typeof fakeCloud>>;

let root = "";
let bin = "";
let cloud: Cloud;

/** A computer signed in with `token`: settings where the helper reads them. */
function computer(label: string, token: string) {
  const home = path.join(root, label);
  fs.mkdirSync(path.join(home, ".uno", "sdk"), { recursive: true });
  const settings = path.join(home, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ uno: { apiKey: token } }));
  fs.writeFileSync(
    path.join(home, ".uno", "sdk", "daemon.json"),
    JSON.stringify({ settingsPath: settings, consoleUrl: cloud.base }),
  );
  return {
    home,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
      GIT_AUTHOR_NAME: label,
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: label,
      GIT_COMMITTER_EMAIL: "t@example.com",
    } as NodeJS.ProcessEnv,
  };
}
type Computer = ReturnType<typeof computer>;

/** git without blocking: the fake console lives in this very process. */
function run(at: Computer, cwd: string, ...args: string[]) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn("git", args, { cwd, env: at.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

async function ok(at: Computer, cwd: string, ...args: string[]) {
  const result = await run(at, cwd, ...args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.out}`);
  return result.out.trim();
}

async function commit(at: Computer, dir: string, file: string, content: string | Buffer) {
  fs.writeFileSync(path.join(dir, file), content);
  await ok(at, dir, "add", file);
  await ok(at, dir, "commit", "-q", "-m", `change ${file}`);
}

/** The owner's project: one commit, pushed through their own routes. */
async function ownerProject(owner: Computer) {
  const dir = path.join(owner.home, "notes");
  fs.mkdirSync(dir);
  await ok(owner, dir, "init", "-q", "-b", "main");
  await commit(owner, dir, "plan.md", "plan\n");
  await ok(owner, dir, "remote", "add", "uno", "uno::notes");
  await ok(owner, dir, "push", "-q", "uno", "main");
  return dir;
}

const memberClone = async (member: Computer) => {
  const dir = path.join(member.home, "notes");
  await ok(member, member.home, "clone", "-q", "-o", "uno", remoteUrl("notes", TEAM_ID), dir);
  return dir;
};

const console_ = (who: Call["who"]) =>
  cloud.calls.filter((call) => call.who === who && call.path.startsWith("/api/"));
const storagePuts = () =>
  cloud.calls.filter((call) => call.method === "PUT" && call.path.startsWith("/storage/"));

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uno-team-")));
  bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "git-remote-uno"),
    `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(helperModule).href)}).then((h) => h.main(process.argv.slice(2)));\n`,
    { mode: 0o755 },
  );
  cloud = await fakeCloud();
});

afterEach(() => {
  cloud.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("addresses", () => {
  it("reads both kinds and gives back what it read", () => {
    expect(addressOf("uno::notes")).toEqual({ name: "notes", team: null });
    expect(addressOf("notes")).toEqual({ name: "notes", team: null });
    expect(addressOf("uno::team/12/notes")).toEqual({ name: "notes", team: 12 });
    expect(addressOf("team/12/notes.git")).toEqual({ name: "notes", team: 12 });
    expect(remoteUrl("notes")).toBe("uno::notes");
    expect(remoteUrl("notes", null)).toBe("uno::notes");
    expect(remoteUrl("notes", 12)).toBe("uno::team/12/notes");
  });

  it("refuses what isn't one", () => {
    for (const raw of [
      "",
      "team/notes",
      "team/0/notes",
      "team/x/notes",
      "team/12/",
      "team/12/a/b",
      "team/-1/notes",
      "team/12/../x",
      "team/99999999999999999999/notes",
    ]) {
      expect(addressOf(raw), raw).toBeNull();
    }
  });
});

describe("working in someone else's project", { timeout: 120_000 }, () => {
  it("clones, pushes and pulls through the team routes, both ways", async () => {
    const owner = computer("owner", OWNER_TOKEN);
    const member = computer("member", MEMBER_TOKEN);
    const ownerDir = await ownerProject(owner);
    const memberDir = await memberClone(member);
    expect(fs.readFileSync(path.join(memberDir, "plan.md"), "utf8")).toBe("plan\n");

    await commit(member, memberDir, "from-member.md", "hello\n");
    await ok(member, memberDir, "push", "-q", "uno", "main");
    await ok(owner, ownerDir, "pull", "-q", "uno", "main");
    expect(fs.readFileSync(path.join(ownerDir, "from-member.md"), "utf8")).toBe("hello\n");

    await commit(owner, ownerDir, "from-owner.md", "back\n");
    await ok(owner, ownerDir, "push", "-q", "uno", "main");
    await ok(member, memberDir, "pull", "-q", "uno", "main");
    expect(fs.readFileSync(path.join(memberDir, "from-owner.md"), "utf8")).toBe("back\n");

    // Only the routes of that project: never the Drive, never a bucket.
    const paths = new Set(console_("member").map((call) => call.path));
    expect([...paths].toSorted()).toEqual([`${TEAM_ROOT}/objects`, `${TEAM_ROOT}/presign`]);
  });

  it("sends a PUT exactly as it was signed, and works out that the storage won't overwrite", async () => {
    const owner = computer("owner", OWNER_TOKEN);
    const member = computer("member", MEMBER_TOKEN);
    await ownerProject(owner);
    const dir = await memberClone(member);
    cloud.calls.length = 0;

    await commit(member, dir, "a.md", "a\n");
    const pushed = await run(member, dir, "push", "uno", "main");
    expect(pushed.code).toBe(0);
    // The check that a log entry can't be overwritten ended in a 409, not a warning.
    expect(pushed.out).not.toMatch(/doesn't refuse overwrites/);
    expect(fs.existsSync(path.join(dir, ".git", "uno", "overwrite-check"))).toBe(true);

    expect(storagePuts().length).toBeGreaterThanOrEqual(2);
    for (const put of storagePuts()) {
      expect(put.headers["if-none-match"]).toBe("*");
      const lengths = put.raw.filter(
        (_, index, all) => index % 2 === 1 && all[index - 1]?.toLowerCase() === "content-length",
      );
      expect(lengths).toHaveLength(1);
    }
  });

  it("deletes nothing: tidying up waits for the owner's own push", async () => {
    const owner = computer("owner", OWNER_TOKEN);
    const member = computer("member", MEMBER_TOKEN);
    const ownerDir = await ownerProject(owner);
    const dir = await memberClone(member);
    // What a tidy-up would take: a stray bundle past the age rule, log entries past the 50 kept.
    const old = Date.now() - 3 * 60 * 60_000;
    const stray = ".uno-git/notes/bundles/2020-01-01T00-00-00-000Z-abcdef.bundle";
    cloud.objects.set(stray, { bytes: Buffer.from("x"), at: old });
    const current = [...cloud.objects.keys()]
      .filter((key) => key.includes("/log/"))
      .toSorted()
      .at(-1);
    const entry = cloud.objects.get(current!)!;
    cloud.objects.set(current!, { ...entry, at: old });
    const state = JSON.parse(entry.bytes.toString());
    cloud.objects.set(logKey("notes", 60), {
      bytes: Buffer.from(JSON.stringify({ ...state, seq: 60 })),
      at: old,
    });
    const before = [...cloud.objects.keys()];
    cloud.calls.length = 0;

    await commit(member, dir, "a.md", "a\n");
    await ok(member, dir, "push", "-q", "uno", "main");

    expect(cloud.calls.filter((call) => call.method === "DELETE")).toEqual([]);
    expect([...cloud.objects.keys()]).toEqual(expect.arrayContaining(before));

    // The owner's push still tidies what the member left.
    await ok(owner, ownerDir, "pull", "-q", "uno", "main");
    await commit(owner, ownerDir, "owner.md", "o\n");
    await ok(owner, ownerDir, "push", "-q", "uno", "main");
    expect(cloud.objects.has(stray)).toBe(false);
    expect(cloud.objects.has(current!)).toBe(false);
  });

  it("uploads a big bundle by parts, and the owner can read it", async () => {
    const owner = computer("owner", OWNER_TOKEN);
    const member = computer("member", MEMBER_TOKEN);
    const ownerDir = await ownerProject(owner);
    const dir = await memberClone(member);
    cloud.faults.singlePutLimit = 128 * 1024;
    cloud.calls.length = 0;
    const big = randomBytes(300 * 1024);

    await commit(member, dir, "big.bin", big);
    await ok(member, dir, "push", "-q", "uno", "main");

    expect(cloud.calls.filter((call) => call.path === "/storage/part").length).toBeGreaterThan(2);
    await ok(owner, ownerDir, "pull", "-q", "uno", "main");
    expect(fs.readFileSync(path.join(ownerDir, "big.bin")).equals(big)).toBe(true);
  });

  it.each([
    ["the name got taken", "takenOnComplete"],
    ["the upload was dropped", "droppedOnComplete"],
  ] as const)("uploads again under a new name when %s", async (_what, fault) => {
    const owner = computer("owner", OWNER_TOKEN);
    const member = computer("member", MEMBER_TOKEN);
    const ownerDir = await ownerProject(owner);
    const dir = await memberClone(member);
    cloud.faults.singlePutLimit = 128 * 1024;
    cloud.faults[fault] = 1;
    const big = randomBytes(300 * 1024);

    await commit(member, dir, "big.bin", big);
    await ok(member, dir, "push", "-q", "uno", "main");

    expect(cloud.faults[fault]).toBe(0);
    await ok(owner, ownerDir, "pull", "-q", "uno", "main");
    expect(fs.readFileSync(path.join(ownerDir, "big.bin")).equals(big)).toBe(true);
  });

  it("takes a 412 on a retried bundle as landed: the answer was lost, not the bytes", async () => {
    const owner = computer("owner", OWNER_TOKEN);
    const member = computer("member", MEMBER_TOKEN);
    const ownerDir = await ownerProject(owner);
    const dir = await memberClone(member);
    cloud.faults.loseNextBundleAnswer = true;

    await commit(member, dir, "a.md", "a\n");
    await ok(member, dir, "push", "-q", "uno", "main");

    await ok(owner, ownerDir, "pull", "-q", "uno", "main");
    expect(fs.readFileSync(path.join(ownerDir, "a.md"), "utf8")).toBe("a\n");
  });

  it("says what happened in the person's words, without the key or the console's text", async () => {
    const owner = computer("owner", OWNER_TOKEN);
    const member = computer("member", MEMBER_TOKEN);
    await ownerProject(owner);
    const dir = await memberClone(member);
    await commit(member, dir, "a.md", "a\n");

    cloud.faults.quotaFull = true;
    const full = await run(member, dir, "push", "uno", "main");
    expect(full.code).not.toBe(0);
    expect(full.out).toMatch(/project owner's Uno cloud storage is full/);
    cloud.faults.quotaFull = false;

    cloud.faults.removed = true;
    const gone = await run(member, dir, "fetch", "uno");
    expect(gone.code).not.toBe(0);
    expect(gone.out).toMatch(/You no longer have access to this project/);
    cloud.faults.removed = false;

    cloud.faults.teamsOff = true;
    const off = await run(member, dir, "fetch", "uno");
    expect(off.code).not.toBe(0);
    expect(off.out).toMatch(/Shared projects aren't available right now/);

    for (const text of [full.out, gone.out, off.out]) {
      expect(text).not.toContain(MEMBER_TOKEN);
    }
  });
});

describe("the storage of someone else's project", () => {
  const storage = () =>
    consoleStorage({ token: MEMBER_TOKEN, boxId: null, consoleUrl: cloud.base }, fetch, TEAM_ID);

  it("won't delete, and doesn't ask the console to", async () => {
    await expect(storage().remove(".uno-git/notes/log/000000000001.json")).rejects.toThrow(
      /Only the project's owner/,
    );
    expect(cloud.calls).toEqual([]);
  });

  it("answers false to a conditional write on a key that exists: no link was signed", async () => {
    const key = ".uno-git/notes/log/000000000001.json";
    cloud.objects.set(key, { bytes: Buffer.from("{}"), at: Date.now() });
    await expect(storage().write(key, Buffer.from("x"), { ifNoneMatch: true })).resolves.toBe(
      false,
    );
    expect(storagePuts()).toEqual([]);
  });

  it("answers false when the object appears between the link and the PUT", async () => {
    const key = ".uno-git/notes/log/000000000002.json";
    const racing: typeof fetch = async (url, init) => {
      if (init?.method === "PUT") cloud.objects.set(key, { bytes: Buffer.from("{}"), at: 0 });
      return fetch(url, init);
    };
    const racy = consoleStorage(
      { token: MEMBER_TOKEN, boxId: null, consoleUrl: cloud.base },
      racing,
      TEAM_ID,
    );
    await expect(racy.write(key, Buffer.from("x"), { ifNoneMatch: true })).resolves.toBe(false);
  });

  it("can't overwrite anything, even asked to", async () => {
    const key = ".uno-git/notes/meta.json";
    cloud.objects.set(key, { bytes: Buffer.from("{}"), at: Date.now() });
    await expect(storage().write(key, Buffer.from("x"))).rejects.toBeInstanceOf(ObjectExists);
    expect(cloud.objects.get(key)?.bytes.toString()).toBe("{}");
  });

  it("refuses a link signed for another size", async () => {
    const lying: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (!String(url).endsWith("/presign")) return response;
      const plan = await response.json();
      return new Response(
        JSON.stringify({ ...plan, headers: { ...plan.headers, "Content-Length": "1" } }),
        { status: 200 },
      );
    };
    const liar = consoleStorage(
      { token: MEMBER_TOKEN, boxId: null, consoleUrl: cloud.base },
      lying,
      TEAM_ID,
    );
    await expect(liar.write(".uno-git/notes/a", Buffer.from("xy"))).rejects.toThrow(
      /doesn't match the file/,
    );
    expect(storagePuts()).toEqual([]);
  });
});

describe("a project without a team, as before", { timeout: 120_000 }, () => {
  it("goes through the person's own bucket, with the same requests and headers", async () => {
    const owner = computer("owner", OWNER_TOKEN);
    await ownerProject(owner);

    const paths = new Set(console_("owner").map((call) => call.path));
    expect([...paths].toSorted()).toEqual([
      `${BUCKET_ROOT}/objects`,
      `${BUCKET_ROOT}/presign`,
      "/api/v1/drive",
    ]);
    expect(cloud.calls.some((call) => call.path.includes("/work/team"))).toBe(false);

    const [first, second] = storagePuts();
    // The bundle goes plain; the log entry is conditional. No signed Content-Length rules.
    expect(first?.headers["if-none-match"]).toBeUndefined();
    expect(second?.headers["if-none-match"]).toBe("*");
  });

  it("still tidies after each push", async () => {
    const owner = computer("owner", OWNER_TOKEN);
    const dir = await ownerProject(owner);
    const stray = ".uno-git/notes/bundles/2020-01-01T00-00-00-000Z-abcdef.bundle";
    cloud.objects.set(stray, { bytes: Buffer.from("x"), at: Date.now() - 3 * 60 * 60_000 });

    await commit(owner, dir, "a.md", "a\n");
    await ok(owner, dir, "push", "-q", "uno", "main");

    expect(cloud.objects.has(stray)).toBe(false);
    expect(cloud.calls.filter((call) => call.method === "DELETE").length).toBeGreaterThan(0);
  });

  it("can still overwrite and delete its own files", async () => {
    const mine = consoleStorage({ token: OWNER_TOKEN, boxId: null, consoleUrl: cloud.base });
    const key = ".uno-git/notes/meta.json";
    await expect(mine.write(key, Buffer.from("one"))).resolves.toBe(true);
    await expect(mine.write(key, Buffer.from("two"))).resolves.toBe(true);
    expect(cloud.objects.get(key)?.bytes.toString()).toBe("two");
    await mine.remove(key);
    expect(cloud.objects.has(key)).toBe(false);
  });
});
