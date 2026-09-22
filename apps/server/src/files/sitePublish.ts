/**
 * "Publish as a website" — pushes a page or a folder to Uno Hosting
 * (`POST <console>/api/v1/deploy`, multipart), which gives it its own public
 * address, separate from this computer: it stays up while the computer sleeps
 * and runs on its own origin, so its scripts can't touch this daemon.
 *
 * Runs inside the daemon with the account key from settings; the key never
 * reaches the browser or an agent session.
 *
 * @module files/sitePublish
 */
import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import fsPromises from "node:fs/promises";
import nodePath from "node:path";

import type { FilesPublishSiteResult } from "@t3tools/contracts";

import { controlPlaneBaseUrl } from "../workspaceRegistry/unoCloudParse.ts";
import { FilesPathError } from "./filesPaths.ts";

/** Uno Hosting limits for a signed-in deploy (deploy/constants.go). */
export const SITE_MAX_FILES = 1000;
export const SITE_MAX_BYTES = 50 * 1024 * 1024;
const SITE_SKIP_DIRS = new Set(["node_modules", "__pycache__", "venv"]);
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const PUBLISH_TIMEOUT_MS = 120_000;

export interface SiteFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly size: number;
}

/** A name a person would recognise as the site address: `Q3 Report` → `q3-report-7f2a`. */
export function suggestSiteSlug(name: string, suffix = randomBytes(2).toString("hex")): string {
  const base = name
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/g, "");
  return `${base.length >= 2 ? base : "site"}-${suffix}`;
}

export function validateSiteSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  if (!SLUG_PATTERN.test(normalized)) {
    throw new FilesPathError(
      "invalid_name",
      "Site names use 3–30 lowercase letters, digits and dashes, and can't start or end with a dash.",
    );
  }
  return normalized;
}

/** Non-hidden files under `folder`, in a stable order, within Uno Hosting limits. */
export async function collectSiteFiles(folder: string): Promise<SiteFile[]> {
  const files: SiteFile[] = [];
  let total = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let dirents: Dirent[];
    try {
      dirents = await fsPromises.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((left, right) => left.name.localeCompare(right.name));
    for (const dirent of dirents) {
      // Dotfiles (.env, .git, …) never leave the computer.
      if (dirent.name.startsWith(".")) continue;
      const absolutePath = nodePath.join(directory, dirent.name);
      const relativePath = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (!SITE_SKIP_DIRS.has(dirent.name)) await walk(absolutePath, relativePath);
        continue;
      }
      if (!dirent.isFile()) continue; // symlinks are skipped: they could point anywhere
      const { size } = await fsPromises.stat(absolutePath);
      total += size;
      files.push({ relativePath, absolutePath, size });
      if (files.length > SITE_MAX_FILES) {
        throw new FilesPathError(
          "forbidden",
          `This folder has more than ${SITE_MAX_FILES} files — too many for one website.`,
        );
      }
      if (total > SITE_MAX_BYTES) {
        throw new FilesPathError(
          "forbidden",
          "This folder is bigger than 50 MB — too big for one website.",
        );
      }
    }
  };
  await walk(folder, "");
  return files;
}

interface DeployResponse {
  readonly slug?: string;
  readonly url?: string;
  readonly files_count?: number;
  readonly size_bytes?: number;
  readonly error?: string;
  readonly message?: string;
}

function deployErrorMessage(status: number, body: DeployResponse | null): string {
  const code = body?.error ?? "";
  if (status === 401 || code === "INVALID_API_KEY") {
    return "Uno Hosting didn't accept this computer's account key. Reconnect your Uno account in Settings.";
  }
  if (status === 403) {
    return "This computer isn't allowed to publish sites yet. Reopen it from the Uno console to refresh its access, then try again.";
  }
  if (status === 409 || code === "SLUG_ERROR") {
    return "That site name is taken. Pick another one.";
  }
  if (status === 413 || code === "SIZE_LIMIT") return "The site is too big for Uno Hosting.";
  if (status === 402) {
    return body?.message ?? "Your plan's hosting limit is reached. Remove an old site or upgrade.";
  }
  if (status === 429) return "Too many publishes in a row. Wait a minute and try again.";
  return body?.message ?? `Uno Hosting answered ${status}.`;
}

export async function publishToUnoHosting(input: {
  readonly path: string;
  readonly slug?: string | undefined;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<FilesPublishSiteResult> {
  const stats = await fsPromises.stat(input.path);
  let files: SiteFile[];
  if (stats.isDirectory()) {
    files = await collectSiteFiles(input.path);
    if (!files.some((file) => file.relativePath.toLowerCase() === "index.html")) {
      throw new FilesPathError(
        "not_found",
        "Add an index.html to this folder — it becomes the home page of the site.",
      );
    }
  } else {
    if (!/\.html?$/i.test(input.path)) {
      throw new FilesPathError(
        "not_a_file",
        "Only web pages (.html) and folders can be published.",
      );
    }
    if (stats.size > SITE_MAX_BYTES) {
      throw new FilesPathError("forbidden", "This page is bigger than 50 MB.");
    }
    // A single page becomes the site's home page.
    files = [{ relativePath: "index.html", absolutePath: input.path, size: stats.size }];
  }

  const slug =
    input.slug !== undefined && input.slug.trim().length > 0
      ? validateSiteSlug(input.slug)
      : suggestSiteSlug(nodePath.basename(input.path));

  const form = new FormData();
  form.append("slug", slug);
  for (const file of files) {
    const bytes = await fsPromises.readFile(file.absolutePath);
    form.append("files", new Blob([new Uint8Array(bytes)]), file.relativePath);
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${input.baseUrl ?? controlPlaneBaseUrl()}/api/v1/deploy`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => null)) as DeployResponse | null;
  if (!response.ok) {
    throw new FilesPathError("forbidden", deployErrorMessage(response.status, body));
  }
  const publishedSlug = body?.slug ?? slug;
  return {
    slug: publishedSlug,
    // Hosting's own base-domain setting has disagreed with the live host
    // before; the live address is `<slug>.uno4.dev`.
    url: `https://${publishedSlug}.uno4.dev/`,
    filesCount: body?.files_count ?? files.length,
    sizeBytes: body?.size_bytes ?? files.reduce((sum, file) => sum + file.size, 0),
  };
}
