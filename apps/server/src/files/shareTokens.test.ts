import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  decodeShareSubpath,
  generateShareToken,
  hashSharePassword,
  isValidSharePasswordProof,
  isWellFormedShareToken,
  resolveShareTarget,
  SharePasswordAttempts,
  sharePasswordProof,
  shareExpiresAt,
  shareStatus,
  verifySharePassword,
} from "./shareTokens.ts";

describe("share tokens", () => {
  it("issues 32-char url-safe tokens that don't repeat", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateShareToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(isWellFormedShareToken(token)).toBe(true);
    }
  });

  it("rejects malformed tokens before any lookup", () => {
    expect(isWellFormedShareToken("")).toBe(false);
    expect(isWellFormedShareToken("short")).toBe(false);
    expect(isWellFormedShareToken(`${"a".repeat(31)}/`)).toBe(false);
    expect(isWellFormedShareToken(`${"a".repeat(31)}.`)).toBe(false);
    expect(isWellFormedShareToken("a".repeat(33))).toBe(false);
  });
});

describe("share lifetime", () => {
  const now = new Date("2026-09-22T12:00:00.000Z");

  it("is active without expiry, expires at the deadline, and revoke wins", () => {
    expect(shareStatus({ expiresAt: null, revokedAt: null }, now)).toBe("active");
    expect(shareExpiresAt(now, null)).toBeNull();
    const expiresAt = shareExpiresAt(now, 3600)!;
    expect(expiresAt).toBe("2026-09-22T13:00:00.000Z");
    expect(shareStatus({ expiresAt, revokedAt: null }, now)).toBe("active");
    expect(shareStatus({ expiresAt, revokedAt: null }, new Date("2026-09-22T13:00:00.000Z"))).toBe(
      "expired",
    );
    expect(shareStatus({ expiresAt, revokedAt: now.toISOString() }, now)).toBe("revoked");
  });
});

describe("share passwords", () => {
  it("verifies the right password only, with a fresh salt each time", async () => {
    const first = await hashSharePassword("correct horse");
    const second = await hashSharePassword("correct horse");
    expect(first).not.toBe(second);
    expect(first.startsWith("scrypt$")).toBe(true);
    expect(await verifySharePassword("correct horse", first)).toBe(true);
    expect(await verifySharePassword("correct hors", first)).toBe(false);
    expect(await verifySharePassword("correct horse", "garbage")).toBe(false);
  });

  it("binds the unlock cookie to the token and the password hash", async () => {
    const hash = await hashSharePassword("pw-1234");
    const token = generateShareToken();
    const proof = sharePasswordProof(token, hash);
    expect(isValidSharePasswordProof(token, hash, proof)).toBe(true);
    expect(isValidSharePasswordProof(generateShareToken(), hash, proof)).toBe(false);
    expect(isValidSharePasswordProof(token, await hashSharePassword("pw-1234"), proof)).toBe(false);
    expect(isValidSharePasswordProof(token, hash, undefined)).toBe(false);
    expect(isValidSharePasswordProof(token, hash, `${proof}x`)).toBe(false);
  });

  it("locks a link after 10 wrong tries for 15 minutes", () => {
    const attempts = new SharePasswordAttempts();
    const start = 1_000_000;
    for (let i = 0; i < 9; i += 1) attempts.recordFailure("s1", start);
    expect(attempts.isLocked("s1", start)).toBe(false);
    attempts.recordFailure("s1", start);
    expect(attempts.isLocked("s1", start)).toBe(true);
    expect(attempts.isLocked("s2", start)).toBe(false);
    expect(attempts.isLocked("s1", start + 15 * 60 * 1000 + 1)).toBe(false);
  });
});

describe("decodeShareSubpath", () => {
  it("decodes plain segments", () => {
    expect(decodeShareSubpath("")).toEqual([]);
    expect(decodeShareSubpath("/")).toEqual([]);
    expect(decodeShareSubpath("/docs/My%20Report.pdf")).toEqual(["docs", "My Report.pdf"]);
  });

  it("refuses traversal, hidden names and encoded separators", () => {
    for (const raw of [
      "/..",
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/docs/%2E%2E%2Fsecret",
      "/.env",
      "/.git/config",
      "/docs/.ssh/id_rsa",
      "/a%2Fb",
      "/a%5Cb",
      "/a%00b",
      "/%E0%A4%A",
    ]) {
      expect(decodeShareSubpath(raw), raw).toBeNull();
    }
  });
});

describe("resolveShareTarget", () => {
  let base: string;
  let shared: string;
  let outside: string;

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "uno-share-")));
    shared = nodePath.join(base, "shared");
    outside = nodePath.join(base, "private");
    fs.mkdirSync(nodePath.join(shared, "sub"), { recursive: true });
    fs.mkdirSync(nodePath.join(shared, ".git"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(nodePath.join(shared, "index.html"), "<h1>hi</h1>");
    fs.writeFileSync(nodePath.join(shared, "sub", "a.txt"), "a");
    fs.writeFileSync(nodePath.join(shared, ".env"), "SECRET=1");
    fs.writeFileSync(nodePath.join(shared, ".git", "config"), "x");
    fs.writeFileSync(nodePath.join(outside, "secret.txt"), "secret");
    fs.writeFileSync(nodePath.join(base, "neighbour.txt"), "neighbour");
    fs.symlinkSync(nodePath.join(outside, "secret.txt"), nodePath.join(shared, "link.txt"));
    fs.symlinkSync(outside, nodePath.join(shared, "linkdir"));
    fs.symlinkSync(nodePath.join(shared, ".env"), nodePath.join(shared, "env-link"));
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("a file link serves that one file and nothing next to it", async () => {
    const file = nodePath.join(base, "neighbour.txt");
    expect(await resolveShareTarget({ path: file, kind: "file" }, [])).toEqual({
      kind: "file",
      path: file,
    });
    expect(await resolveShareTarget({ path: file, kind: "file" }, ["other.txt"])).toEqual({
      kind: "not_found",
    });
    expect(await resolveShareTarget({ path: file, kind: "file" }, [".."])).toEqual({
      kind: "not_found",
    });
  });

  it("a file link stops working when its path becomes a folder", async () => {
    expect(await resolveShareTarget({ path: shared, kind: "file" }, [])).toEqual({
      kind: "not_found",
    });
  });

  it("a folder link serves its own files and subfolders", async () => {
    expect(await resolveShareTarget({ path: shared, kind: "folder" }, [])).toMatchObject({
      kind: "directory",
      path: shared,
    });
    expect(await resolveShareTarget({ path: shared, kind: "folder" }, ["sub", "a.txt"])).toEqual({
      kind: "file",
      path: nodePath.join(shared, "sub", "a.txt"),
    });
  });

  it("a folder link never serves hidden files, parents or symlinks leading out", async () => {
    const share = { path: shared, kind: "folder" as const };
    for (const segments of [
      [".env"],
      [".git", "config"],
      [".."],
      ["..", "neighbour.txt"],
      ["..", "private", "secret.txt"],
      ["sub", "..", "..", "neighbour.txt"],
      ["link.txt"],
      ["linkdir", "secret.txt"],
      ["env-link"],
      ["missing.txt"],
    ]) {
      expect(await resolveShareTarget(share, segments), segments.join("/")).toEqual({
        kind: "not_found",
      });
    }
  });

  it("a deleted target serves nothing", async () => {
    expect(
      await resolveShareTarget({ path: nodePath.join(base, "gone.txt"), kind: "file" }, []),
    ).toEqual({ kind: "not_found" });
  });
});
