/**
 * "Give it your material" — the reading job behind
 * `POST /api/manager/materials/read` and `GET /api/manager/materials/read/{jobId}`.
 *
 * A project's `materials/` folder (plus links the person pasted) is read item
 * by item (queued → reading → read / skipped / failed, visible to a UI that
 * polls every 500 ms), each item gets a one-line summary from Uno AI, and the
 * whole gets 3–5 "what your AI learned" bullets. The result lands in
 * `materials/README.md` — the file agents in that project read later — and
 * the files are copied to the account's Cloud storage under
 * `<project>/materials/`.
 *
 * Jobs live in memory for an hour; one running job per project folder.
 * Pure: the model, the cloud upload and the extractors are injected.
 *
 * @module setupTools/materialsJob
 */
import { randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import nodePath from "node:path";

import { extractFile, extractLink, type Extracted } from "./materialsExtract.ts";

export const MATERIALS_FOLDER = "materials";
export const MATERIALS_SUMMARY_FILE = "README.md";
/** Where the summary goes when the person already keeps their own README.md there. */
export const MATERIALS_SUMMARY_FALLBACK_FILE = "UNO-SUMMARY.md";
export const MATERIALS_SUMMARY_MARKER = "<!-- uno-work:materials-summary -->";
export const MATERIALS_SUMMARY_TITLE = "What your AI learned from this folder";
export const NO_GATEWAY_ERROR = "Uno AI isn't set up on this computer";
export const MATERIALS_JOB_TTL_MS = 60 * 60 * 1000;
export const MATERIALS_MAX_FILES = 100;
export const MATERIALS_MAX_LINKS = 20;
export const CLOUD_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

export type MaterialItemState = "queued" | "reading" | "read" | "skipped" | "failed";

export interface MaterialItemView {
  readonly name: string;
  readonly kind: "file" | "link";
  readonly state: MaterialItemState;
  readonly note: string | null;
}

export interface MaterialsJobView {
  readonly state: "running" | "done" | "failed";
  readonly items: ReadonlyArray<MaterialItemView>;
  readonly learned: ReadonlyArray<string>;
  readonly savedToCloud: string | null;
  readonly summaryPath: string | null;
  readonly error: string | null;
}

/** What the model gets per item and gives back. */
export interface MaterialsModel {
  readonly summarizeItem: (input: {
    readonly name: string;
    readonly kind: "file" | "link";
    readonly text: string;
  }) => Promise<string>;
  readonly learned: (
    items: ReadonlyArray<{ readonly name: string; readonly summary: string }>,
  ) => Promise<ReadonlyArray<string>>;
}

export interface MaterialsCloudUpload {
  /** "<project>/materials" as the person sees it in Files → Cloud storage. */
  readonly displayPath: string;
  /** Uploads one file; rejects with a message for the person. */
  readonly upload: (input: {
    readonly absolutePath: string;
    readonly relativeName: string;
    readonly size: number;
  }) => Promise<void>;
}

export interface MaterialsJobDeps {
  /** The model for this job, or null when there's no gateway key. */
  readonly model: () => Promise<MaterialsModel | null>;
  /** Cloud storage for this job, or null (not linked); rejects when unreachable. */
  readonly cloud: (projectName: string) => Promise<MaterialsCloudUpload | null>;
  readonly extractFile?: (absolutePath: string) => Promise<Extracted>;
  readonly extractLink?: (url: string) => Promise<Extracted>;
  readonly now?: () => number;
  /** POSIX uid the project folder must belong to; null skips the check. */
  readonly ownerUid?: number | null;
}

export class MaterialsJobError extends Error {
  readonly status: number;
  readonly code: string;
  readonly jobId: string | null;
  constructor(status: number, code: string, message: string, jobId: string | null = null) {
    super(message);
    this.name = "MaterialsJobError";
    this.status = status;
    this.code = code;
    this.jobId = jobId;
  }
}

interface ItemRecord {
  name: string;
  kind: "file" | "link";
  state: MaterialItemState;
  note: string | null;
  summary: string | null;
  /** Files only. */
  absolutePath: string | null;
  size: number;
  cloudError: string | null;
}

interface JobRecord {
  readonly id: string;
  readonly projectPath: string;
  state: "running" | "done" | "failed";
  items: ItemRecord[];
  learned: string[];
  savedToCloud: string | null;
  summaryPath: string | null;
  error: string | null;
  finishedAt: number | null;
}

function viewOf(job: JobRecord): MaterialsJobView {
  return {
    state: job.state,
    items: job.items.map((item) => ({
      name: item.name,
      kind: item.kind,
      state: item.state,
      note:
        [item.summary ?? item.note, item.summary ? item.note : null, item.cloudError]
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join(" · ") || null,
    })),
    learned: [...job.learned],
    savedToCloud: job.savedToCloud,
    summaryPath: job.summaryPath,
    error: job.error,
  };
}

/**
 * The setup's own notes in `materials/`: the summary it writes, and
 * `links.md` (the links the person added — read as links, not as a file).
 */
export const MATERIALS_LINKS_FILE = "links.md";

const isSummaryName = (name: string) =>
  name.toLowerCase() === MATERIALS_SUMMARY_FILE.toLowerCase() ||
  name.toLowerCase() === MATERIALS_SUMMARY_FALLBACK_FILE.toLowerCase() ||
  name.toLowerCase() === MATERIALS_LINKS_FILE;

/** Files of `materials/`: non-hidden, top level and one folder down, no symlinks. */
export async function listMaterialFiles(
  materialsDir: string,
): Promise<ReadonlyArray<{ name: string; absolutePath: string; size: number }>> {
  const out: Array<{ name: string; absolutePath: string; size: number }> = [];
  const visit = async (dir: string, prefix: string, depth: number) => {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      if (depth === 0 && isSummaryName(entry.name)) continue;
      const absolutePath = nodePath.join(dir, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth === 0) await visit(absolutePath, name, 1);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks, sockets: not the person's material
      const stats = await fsPromises.stat(absolutePath).catch(() => null);
      if (stats === null) continue;
      out.push({ name, absolutePath, size: stats.size });
    }
  };
  await visit(materialsDir, "", 0);
  return out;
}

function normalizeLinks(links: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of links) {
    const link = raw.trim();
    if (link.length === 0 || seen.has(link)) continue;
    seen.add(link);
    out.push(link);
  }
  return out;
}

type SummaryItem = {
  readonly name: string;
  readonly kind: "file" | "link";
  readonly state: MaterialItemState;
  readonly summary: string | null;
  readonly note: string | null;
};

function summaryLine(item: SummaryItem): string {
  const label = item.kind === "link" ? item.name : `\`${item.name}\``;
  const what =
    item.summary ??
    (item.state === "read"
      ? (item.note ?? "read")
      : `${item.state === "skipped" ? "not read" : "couldn't read"}${item.note ? `: ${item.note}` : ""}`);
  return `- ${label} — ${what}`;
}

/** The README agents read later. */
export function renderMaterialsSummary(input: {
  readonly learned: ReadonlyArray<string>;
  readonly items: ReadonlyArray<SummaryItem>;
  readonly savedToCloud: string | null;
  readonly date: string;
}): string {
  const files = input.items.filter((item) => item.kind === "file");
  const links = input.items.filter((item) => item.kind === "link");
  return [
    MATERIALS_SUMMARY_MARKER,
    `# ${MATERIALS_SUMMARY_TITLE}`,
    "",
    ...(input.learned.length > 0
      ? input.learned.map((bullet) => `- ${bullet}`)
      : ["- (No summary yet: Uno AI wasn't available when this folder was read.)"]),
    ...(files.length > 0 ? ["", "## Files", "", ...files.map(summaryLine)] : []),
    ...(links.length > 0 ? ["", "## Links", "", ...links.map(summaryLine)] : []),
    "",
    `_Read by Uno Work on ${input.date}.${
      input.savedToCloud ? ` A copy of the files is in Cloud storage: ${input.savedToCloud}.` : ""
    } Add files to this folder and read it again from Setup to refresh this page._`,
    "",
  ].join("\n");
}

export interface MaterialsJobs {
  readonly start: (input: {
    readonly projectPath: string;
    readonly links: ReadonlyArray<string>;
  }) => Promise<{ readonly jobId: string }>;
  readonly get: (jobId: string) => MaterialsJobView | null;
  /** Resolves when the job has finished (tests). */
  readonly settled: (jobId: string) => Promise<void>;
}

export function makeMaterialsJobs(deps: MaterialsJobDeps): MaterialsJobs {
  const now = deps.now ?? Date.now;
  const readFile = deps.extractFile ?? ((absolutePath: string) => extractFile(absolutePath));
  const readLink = deps.extractLink ?? ((url: string) => extractLink(url));
  const jobs = new Map<string, JobRecord>();
  const running = new Map<string, Promise<void>>();

  const sweep = () => {
    for (const [id, job] of jobs) {
      if (job.finishedAt !== null && now() - job.finishedAt > MATERIALS_JOB_TTL_MS) jobs.delete(id);
    }
  };

  const resolveProject = async (projectPath: string): Promise<string> => {
    if (typeof projectPath !== "string" || !nodePath.isAbsolute(projectPath)) {
      throw new MaterialsJobError(
        400,
        "invalid_project_path",
        "projectPath must be an absolute path.",
      );
    }
    const real = await fsPromises.realpath(projectPath).catch(() => null);
    const stats = real === null ? null : await fsPromises.stat(real).catch(() => null);
    if (real === null || stats === null || !stats.isDirectory()) {
      throw new MaterialsJobError(404, "project_not_found", "That project folder doesn't exist.");
    }
    const ownerUid = deps.ownerUid === undefined ? (process.getuid?.() ?? null) : deps.ownerUid;
    if (ownerUid !== null && stats.uid !== ownerUid) {
      throw new MaterialsJobError(
        403,
        "project_not_owned",
        "That folder belongs to another user of this computer.",
      );
    }
    return real;
  };

  const run = async (job: JobRecord) => {
    const materialsDir = nodePath.join(job.projectPath, MATERIALS_FOLDER);
    const projectName = nodePath.basename(job.projectPath);
    const model = await deps.model().catch(() => null);
    if (model === null) job.error = NO_GATEWAY_ERROR;

    // The Cloud copy runs next to the reading.
    const fileItems = job.items.filter((item) => item.kind === "file");
    const cloudDone = (async () => {
      if (fileItems.length === 0) return;
      let cloud: MaterialsCloudUpload | null;
      try {
        cloud = await deps.cloud(projectName);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        for (const item of fileItems) item.cloudError = `not saved to Cloud storage: ${message}`;
        return;
      }
      if (cloud === null) return;
      let allSaved = true;
      for (const item of fileItems) {
        if (item.size > CLOUD_UPLOAD_MAX_BYTES) {
          item.cloudError = "not saved to Cloud storage: bigger than 200 MB";
          allSaved = false;
          continue;
        }
        try {
          await cloud.upload({
            absolutePath: item.absolutePath!,
            relativeName: item.name,
            size: item.size,
          });
        } catch (cause) {
          allSaved = false;
          item.cloudError = `not saved to Cloud storage: ${cause instanceof Error ? cause.message : String(cause)}`;
        }
      }
      job.savedToCloud = allSaved ? cloud.displayPath : null;
    })();

    for (const item of job.items) {
      item.state = "reading";
      const extracted =
        item.kind === "file" ? await readFile(item.absolutePath!) : await readLink(item.name);
      item.note = extracted.note;
      if (extracted.state === "read" && extracted.text !== null && model !== null) {
        item.summary = await model
          .summarizeItem({ name: item.name, kind: item.kind, text: extracted.text })
          .then((summary) => summary.trim().split(/\r?\n/)[0]!.trim() || null)
          .catch(() => null);
      }
      item.state = extracted.state;
    }

    if (model !== null) {
      const summarized = job.items
        .filter((item) => item.summary !== null)
        .map((item) => ({ name: item.name, summary: item.summary! }));
      // Images and archives still tell something by their names.
      const named = job.items
        .filter((item) => item.summary === null && item.state === "read")
        .map((item) => ({ name: item.name, summary: item.note ?? "read" }));
      if (summarized.length + named.length > 0) {
        job.learned = await model
          .learned([...summarized, ...named])
          .then((bullets) =>
            bullets
              .map((bullet) => bullet.replace(/^[-*•\s]+/, "").trim())
              .filter((bullet) => bullet.length > 0)
              .slice(0, 5),
          )
          .catch((cause) => {
            job.error = `Uno AI couldn't sum it up: ${cause instanceof Error ? cause.message : String(cause)}`;
            return [];
          });
      }
    }

    await cloudDone;

    if (job.items.length > 0) {
      await fsPromises.mkdir(materialsDir, { recursive: true });
      const readmePath = nodePath.join(materialsDir, MATERIALS_SUMMARY_FILE);
      const existing = await fsPromises.readFile(readmePath, "utf8").catch(() => null);
      // Never overwrite a README.md the person wrote themselves.
      const target =
        existing === null || existing.includes(MATERIALS_SUMMARY_MARKER)
          ? readmePath
          : nodePath.join(materialsDir, MATERIALS_SUMMARY_FALLBACK_FILE);
      await fsPromises.writeFile(
        target,
        renderMaterialsSummary({
          learned: job.learned,
          items: job.items,
          savedToCloud: job.savedToCloud,
          date: new Date(now()).toISOString().slice(0, 10),
        }),
        "utf8",
      );
      job.summaryPath = target;
    }
  };

  const start: MaterialsJobs["start"] = async (input) => {
    sweep();
    const projectPath = await resolveProject(input.projectPath);
    // Checked again right before the job is registered (listing is async).
    const refuseIfRunning = () => {
      for (const job of jobs.values()) {
        if (job.projectPath === projectPath && job.state === "running") {
          throw new MaterialsJobError(
            409,
            "already_running",
            "This folder is being read already.",
            job.id,
          );
        }
      }
    };
    refuseIfRunning();
    if (!Array.isArray(input.links) || input.links.some((link) => typeof link !== "string")) {
      throw new MaterialsJobError(400, "invalid_links", "links must be a list of web addresses.");
    }
    const links = normalizeLinks(input.links);
    if (links.length > MATERIALS_MAX_LINKS) {
      throw new MaterialsJobError(
        400,
        "too_many_links",
        `Up to ${MATERIALS_MAX_LINKS} links at a time.`,
      );
    }
    const files = await listMaterialFiles(nodePath.join(projectPath, MATERIALS_FOLDER));
    refuseIfRunning();
    const job: JobRecord = {
      id: randomUUID(),
      projectPath,
      state: "running",
      items: [
        ...files.slice(0, MATERIALS_MAX_FILES).map(
          (file): ItemRecord => ({
            name: file.name,
            kind: "file",
            state: "queued",
            note: null,
            summary: null,
            absolutePath: file.absolutePath,
            size: file.size,
            cloudError: null,
          }),
        ),
        ...links.map(
          (link): ItemRecord => ({
            name: link,
            kind: "link",
            state: "queued",
            note: null,
            summary: null,
            absolutePath: null,
            size: 0,
            cloudError: null,
          }),
        ),
      ],
      learned: [],
      savedToCloud: null,
      summaryPath: null,
      error: null,
      finishedAt: null,
    };
    if (files.length > MATERIALS_MAX_FILES) {
      job.error = `Only the first ${MATERIALS_MAX_FILES} files are read.`;
    }
    jobs.set(job.id, job);
    const done = run(job)
      .then(() => {
        job.state = "done";
      })
      .catch((cause: unknown) => {
        job.state = "failed";
        job.error = cause instanceof Error ? cause.message : String(cause);
        for (const item of job.items) {
          if (item.state === "queued" || item.state === "reading") item.state = "failed";
        }
      })
      .finally(() => {
        job.finishedAt = now();
        running.delete(job.id);
      });
    running.set(job.id, done);
    return { jobId: job.id };
  };

  return {
    start,
    get: (jobId) => {
      sweep();
      const job = jobs.get(jobId);
      return job ? viewOf(job) : null;
    },
    settled: (jobId) => running.get(jobId) ?? Promise.resolve(),
  };
}
