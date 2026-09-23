import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PREVIEW_SITE_TTL_MS,
  issuePreviewSite,
  makePreviewSiteTokens,
  resolvePreviewSiteFile,
} from "./previewSite.ts";

let root: string;
let site: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "preview-site-"));
  site = path.join(root, "site");
  await mkdir(path.join(site, "assets", "fonts"), { recursive: true });
  await writeFile(path.join(site, "index.html"), '<link rel="stylesheet" href="assets/a.css">');
  await writeFile(path.join(site, "assets", "a.css"), "body{}");
  await writeFile(path.join(site, "assets", "fonts", "Inter Var.woff2"), "font");
  await writeFile(path.join(site, ".env"), "SECRET=1");
  await writeFile(path.join(root, "outside.txt"), "no");
  await symlink(path.join(root, "outside.txt"), path.join(site, "assets", "link.txt"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const tokenOf = (url: string) => url.split("/")[3]!;

describe("preview site", () => {
  it("serves the page's own folder: relative CSS, nested fonts with spaces", async () => {
    const tokens = makePreviewSiteTokens();
    const { url } = await issuePreviewSite(
      tokens,
      path.join(site, "index.html"),
      "/api/preview-site",
    );
    expect(url).toMatch(/^\/api\/preview-site\/[\w-]+\/index\.html$/);
    const token = tokenOf(url);
    expect(await resolvePreviewSiteFile(tokens, token, "assets/a.css")).toMatch(/a\.css$/);
    expect(await resolvePreviewSiteFile(tokens, token, "assets/fonts/Inter%20Var.woff2")).toMatch(
      /Inter Var\.woff2$/,
    );
    // Same folder again: the same token.
    const again = await issuePreviewSite(
      tokens,
      path.join(site, "index.html"),
      "/api/preview-site",
    );
    expect(tokenOf(again.url)).toBe(token);
  });

  it("never leaves the folder: .., encoded .., hidden files, symlinks out, unknown tokens", async () => {
    const tokens = makePreviewSiteTokens();
    const token = tokenOf(
      (await issuePreviewSite(tokens, path.join(site, "index.html"), "/p")).url,
    );
    expect(await resolvePreviewSiteFile(tokens, token, "../outside.txt")).toBeNull();
    expect(await resolvePreviewSiteFile(tokens, token, "%2e%2e/outside.txt")).toBeNull();
    expect(
      await resolvePreviewSiteFile(tokens, token, "assets%2f..%2f..%2foutside.txt"),
    ).toBeNull();
    expect(await resolvePreviewSiteFile(tokens, token, ".env")).toBeNull();
    expect(await resolvePreviewSiteFile(tokens, token, "assets/link.txt")).toBeNull();
    expect(await resolvePreviewSiteFile(tokens, token, "assets")).toBeNull();
    expect(await resolvePreviewSiteFile(tokens, "nope", "index.html")).toBeNull();
  });

  it("tokens expire", async () => {
    let now = 0;
    const tokens = makePreviewSiteTokens(() => now);
    const token = tokenOf(
      (await issuePreviewSite(tokens, path.join(site, "index.html"), "/p")).url,
    );
    now += PREVIEW_SITE_TTL_MS + 1;
    expect(await resolvePreviewSiteFile(tokens, token, "index.html")).toBeNull();
  });
});
