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
/** The upload itself (up to 50 MB from a cloud computer). */
const PUBLISH_TIMEOUT_MS = 120_000;
/**
 * How long to wait for a publish Uno Hosting runs in the background (202).
 * Hosting gives a job 15 minutes; the uno-work MCP tool call ends at 900 s,
 * so the agent gets a clear answer before its own call times out.
 */
const PUBLISH_WAIT_MS = 10 * 60_000;
const POLL_DEFAULT_MS = 3_000;
const POLL_MIN_MS = 1_000;
const POLL_MAX_MS = 15_000;
const STATUS_TIMEOUT_MS = 20_000;

/** What stayed on the computer, and why — shown to the person and the agent. */
export interface SiteSkip {
  readonly relativePath: string;
  readonly reason: "key file" | "hidden" | "packages" | "link";
}

const PRIVATE_FILE_NAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const PRIVATE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".kdbx",
  ".tfstate",
  ".tfvars",
]);

/**
 * Credential files by name — a copy of Uno Hosting's rule
 * (fishcode back/internal/sitefiles isSecretFileName; keep the three copies —
 * there, the console's sitePlan.ts and here — in step). Hosting refuses to
 * serve them anyway; this keeps them from leaving the computer at all.
 */
export function isSecretSiteFileName(base: string): boolean {
  const b = base.toLowerCase();
  if (PRIVATE_FILE_NAMES.has(b)) return true;
  const ext = nodePath.extname(b);
  if (PRIVATE_EXTENSIONS.has(ext)) return true;
  if (b.endsWith(".tfstate.backup")) return true;
  for (const k of PRIVATE_FILE_NAMES) {
    if (b.startsWith(k) && ext !== ".pub") return true;
  }
  if ([".json", ".yaml", ".yml", ".toml", ".ini", ".txt", ".csv", ""].includes(ext)) {
    const stem = ext ? b.slice(0, -ext.length) : b;
    if (
      stem.includes("service-account") ||
      stem.includes("service_account") ||
      stem.includes("serviceaccount") ||
      stem.includes("firebase-adminsdk") ||
      stem.startsWith("credentials") ||
      stem.startsWith("client_secret") ||
      stem === "secrets" ||
      stem.startsWith("secrets.") ||
      stem.startsWith("secret.")
    ) {
      return true;
    }
  }
  return false;
}

/** "service-account.json (key file), .env (hidden) and 3 more" — for a toast or the agent. */
export function describeSiteSkips(skips: ReadonlyArray<SiteSkip>, max = 5): string {
  const shown = skips.slice(0, max).map((skip) => `${skip.relativePath} (${skip.reason})`);
  const rest = skips.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

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

/** How much one upload may hold, and what to say when it is more. */
export interface CollectLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly tooManyMessage: string;
  readonly tooBigMessage: string;
}

const SITE_LIMITS: CollectLimits = {
  maxFiles: SITE_MAX_FILES,
  maxBytes: SITE_MAX_BYTES,
  tooManyMessage: `This folder has more than ${SITE_MAX_FILES} files — too many for one website.`,
  tooBigMessage: "This folder is bigger than 50 MB — too big for one website.",
};

/**
 * Non-hidden files under `folder`, in a stable order, within Uno Hosting
 * limits (or `limits`: Spark packs a folder the same way). What stays behind
 * (hidden files, key files, package folders, links) goes into `skips` when
 * given.
 */
export async function collectSiteFiles(
  folder: string,
  skips?: SiteSkip[],
  limits: CollectLimits = SITE_LIMITS,
): Promise<SiteFile[]> {
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
      const absolutePath = nodePath.join(directory, dirent.name);
      const relativePath = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      // Dotfiles (.env, .git, …) never leave the computer; .well-known is
      // public on purpose (security.txt, app links).
      if (dirent.name.startsWith(".") && dirent.name !== ".well-known") {
        skips?.push({
          relativePath: dirent.isDirectory() ? `${relativePath}/` : relativePath,
          reason: "hidden",
        });
        continue;
      }
      if (dirent.isDirectory()) {
        if (SITE_SKIP_DIRS.has(dirent.name)) {
          skips?.push({ relativePath: `${relativePath}/`, reason: "packages" });
        } else {
          await walk(absolutePath, relativePath);
        }
        continue;
      }
      if (!dirent.isFile()) {
        // Symlinks are skipped: they could point anywhere.
        if (dirent.isSymbolicLink()) skips?.push({ relativePath, reason: "link" });
        continue;
      }
      if (isSecretSiteFileName(dirent.name)) {
        skips?.push({ relativePath, reason: "key file" });
        continue;
      }
      const { size } = await fsPromises.stat(absolutePath);
      total += size;
      files.push({ relativePath, absolutePath, size });
      if (files.length > limits.maxFiles) {
        throw new FilesPathError("forbidden", limits.tooManyMessage);
      }
      if (total > limits.maxBytes) {
        throw new FilesPathError("forbidden", limits.tooBigMessage);
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
  readonly site_folder?: string;
  readonly left_out?: number;
  readonly has_password?: boolean;
  readonly ip_allowlist?: ReadonlyArray<string>;
  readonly tool?: string;
  readonly error?: string;
  readonly message?: string;
}

/**
 * 202 from POST /api/v1/deploy, or GET /api/v1/deploy/{id} (fishcode
 * site-deploy-async, 28.10): the publish runs in the background.
 */
interface DeployJobResponse {
  readonly deploy_id?: string;
  readonly status?: string;
  readonly status_url?: string;
  readonly retry_after_s?: number;
  readonly url?: string;
  readonly slug?: string;
  readonly result?: DeployResponse;
  readonly error?: string;
  readonly message?: string;
  readonly http_status?: number;
  readonly details?: DeployResponse;
}

/** Uno Hosting restarted mid-publish: the files never went live, publish again. */
const INTERRUPTED = "INTERRUPTED";

/** The account's site or storage limit: republishing an existing site doesn't count. */
export class SiteHostingLimitError extends FilesPathError {
  constructor(message: string) {
    super("forbidden", message);
    this.name = "SiteHostingLimitError";
  }
}

/** Mints a link that opens a protected site without its password. */
export const siteOpenLinkPath = (slug: string): string =>
  `/api/v1/deploys/${encodeURIComponent(slug)}/open-link`;

/** A link for one day: enough to read a report later, then the Uno sign-in takes over. */
export const SITE_OPEN_LINK_TTL_SECONDS = 24 * 60 * 60;

/** The console's `{url, expires_at}` (unix seconds, null: no expiry); null when malformed. */
export function parseSiteOpenLink(
  body: unknown,
): { readonly url: string; readonly expiresAtMs: number | null } | null {
  if (typeof body !== "object" || body === null) return null;
  const { url, expires_at: expiresAt } = body as { url?: unknown; expires_at?: unknown };
  if (typeof url !== "string" || !url.startsWith("https://")) return null;
  return {
    url,
    expiresAtMs: typeof expiresAt === "number" && expiresAt > 0 ? expiresAt * 1_000 : null,
  };
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
  // 02.10: hosting publishes a project's built site folder, never its source.
  if (code === "BACKEND_NEEDS_COMPUTER") {
    return "This folder is an app with a server side, not a website — Uno doesn't publish its code. Publish its built site folder (dist/, build/ or public/ with an index.html), or run it as an app on this computer.";
  }
  if (code === "BUILD_NEEDED") {
    const tool = typeof body?.tool === "string" && body.tool.length > 0 ? `${body.tool} ` : "";
    return `This folder is the source of a ${tool}project — build it first (npm run build), then publish the folder it makes (dist/ or build/ with an index.html).`;
  }
  if (code === "INVALID_ALLOWLIST" || code === "INVALID_IP_ALLOWLIST") {
    return body?.message ?? "Uno Hosting didn't accept the list of IPs or networks for this site.";
  }
  if (code === INTERRUPTED) {
    return "Uno Hosting restarted while publishing this site and it didn't go live. Publish it again.";
  }
  return body?.message ?? `Uno Hosting answered ${status}.`;
}

/** The status address hosting gave, on the same console as the upload. */
function deployStatusUrl(baseUrl: string, job: DeployJobResponse): string | null {
  const path = job.status_url;
  if (typeof path === "string" && /^\/api\/v1\/deploy\/[A-Za-z0-9_-]+$/.test(path)) {
    return `${baseUrl}${path}`;
  }
  if (typeof job.deploy_id === "string" && /^[A-Za-z0-9_-]+$/.test(job.deploy_id)) {
    return `${baseUrl}/api/v1/deploy/${job.deploy_id}`;
  }
  return null;
}

function pollDelayMs(job: DeployJobResponse): number {
  const seconds = job.retry_after_s;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return POLL_DEFAULT_MS;
  }
  return Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, seconds * 1000));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type DeployOutcome =
  | { readonly kind: "done"; readonly body: DeployResponse | null }
  | { readonly kind: "failed"; readonly status: number; readonly body: DeployResponse | null };

/**
 * Waits for a background publish (202) to finish. A status call that fails
 * (network, 5xx while hosting restarts) is tried again until the deadline:
 * the publish itself goes on server-side.
 */
async function waitForDeploy(input: {
  readonly job: DeployJobResponse;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImpl: typeof fetch;
  readonly waitMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}): Promise<DeployOutcome> {
  const statusUrl = deployStatusUrl(input.baseUrl, input.job);
  if (statusUrl === null) {
    throw new FilesPathError(
      "forbidden",
      "Uno Hosting took the site but didn't say where to follow it. Check the site list in a minute before publishing again.",
    );
  }
  const deadline = input.now() + input.waitMs;
  let delay = pollDelayMs(input.job);
  for (;;) {
    if (input.now() + delay > deadline) {
      const where = input.job.url ? ` (${input.job.url})` : "";
      throw new FilesPathError(
        "forbidden",
        `Uno Hosting is still publishing this site${where} after ${Math.round(input.waitMs / 60_000)} minutes. It may still finish: check the site list in a few minutes before publishing it again.`,
      );
    }
    await input.sleep(delay);
    let response: Response;
    try {
      response = await input.fetchImpl(statusUrl, {
        headers: { authorization: `Bearer ${input.apiKey}` },
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
    } catch {
      continue;
    }
    const body = (await response.json().catch(() => null)) as DeployJobResponse | null;
    if (response.status === 404) {
      throw new FilesPathError(
        "forbidden",
        "Uno Hosting lost track of this publish. Check the site list before publishing it again.",
      );
    }
    if (response.status === 401 || response.status === 403) {
      return { kind: "failed", status: response.status, body };
    }
    if (!response.ok || body === null) continue;
    if (body.status === "done") {
      return {
        kind: "done",
        body: body.result ?? {
          ...(body.url !== undefined ? { url: body.url } : {}),
          ...(body.slug !== undefined ? { slug: body.slug } : {}),
        },
      };
    }
    if (body.status === "failed") {
      const status = typeof body.http_status === "number" ? body.http_status : 500;
      const details = body.details ?? {};
      return {
        kind: "failed",
        status,
        body: {
          ...details,
          ...((details.error ?? body.error) !== undefined
            ? { error: (details.error ?? body.error)! }
            : {}),
          ...((details.message ?? body.message) !== undefined
            ? { message: (details.message ?? body.message)! }
            : {}),
        },
      };
    }
    delay = pollDelayMs(body);
  }
}

/** One POST /api/v1/deploy, followed to its end when hosting answers 202. */
async function postDeploy(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly form: FormData;
  readonly fetchImpl: typeof fetch;
  readonly waitMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}): Promise<DeployOutcome> {
  const response = await input.fetchImpl(`${input.baseUrl}/api/v1/deploy`, {
    method: "POST",
    // Answer at once and publish in the background: a big site takes minutes,
    // longer than a request may stay open. A console without background
    // publishes ignores both and answers 201 as before.
    headers: { authorization: `Bearer ${input.apiKey}`, prefer: "respond-async" },
    body: input.form,
    signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
  });
  if (response.status === 202) {
    const job = ((await response.json().catch(() => null)) ?? {}) as DeployJobResponse;
    return waitForDeploy({ ...input, job });
  }
  const body = (await response.json().catch(() => null)) as DeployResponse | null;
  return response.ok ? { kind: "done", body } : { kind: "failed", status: response.status, body };
}

/**
 * Where published sites live (Uno Hosting's SITES_BASE_DOMAIN in production,
 * since 10.2026). Only a fallback: the address hosting answers with wins.
 */
export const SITES_BASE_DOMAIN = "uno4.me";

/** Hosting's own `url` when it is an https address, else `<slug>.uno4.me`. */
export function liveSiteUrl(fromHosting: string | undefined, slug: string): string {
  if (typeof fromHosting === "string" && /^https:\/\/[a-z0-9.-]+\//i.test(`${fromHosting}/`)) {
    return fromHosting.endsWith("/") ? fromHosting : `${fromHosting}/`;
  }
  return `https://${slug}.${SITES_BASE_DOMAIN}/`;
}

export async function publishToUnoHosting(input: {
  readonly path: string;
  readonly slug?: string | undefined;
  /** Protects the site from its first second: sent with the upload. */
  readonly password?: string | undefined;
  /** Only these IPs/CIDRs may open it: sent with the upload. */
  readonly ipAllowlist?: ReadonlyArray<string> | undefined;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Tests: how long to wait for a background publish, and the clock. */
  readonly waitMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}): Promise<FilesPublishSiteResult> {
  const stats = await fsPromises.stat(input.path);
  let files: SiteFile[];
  const skips: SiteSkip[] = [];
  if (stats.isDirectory()) {
    files = await collectSiteFiles(input.path, skips);
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
  const password = input.password ?? "";
  if (password.length > 0 && (password.length < 10 || password.length > 128)) {
    throw new FilesPathError("invalid_name", "A site password is 10–128 characters.");
  }
  const ipAllowlist = (input.ipAllowlist ?? []).map((entry) => entry.trim()).filter(Boolean);

  const form = new FormData();
  form.append("slug", slug);
  // Access goes with the upload: hosting applies it before the site (or its
  // new files) is served, so a protected site is never open for a moment.
  if (password.length > 0) form.append("password", password);
  if (ipAllowlist.length > 0) form.append("ip_allowlist", ipAllowlist.join(","));
  form.append("async", "1");
  for (const file of files) {
    const bytes = await fsPromises.readFile(file.absolutePath);
    form.append("files", new Blob([new Uint8Array(bytes)]), file.relativePath);
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = input.baseUrl ?? controlPlaneBaseUrl();
  const deploy = () =>
    postDeploy({
      baseUrl,
      apiKey: input.apiKey,
      form,
      fetchImpl,
      waitMs: input.waitMs ?? PUBLISH_WAIT_MS,
      sleep: input.sleep ?? defaultSleep,
      now: input.now ?? Date.now,
    });
  let outcome = await deploy();
  // Hosting restarted mid-publish (a release): nothing went live — once more.
  if (outcome.kind === "failed" && outcome.body?.error === INTERRUPTED) {
    outcome = await deploy();
  }
  if (outcome.kind === "failed") {
    const message = deployErrorMessage(outcome.status, outcome.body);
    throw outcome.status === 402 || outcome.status === 429
      ? new SiteHostingLimitError(message)
      : new FilesPathError("forbidden", message);
  }
  const body = outcome.body;
  const publishedSlug = body?.slug ?? slug;

  const allowlist = Array.isArray(body?.ip_allowlist) ? body.ip_allowlist : undefined;

  return {
    slug: publishedSlug,
    // The address Uno Hosting answers with is the live one (`<slug>.uno4.me`
    // in production); a hard-coded domain went stale twice.
    url: liveSiteUrl(body?.url, publishedSlug),
    filesCount: body?.files_count ?? files.length,
    sizeBytes: body?.size_bytes ?? files.reduce((sum, file) => sum + file.size, 0),
    ...(skips.length > 0
      ? {
          skipped: skips.slice(0, 20).map((skip) => `${skip.relativePath} (${skip.reason})`),
          skippedCount: skips.length,
        }
      : {}),
    ...(typeof body?.site_folder === "string" && body.site_folder.length > 0
      ? { siteFolder: body.site_folder }
      : {}),
    ...(typeof body?.left_out === "number" && body.left_out > 0 ? { leftOut: body.left_out } : {}),
    ...(password.length > 0
      ? { hasPassword: true }
      : typeof body?.has_password === "boolean"
        ? { hasPassword: body.has_password }
        : {}),
    ...(allowlist !== undefined && allowlist.length > 0 ? { ipAllowlist: [...allowlist] } : {}),
  };
}
