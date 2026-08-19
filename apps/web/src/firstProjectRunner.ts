/**
 * Executes the three browser-onboarding paths (clone / upload / tutorial)
 * against an environment API. Dependencies are passed in so the flow can be
 * tested without a live backend.
 */

import {
  TUTORIAL_FILES,
  TUTORIAL_PROJECT_NAME,
  expandGitRemoteUrl,
  inferProjectNameFromGitUrl,
  joinWorkspacePath,
  normalizeProjectName,
  planUpload,
  stripUploadRootSegment,
  type UploadPlan,
} from "./firstProject";

export interface FirstProjectFile {
  /** Path as reported by the file picker, including the dropped root folder. */
  readonly rootRelativePath: string;
  readonly size: number;
  /** Base64 contents, read lazily so skipped files are never loaded. */
  readBase64: () => Promise<string>;
}

export interface FirstProjectRunnerDeps {
  readonly cloneRepository: (input: {
    remoteUrl: string;
    destinationPath: string;
  }) => Promise<{ cwd: string }>;
  readonly writeFile: (input: {
    cwd: string;
    relativePath: string;
    contents: string;
    encoding?: "utf8" | "base64";
  }) => Promise<unknown>;
  readonly createProject: (input: { cwd: string; title: string }) => Promise<void>;
  readonly onProgress?: (progress: { completed: number; total: number }) => void;
}

export interface FirstProjectResult {
  readonly cwd: string;
  readonly title: string;
  readonly uploadPlan?: UploadPlan;
}

export async function runCloneFirstProject(
  deps: FirstProjectRunnerDeps,
  input: { remoteUrl: string; baseDirectory: string },
): Promise<FirstProjectResult> {
  const remoteUrl = expandGitRemoteUrl(input.remoteUrl);
  const title = inferProjectNameFromGitUrl(remoteUrl);
  const destinationPath = joinWorkspacePath(input.baseDirectory, title);

  const result = await deps.cloneRepository({ remoteUrl, destinationPath });
  const cwd = result.cwd.trim().length > 0 ? result.cwd : destinationPath;
  await deps.createProject({ cwd, title });
  return { cwd, title };
}

export async function runUploadFirstProject(
  deps: FirstProjectRunnerDeps,
  input: {
    files: ReadonlyArray<FirstProjectFile>;
    baseDirectory: string;
    projectName: string;
  },
): Promise<FirstProjectResult> {
  const title = normalizeProjectName(input.projectName) || "uploaded-files";
  const cwd = joinWorkspacePath(input.baseDirectory, title);

  const byRelativePath = new Map<string, FirstProjectFile>();
  for (const file of input.files) {
    byRelativePath.set(stripUploadRootSegment(file.rootRelativePath), file);
  }

  const plan = planUpload(
    input.files.map((file) => ({
      relativePath: stripUploadRootSegment(file.rootRelativePath),
      size: file.size,
    })),
  );

  // The project is created first so the workspace root exists even when every
  // file turns out to be skipped.
  await deps.createProject({ cwd, title });

  let completed = 0;
  for (const entry of plan.accepted) {
    const file = byRelativePath.get(entry.relativePath);
    if (!file) continue;
    const contents = await file.readBase64();
    await deps.writeFile({
      cwd,
      relativePath: entry.relativePath,
      contents,
      encoding: "base64",
    });
    completed += 1;
    deps.onProgress?.({ completed, total: plan.accepted.length });
  }

  return { cwd, title, uploadPlan: plan };
}

export async function runTutorialFirstProject(
  deps: FirstProjectRunnerDeps,
  input: { baseDirectory: string },
): Promise<FirstProjectResult> {
  const title = TUTORIAL_PROJECT_NAME;
  const cwd = joinWorkspacePath(input.baseDirectory, title);

  await deps.createProject({ cwd, title });

  let completed = 0;
  for (const file of TUTORIAL_FILES) {
    await deps.writeFile({
      cwd,
      relativePath: file.relativePath,
      contents: file.contents,
      encoding: "utf8",
    });
    completed += 1;
    deps.onProgress?.({ completed, total: TUTORIAL_FILES.length });
  }

  return { cwd, title };
}
