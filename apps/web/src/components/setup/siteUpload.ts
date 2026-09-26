/**
 * "A website" on the goal-first start: a dropped folder or .zip goes into the
 * goal's project (`<project>/site`) and is published on Uno Hosting from the
 * computer (`files.publishSite`) — no GitHub, no agent, seconds.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import JSZip from "jszip";

import { ensureEnvironmentApi } from "../../environmentApi";
import { uploadFilesIntoDirectory, type ProjectUploadFile } from "../../projectUpload";
import { hasIndexHtml, isJunkPath, siteSlugFrom, stripSharedTopFolder } from "./goals";

/** Unpacks every .zip among the files (in the browser), keeps the rest. */
export async function expandZips(
  files: ReadonlyArray<ProjectUploadFile>,
): Promise<ProjectUploadFile[]> {
  const out: ProjectUploadFile[] = [];
  for (const file of files) {
    if (!/\.zip$/i.test(file.relativePath)) {
      out.push(file);
      continue;
    }
    const zip = await JSZip.loadAsync(await file.blob.arrayBuffer());
    const entries = Object.values(zip.files).filter(
      (entry) => !entry.dir && !isJunkPath(entry.name),
    );
    for (const entry of entries) {
      const blob = await entry.async("blob");
      out.push({ relativePath: entry.name.replace(/^\/+/, ""), size: blob.size, blob });
    }
  }
  return out;
}

export function siteFiles(files: ReadonlyArray<ProjectUploadFile>): ProjectUploadFile[] {
  return stripSharedTopFolder(files, (file, relativePath) => ({ ...file, relativePath }));
}

/** The name the person would recognise: the dropped folder or zip. */
export function droppedName(files: ReadonlyArray<ProjectUploadFile>): string {
  const first = files[0]?.relativePath ?? "site";
  return first.includes("/") ? first.split("/")[0]! : first.replace(/\.[a-z0-9]+$/i, "");
}

export interface SitePublishResult {
  readonly url: string;
  readonly seconds: number;
  readonly filesCount: number;
}

export class NoIndexHtmlError extends Error {
  constructor() {
    super("There's no index.html in these files.");
    this.name = "NoIndexHtmlError";
  }
}

export async function uploadAndPublishSite(input: {
  readonly environmentId: EnvironmentId;
  readonly projectPath: string;
  readonly files: ReadonlyArray<ProjectUploadFile>;
  readonly name: string;
  readonly onPhase: (phase: "uploading" | "publishing", done?: number, total?: number) => void;
}): Promise<SitePublishResult> {
  const started = performance.now();
  const files = siteFiles(await expandZips(input.files));
  if (!hasIndexHtml(files)) throw new NoIndexHtmlError();
  const api = ensureEnvironmentApi(input.environmentId);
  const target = `${input.projectPath.replace(/\/+$/, "")}/site`;
  input.onPhase("uploading", 0, files.length);
  await uploadFilesIntoDirectory(
    { writeFile: (write) => api.projects.writeFile(write) },
    {
      targetDir: target,
      files,
      filterIgnored: true,
      onProgress: (progress) =>
        input.onPhase("uploading", progress.completedFiles, progress.totalFiles),
    },
  );
  input.onPhase("publishing");
  const result = await api.files.publishSite({ path: target, slug: siteSlugFrom(input.name) });
  return {
    url: result.url,
    filesCount: result.filesCount,
    seconds: Math.round((performance.now() - started) / 100) / 10,
  };
}
