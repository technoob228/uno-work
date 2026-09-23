/**
 * End-to-end through the real FilesService + `file_shares` (in-memory SQLite)
 * and the HTTP routes, without the rest of the server: share links serve
 * exactly what was shared, stop on revoke/expiry, and ask for the password.
 */
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";

import { AuthError, ServerAuth, type AuthenticatedSession } from "../auth/Services/ServerAuth.ts";
import { ServerConfig } from "../config.ts";
import { FileSharesRepositoryLive } from "../persistence/Layers/FileShares.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { FileSharesRepository } from "../persistence/Services/FileShares.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { FilesService, makeFilesService } from "./FilesService.ts";
import { filesRawRouteLayer, filesShareRouteLayers, parseRangeHeader } from "./http.ts";

const AUTH_HEADER = "x-test-session";

const authLayer = Layer.mock(ServerAuth)({
  authenticateHttpRequest: (request) =>
    request.headers[AUTH_HEADER] === "yes"
      ? Effect.succeed({ sessionId: "s", role: "owner" } as unknown as AuthenticatedSession)
      : Effect.fail(new AuthError({ message: "Unauthorized", status: 401 })),
});

const settingsLayer = Layer.mock(ServerSettingsService)({
  getSettings: Effect.succeed({ uno: { apiKey: "" } } as never),
});

/** Minimal zip local-file headers: enough for the "is this a document" check. */
const OFFICE_V1 = Buffer.from("PK\u0003\u0004 version-one");
const OFFICE_V2 = Buffer.from("PK\u0003\u0004 version-two");
const OFFICE_V3 = Buffer.from("PK\u0003\u0004 version-three");
const OFFICE_OTHER = Buffer.from("PK\u0003\u0004 other-file");

const makeFixture = Effect.gen(function* () {
  const sandbox = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "uno-files-http-")));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => fs.rmSync(sandbox, { recursive: true, force: true })),
  );
  const home = nodePath.join(sandbox, "home");
  fs.mkdirSync(nodePath.join(home, "site", "css"), { recursive: true });
  fs.mkdirSync(nodePath.join(home, "docs"), { recursive: true });
  fs.mkdirSync(nodePath.join(home, ".ssh"), { recursive: true });
  fs.writeFileSync(nodePath.join(home, "docs", "report.pdf"), "%PDF-1.4 fake");
  fs.writeFileSync(nodePath.join(home, "docs", "budget.xlsx"), "xlsx-bytes");
  fs.writeFileSync(nodePath.join(home, "docs", "page.html"), "<script>alert(1)</script>");
  fs.writeFileSync(nodePath.join(home, "notes.txt"), "0123456789");
  fs.writeFileSync(nodePath.join(home, "site", "index.html"), "<h1>Site</h1>");
  fs.writeFileSync(nodePath.join(home, "site", "css", "a.css"), "h1{}");
  fs.writeFileSync(nodePath.join(home, "site", ".env"), "SECRET=1");
  fs.writeFileSync(nodePath.join(home, ".ssh", "id_rsa"), "key");
  fs.writeFileSync(nodePath.join(sandbox, "outside.txt"), "outside");
  // A real-looking docx (a zip) and a legacy .doc for the office link tests.
  fs.writeFileSync(nodePath.join(home, "docs", "letter.docx"), OFFICE_V1);
  fs.writeFileSync(nodePath.join(home, "docs", "other.docx"), OFFICE_OTHER);
  fs.writeFileSync(nodePath.join(home, "docs", "old.doc"), "legacy");
  // The web build's editor page and an installed engine.
  const staticDir = nodePath.join(sandbox, "static");
  const engineDir = nodePath.join(sandbox, "base", "office-engine");
  fs.mkdirSync(staticDir, { recursive: true });
  fs.writeFileSync(
    nodePath.join(staticDir, "office-share.html"),
    "<!doctype html><html><head><title>x</title></head><body>EDITOR</body></html>",
  );
  fs.mkdirSync(nodePath.join(engineDir, "vendor/web-apps/apps/api/documents"), { recursive: true });
  fs.writeFileSync(nodePath.join(engineDir, "vendor/web-apps/apps/api/documents/api.js"), "//");
  const configLayer = Layer.succeed(ServerConfig, {
    baseDir: nodePath.join(sandbox, "base"),
    staticDir,
    devUrl: undefined,
    officeEngineDir: engineDir,
  } as never);

  const filesLayer = Layer.effect(FilesService, makeFilesService({ root: home })).pipe(
    Layer.provideMerge(FileSharesRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(settingsLayer),
  );
  const context = yield* Layer.build(
    Layer.mergeAll(filesLayer, authLayer, configLayer, NodeServices.layer, NodeHttpPlatform.layer),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(filesRawRouteLayer, ...filesShareRouteLayers),
    { disableLogger: true },
  );
  yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));

  const request = (path: string, init: RequestInit = {}) =>
    Effect.promise(() =>
      handler(new Request(`http://127.0.0.1${path}`, { redirect: "manual", ...init }), context),
    );
  const files = yield* Effect.service(FilesService).pipe(Effect.provide(context));
  const repository = yield* Effect.service(FileSharesRepository).pipe(Effect.provide(context));
  const text = (response: Response) => Effect.promise(() => response.text());
  const json = (response: Response) =>
    Effect.promise(() => response.json() as Promise<Record<string, unknown>>);
  return { home, sandbox, request, files, repository, text, json };
});

it.layer(NodeServices.layer, { excludeTestServices: true })("files share routes", (it) => {
  it.effect("a file link shows a card and serves only that file", () =>
    Effect.gen(function* () {
      const { home, request, files, text } = yield* makeFixture;
      const share = yield* files.createShare({ path: `${home}/docs/report.pdf` });
      assert.equal(share.kind, "file");
      assert.equal(share.urlPath, `/s/${share.token}`);

      const card = yield* request(share.urlPath);
      assert.equal(card.status, 200);
      assert.include(card.headers.get("content-security-policy") ?? "", "default-src 'none'");
      assert.equal(card.headers.get("referrer-policy"), "no-referrer");
      const html = yield* text(card);
      assert.include(html, "report.pdf");
      assert.include(html, "Download");

      const raw = yield* request(`${share.urlPath}/report.pdf`);
      assert.equal(raw.status, 200);
      assert.include(raw.headers.get("content-type") ?? "", "application/pdf");
      assert.equal(yield* text(raw), "%PDF-1.4 fake");

      const download = yield* request(`${share.urlPath}/report.pdf?download=1`);
      assert.include(download.headers.get("content-disposition") ?? "", "attachment");

      // Nothing next to the shared file is reachable through its link.
      for (const path of [
        `${share.urlPath}/budget.xlsx`,
        `${share.urlPath}/budget.xlsx/x`,
        `${share.urlPath}/..%2Fbudget.xlsx`,
        `${share.urlPath}/%2e%2e/budget.xlsx`,
        `${share.urlPath}/.env`,
      ]) {
        const response = yield* request(path);
        assert.equal(response.status, 404, path);
        assert.notInclude(yield* text(response), "xlsx-bytes", path);
      }
      const listed = yield* files.listShares({});
      assert.equal(listed.shares[0]?.accessCount, 2); // the card + the download
    }).pipe(Effect.scoped),
  );

  it.effect("HTML is served inside a sandbox so it can't act as the owner", () =>
    Effect.gen(function* () {
      const { home, request, files, text } = yield* makeFixture;
      const share = yield* files.createShare({ path: `${home}/docs/page.html` });
      const raw = yield* request(`${share.urlPath}/page.html`);
      assert.equal(raw.status, 200);
      yield* text(raw); // drain the file stream before the sandbox is deleted
      assert.include(raw.headers.get("content-security-policy") ?? "", "sandbox allow-scripts");
      assert.notInclude(raw.headers.get("content-security-policy") ?? "", "allow-same-origin");
    }).pipe(Effect.scoped),
  );

  it.effect("revoked and expired links stop working", () =>
    Effect.gen(function* () {
      const { home, request, files, repository } = yield* makeFixture;
      const share = yield* files.createShare({ path: `${home}/notes.txt` });
      assert.equal((yield* request(share.urlPath)).status, 200);
      const revoked = yield* files.revokeShare({ id: share.id });
      assert.isNotNull(revoked.revokedAt);
      assert.equal((yield* request(share.urlPath)).status, 404);
      assert.equal((yield* request(`${share.urlPath}/notes.txt`)).status, 404);
      assert.equal((yield* files.listShares({})).shares.length, 0);
      assert.equal((yield* files.listShares({ includeInactive: true })).shares.length, 1);

      const timed = yield* files.createShare({ path: `${home}/notes.txt`, expiresInSeconds: 60 });
      assert.isNotNull(timed.expiresAt);
      yield* repository.create({
        shareId: "expired",
        token: "e".repeat(32),
        path: `${home}/notes.txt`,
        kind: "file",
        createdAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-01-02T00:00:00.000Z",
        revokedAt: null,
        passwordHash: null,
        access: "view",
        accessCount: 0,
        lastAccessedAt: null,
      });
      assert.equal((yield* request(`/s/${"e".repeat(32)}`)).status, 410);
      assert.equal((yield* request(`/s/${"f".repeat(32)}`)).status, 404);
      assert.equal((yield* request("/s/not-a-token")).status, 404);
    }).pipe(Effect.scoped),
  );

  it.effect("a password link asks first and remembers the right answer", () =>
    Effect.gen(function* () {
      const { home, request, files, text } = yield* makeFixture;
      const share = yield* files.createShare({
        path: `${home}/notes.txt`,
        password: "open-sesame",
      });
      assert.isTrue(share.hasPassword);

      const gate = yield* request(share.urlPath);
      assert.equal(gate.status, 401);
      assert.include(yield* text(gate), 'type="password"');
      assert.equal((yield* request(`${share.urlPath}/notes.txt`)).status, 401);

      const post = (password: string) =>
        request(share.urlPath, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ password }).toString(),
        });
      const wrong = yield* post("nope");
      assert.equal(wrong.status, 401);
      assert.include(yield* text(wrong), "password isn&#39;t right");

      const right = yield* post("open-sesame");
      assert.equal(right.status, 303);
      const cookie = right.headers.get("set-cookie") ?? "";
      assert.include(cookie, "HttpOnly");
      assert.include(cookie, `Path=/s/${share.token}`);
      const cookiePair = cookie.split(";")[0]!;

      const unlocked = yield* request(`${share.urlPath}/notes.txt`, {
        headers: { cookie: cookiePair },
      });
      assert.equal(unlocked.status, 200);
      assert.equal(yield* text(unlocked), "0123456789");
    }).pipe(Effect.scoped),
  );

  it.effect("a folder link serves a website but never its dotfiles", () =>
    Effect.gen(function* () {
      const { home, request, files, text } = yield* makeFixture;
      const share = yield* files.createShare({ path: `${home}/site` });
      assert.equal(share.kind, "folder");

      const bare = yield* request(share.urlPath);
      assert.equal(bare.status, 302);
      assert.equal(bare.headers.get("location"), `${share.urlPath}/`);

      const index = yield* request(`${share.urlPath}/`);
      assert.equal(index.status, 200);
      assert.equal(yield* text(index), "<h1>Site</h1>");
      assert.include(index.headers.get("content-security-policy") ?? "", "sandbox");

      const css = yield* request(`${share.urlPath}/css/a.css`);
      assert.equal(css.status, 200);
      assert.equal(css.headers.get("access-control-allow-origin"), "*");

      for (const path of [`${share.urlPath}/.env`, `${share.urlPath}/css/..%2F.env`]) {
        const response = yield* request(path);
        assert.equal(response.status, 404, path);
        assert.notInclude(yield* text(response), "SECRET", path);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("a folder without index.html lists its visible files", () =>
    Effect.gen(function* () {
      const { home, request, files, text } = yield* makeFixture;
      fs.writeFileSync(nodePath.join(home, "docs", ".hidden"), "x");
      const share = yield* files.createShare({ path: `${home}/docs` });
      const listing = yield* request(`${share.urlPath}/`);
      assert.equal(listing.status, 200);
      const html = yield* text(listing);
      assert.include(html, "report.pdf");
      assert.include(html, "budget.xlsx");
      assert.notInclude(html, ".hidden");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to share the home folder, hidden items and things outside it", () =>
    Effect.gen(function* () {
      const { home, sandbox, files } = yield* makeFixture;
      for (const path of [home, `${home}/.ssh/id_rsa`, `${home}/.ssh`, `${sandbox}/outside.txt`]) {
        const result = yield* files.createShare({ path }).pipe(Effect.flip);
        assert.equal(result._tag, "FilesError", path);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("links follow a renamed or moved file and die with a deleted one", () =>
    Effect.gen(function* () {
      const { home, request, files } = yield* makeFixture;
      const fileShare = yield* files.createShare({ path: `${home}/notes.txt` });
      const renamed = yield* files.rename({ path: `${home}/notes.txt`, newName: "todo.txt" });
      yield* files.move({ paths: [renamed.path], destinationPath: `${home}/docs` });
      const [after] = (yield* files.listShares({})).shares;
      assert.equal(after?.path, `${home}/docs/todo.txt`);
      assert.equal((yield* request(`${fileShare.urlPath}/todo.txt`)).status, 200);

      const folderShare = yield* files.createShare({ path: `${home}/site` });
      const deleted = yield* files.remove({ paths: [`${home}/site`] });
      assert.equal(deleted.revokedShares, 1);
      assert.equal((yield* request(`${folderShare.urlPath}/`)).status, 404);
    }).pipe(Effect.scoped),
  );

  it.effect("an office link opens the editor page with its own access level", () =>
    Effect.gen(function* () {
      const { home, request, files, text } = yield* makeFixture;
      const share = yield* files.createShare({ path: `${home}/docs/letter.docx`, access: "edit" });
      assert.equal(share.access, "edit");
      const page = yield* request(share.urlPath);
      assert.equal(page.status, 200);
      assert.include(page.headers.get("content-security-policy") ?? "", "frame-ancestors 'none'");
      assert.equal(page.headers.get("x-frame-options"), "DENY");
      const html = yield* text(page);
      assert.include(html, "EDITOR");
      const config = JSON.parse(
        /<script id="uno-share-config" type="application\/json">(.*?)<\/script>/.exec(html)![1]!,
      );
      assert.equal(config.access, "edit");
      assert.equal(config.documentType, "word");
      assert.equal(config.fileUrl, `${share.urlPath}/.file`);
      assert.equal(config.saveUrl, `${share.urlPath}/.save`);
      // The plain card is still one click away.
      assert.include(yield* text(yield* request(`${share.urlPath}?card=1`)), "Download");

      const viewOnly = yield* files.createShare({ path: `${home}/docs/letter.docx` });
      assert.equal(viewOnly.access, "view");
      const viewHtml = yield* text(yield* request(viewOnly.urlPath));
      assert.include(viewHtml, '"saveUrl":null');
    }).pipe(Effect.scoped),
  );

  it.effect("comment/edit only for office files a link can write back", () =>
    Effect.gen(function* () {
      const { home, files } = yield* makeFixture;
      for (const path of [`${home}/notes.txt`, `${home}/site`, `${home}/docs/old.doc`]) {
        const failed = yield* files.createShare({ path, access: "edit" }).pipe(Effect.flip);
        assert.equal(failed._tag, "FilesError", path);
      }
      const comment = yield* files.createShare({
        path: `${home}/docs/letter.docx`,
        access: "comment",
      });
      assert.equal(comment.access, "comment");
    }).pipe(Effect.scoped),
  );

  it.effect("saving by link writes only that file, refuses view links and stale versions", () =>
    Effect.gen(function* () {
      const { home, sandbox, request, files, json } = yield* makeFixture;
      const letter = `${home}/docs/letter.docx`;
      const edit = yield* files.createShare({ path: letter, access: "edit" });
      const view = yield* files.createShare({ path: letter });

      const opened = yield* request(`${edit.urlPath}/.file`);
      assert.equal(opened.status, 200);
      const version = opened.headers.get("x-uno-version")!;
      assert.isString(version);
      assert.equal((yield* json(yield* request(`${edit.urlPath}/.state`))).version, version);

      const save = (urlPath: string, body: Buffer, base: string | null, force = false) =>
        request(`${urlPath}/.save${force ? "?force=1" : ""}`, {
          method: "POST",
          body: new Uint8Array(body),
          headers: base ? { "x-uno-base-version": base } : {},
        });

      // A view link can't save; GET can't save; junk isn't a document.
      assert.equal((yield* save(view.urlPath, OFFICE_V2, version)).status, 403);
      assert.equal((yield* request(`${edit.urlPath}/.save`)).status, 405);
      assert.equal((yield* save(edit.urlPath, Buffer.from("not a zip"), version)).status, 400);
      assert.deepEqual(fs.readFileSync(letter), OFFICE_V1);

      const saved = yield* save(edit.urlPath, OFFICE_V2, version);
      assert.equal(saved.status, 200);
      const v2 = (yield* json(saved)).version as string;
      assert.deepEqual(fs.readFileSync(letter), OFFICE_V2);
      // Nothing else was touched, and the old bytes were kept.
      assert.deepEqual(fs.readFileSync(`${home}/docs/other.docx`), OFFICE_OTHER);
      const kept = fs.readdirSync(nodePath.join(sandbox, "base", "share-versions", edit.id));
      assert.equal(kept.length, 1);
      assert.deepEqual(
        fs.readFileSync(nodePath.join(sandbox, "base", "share-versions", edit.id, kept[0]!)),
        OFFICE_V1,
      );
      assert.notInclude(fs.readdirSync(`${home}/docs`).join(","), ".tmp");

      // The file changed on the computer meanwhile: a save from the old version is a conflict.
      fs.writeFileSync(letter, OFFICE_V3);
      const conflict = yield* save(edit.urlPath, OFFICE_V2, v2);
      assert.equal(conflict.status, 409);
      assert.deepEqual(fs.readFileSync(letter), OFFICE_V3);
      // …until the visitor explicitly chooses to replace it.
      assert.equal((yield* save(edit.urlPath, OFFICE_V2, v2, true)).status, 200);
      assert.deepEqual(fs.readFileSync(letter), OFFICE_V2);

      // A revoked link can't save any more.
      yield* files.revokeShare({ id: edit.id });
      assert.equal((yield* save(edit.urlPath, OFFICE_V1, null, true)).status, 404);
      assert.deepEqual(fs.readFileSync(letter), OFFICE_V2);

      // Reserved names never reach a folder link's files.
      const folder = yield* files.createShare({ path: `${home}/docs` });
      assert.equal((yield* request(`${folder.urlPath}/.file`)).status, 404);
    }).pipe(Effect.scoped),
  );

  it.effect("a password link's editor calls need the unlocked cookie", () =>
    Effect.gen(function* () {
      const { home, request, files } = yield* makeFixture;
      const share = yield* files.createShare({
        path: `${home}/docs/letter.docx`,
        access: "edit",
        password: "secret-pass",
      });
      assert.equal((yield* request(`${share.urlPath}/.file`)).status, 401);
      const bad = yield* request(`${share.urlPath}/.save?force=1`, {
        method: "POST",
        body: new Uint8Array(OFFICE_V2),
      });
      assert.equal(bad.status, 401);
      const unlocked = yield* request(share.urlPath, {
        method: "POST",
        body: new URLSearchParams({ password: "secret-pass" }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      assert.equal(unlocked.status, 303);
      const cookie = (unlocked.headers.get("set-cookie") ?? "").split(";")[0]!;
      assert.equal((yield* request(`${share.urlPath}/.file`, { headers: { cookie } })).status, 200);
    }).pipe(Effect.scoped),
  );

  it.effect("the owner route needs a session and stays inside the home folder", () =>
    Effect.gen(function* () {
      const { home, sandbox, request, text } = yield* makeFixture;
      const path = encodeURIComponent(`${home}/notes.txt`);
      assert.equal((yield* request(`/api/files/raw?path=${path}`)).status, 401);

      const ok = yield* request(`/api/files/raw?path=${path}`, {
        headers: { [AUTH_HEADER]: "yes" },
      });
      assert.equal(ok.status, 200);
      assert.equal(yield* text(ok), "0123456789");

      const ranged = yield* request(`/api/files/raw?path=${path}`, {
        headers: { [AUTH_HEADER]: "yes", range: "bytes=2-5" },
      });
      assert.equal(ranged.status, 206);
      assert.equal(ranged.headers.get("content-range"), "bytes 2-5/10");
      assert.equal(yield* text(ranged), "2345");

      const outside = yield* request(
        `/api/files/raw?path=${encodeURIComponent(`${sandbox}/outside.txt`)}`,
        { headers: { [AUTH_HEADER]: "yes" } },
      );
      assert.equal(outside.status, 404);
    }).pipe(Effect.scoped),
  );
});

it("parses single byte ranges", () => {
  assert.deepEqual(parseRangeHeader("bytes=0-4", 10), { start: 0, end: 4 });
  assert.deepEqual(parseRangeHeader("bytes=5-", 10), { start: 5, end: 9 });
  assert.deepEqual(parseRangeHeader("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRangeHeader("bytes=0-100", 10), { start: 0, end: 9 });
  assert.equal(parseRangeHeader("bytes=10-", 10), "unsatisfiable");
  assert.equal(parseRangeHeader("bytes=0-1,3-4", 10), null);
  assert.equal(parseRangeHeader(undefined, 10), null);
});
