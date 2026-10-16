import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  contentTypeFor,
  isUploadAddress,
  shareablePathProblem,
  shareLocalFileViaDrive,
  type DriveShareFileDeps,
} from "./driveShareFile.ts";

const HOME = "/Users/misha";
const CONSOLE = "https://console.uno4.dev";
const UPLOAD = "https://console.uno4.dev/api/v1/drive/u/AbCdEfGh12345678";

function deps(overrides: Partial<DriveShareFileDeps> = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const uploads: Array<{ url: string; size: number; contentType: string }> = [];
  const value: DriveShareFileDeps & { consoleUrl: string } = {
    consoleUrl: CONSOLE,
    homeDir: HOME,
    accountRequest: async (input) => {
      calls.push(input);
      if (input.path === "/api/v1/drive/upload-link") return { status: 200, body: { url: UPLOAD } };
      if (input.path === "/api/v1/drive/shares") {
        return {
          status: 201,
          body: {
            id: 7,
            key: "Shared/report.pdf",
            url: "https://console.uno4.dev/d/tok",
            expires_at: "2026-10-23T00:00:00Z",
          },
        };
      }
      return { status: 404, body: null };
    },
    inspect: async (path) => ({ realPath: path, isFile: true, size: 1234 }),
    upload: async (input) => {
      uploads.push(input);
      return { status: 201, body: { key: "Shared/report.pdf" } };
    },
    ...overrides,
  };
  return { value, calls, uploads };
}

describe("shareablePathProblem", () => {
  it("allows ordinary files in the home folder", () => {
    expect(shareablePathProblem(Path.join(HOME, "Documents", "report.pdf"), HOME)).toBeNull();
  });

  it("refuses files outside home, hidden files and keys", () => {
    expect(shareablePathProblem("/etc/hosts", HOME)).toMatch(/home folder/);
    expect(shareablePathProblem(HOME, HOME)).toMatch(/home folder/);
    expect(shareablePathProblem(Path.join(HOME, ".ssh", "config"), HOME)).toMatch(/Hidden/);
    expect(shareablePathProblem(Path.join(HOME, "app", ".env"), HOME)).toMatch(/Hidden/);
    expect(shareablePathProblem(Path.join(HOME, "keys", "id_ed25519"), HOME)).toMatch(/key file/);
    expect(shareablePathProblem(Path.join(HOME, "certs", "server.pem"), HOME)).toMatch(/key file/);
  });
});

describe("isUploadAddress", () => {
  it("accepts only the console's upload route", () => {
    expect(isUploadAddress(UPLOAD, CONSOLE)).toBe(true);
    expect(
      isUploadAddress("https://console.uno.place/api/v1/drive/u/AbCdEfGh12345678", CONSOLE),
    ).toBe(true);
    expect(isUploadAddress("http://evil.test/api/v1/drive/u/AbCdEfGh12345678", CONSOLE)).toBe(
      false,
    );
    expect(isUploadAddress("https://console.uno4.dev/api/v1/buckets/1", CONSOLE)).toBe(false);
    expect(isUploadAddress(`${UPLOAD}?x=1`, CONSOLE)).toBe(false);
    expect(isUploadAddress(null, CONSOLE)).toBe(false);
    expect(
      isUploadAddress(
        "http://127.0.0.1:8080/api/v1/drive/u/AbCdEfGh12345678",
        "http://127.0.0.1:8080",
      ),
    ).toBe(true);
  });
});

describe("shareLocalFileViaDrive", () => {
  it("uploads a copy to Shared/ and links to it", async () => {
    const { value, calls, uploads } = deps();
    const result = await shareLocalFileViaDrive(value, {
      path: Path.join(HOME, "Documents", "report.pdf"),
      expiresInHours: 24,
    });
    expect(result).toEqual({
      ok: true,
      key: "Shared/report.pdf",
      url: "https://console.uno4.dev/d/tok",
      expiresAt: expect.stringContaining("2026-10-23"),
    });
    expect(calls).toEqual([
      { method: "POST", path: "/api/v1/drive/upload-link", body: { folder: "Shared" } },
      {
        method: "POST",
        path: "/api/v1/drive/shares",
        body: { key: "Shared/report.pdf", expires_in_hours: 24 },
      },
    ]);
    expect(uploads).toEqual([
      expect.objectContaining({
        url: `${UPLOAD}?name=report.pdf`,
        size: 1234,
        contentType: "application/pdf",
      }),
    ]);
  });

  it("refuses before uploading anything", async () => {
    const hidden = deps();
    expect(
      await shareLocalFileViaDrive(hidden.value, { path: Path.join(HOME, ".aws", "credentials") }),
    ).toMatchObject({ ok: false });
    expect(hidden.calls).toEqual([]);

    const folder = deps({ inspect: async (path) => ({ realPath: path, isFile: false, size: 0 }) });
    expect(
      await shareLocalFileViaDrive(folder.value, { path: Path.join(HOME, "Documents") }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/folder/) });

    const big = deps({
      inspect: async (path) => ({ realPath: path, isFile: true, size: 3 * 1024 ** 3 }),
    });
    expect(
      await shareLocalFileViaDrive(big.value, { path: Path.join(HOME, "movie.mov") }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/too big/) });
    expect(big.calls).toEqual([]);

    // A symlink in home that points at a key: judged by where it really is.
    const link = deps({
      inspect: async () => ({
        realPath: Path.join(HOME, ".ssh", "id_rsa"),
        isFile: true,
        size: 10,
      }),
    });
    expect(
      await shareLocalFileViaDrive(link.value, { path: Path.join(HOME, "innocent.txt") }),
    ).toMatchObject({ ok: false });
    expect(link.calls).toEqual([]);
  });

  it("says what to do when not signed in or storage is full", async () => {
    const signedOut = deps({
      accountRequest: async () => ({ status: 401, body: { error: "NOT_SIGNED_IN" } }),
    });
    expect(
      await shareLocalFileViaDrive(signedOut.value, { path: Path.join(HOME, "a.txt") }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/Sign in/) });

    const full = deps({
      upload: async () => ({ status: 402, body: { error: "STORAGE_QUOTA_EXCEEDED" } }),
    });
    expect(
      await shareLocalFileViaDrive(full.value, { path: Path.join(HOME, "a.txt") }),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/full/),
    });

    const weird = deps({
      accountRequest: async () => ({ status: 200, body: { url: "https://evil.test/upload" } }),
    });
    expect(
      await shareLocalFileViaDrive(weird.value, { path: Path.join(HOME, "a.txt") }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/upload address/) });
  });

  it("reads paths named from the home folder", async () => {
    const seen: string[] = [];
    const { value } = deps({
      inspect: async (path) => {
        seen.push(path);
        return { realPath: path, isFile: true, size: 5 };
      },
    });
    await shareLocalFileViaDrive(value, { path: "~/Documents/a.txt" });
    await shareLocalFileViaDrive(value, { path: "Documents/b.txt" });
    expect(seen).toEqual([
      Path.join(HOME, "Documents", "a.txt"),
      Path.join(HOME, "Documents", "b.txt"),
    ]);
  });

  it("guesses a content type hint", () => {
    expect(contentTypeFor("Deck.PPTX")).toContain("presentationml");
    expect(contentTypeFor("noext")).toBe("application/octet-stream");
  });
});
