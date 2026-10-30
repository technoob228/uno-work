import type { BranchNamingOptions } from "@t3tools/contracts";

import type { TextGenerationPolicy, TextGenerationPolicyKind } from "./TextGenerationPolicy.ts";

export const defaultTextGenerationPolicy: TextGenerationPolicy = {
  kind: "default",
  inferRepositoryConventions: false,
};

export const conventionalCommitsTextGenerationPolicy: TextGenerationPolicy = {
  kind: "conventional_commits",
  commitInstructions:
    "Use Conventional Commits when generating commit subjects. Prefer the narrowest accurate type and include a scope only when it is obvious from the diff.",
  changeRequestInstructions:
    "Keep the change request title concise. Do not force Conventional Commit syntax into the title unless the repository already uses it.",
  inferRepositoryConventions: false,
};

export const repositoryConventionsTextGenerationPolicy: TextGenerationPolicy = {
  kind: "repo_conventions",
  commitInstructions:
    "Follow the repository's established commit message style when examples are available.",
  changeRequestInstructions:
    "Follow the repository's established change request title and body style when examples are available.",
  inferRepositoryConventions: true,
};

export const customTextGenerationPolicy = (
  overrides: Omit<Partial<TextGenerationPolicy>, "kind">,
): TextGenerationPolicy => ({
  kind: "custom",
  inferRepositoryConventions: false,
  ...overrides,
});

export const textGenerationPresets: Record<
  Exclude<TextGenerationPolicyKind, "custom">,
  TextGenerationPolicy
> = {
  default: defaultTextGenerationPolicy,
  conventional_commits: conventionalCommitsTextGenerationPolicy,
  repo_conventions: repositoryConventionsTextGenerationPolicy,
};

/** What the branch prompt adds for Settings → Worktrees → Branches. */
export const branchNamingPolicy = (naming: BranchNamingOptions): TextGenerationPolicy => {
  switch (naming.mode) {
    case "static":
      return defaultTextGenerationPolicy;
    case "semantic":
      return customTextGenerationPolicy({
        branchInstructions:
          "Start with a prefix that describes the kind of work, such as feat/add-search, fix/login-timeout or refactor/auth.",
      });
    case "custom":
      return customTextGenerationPolicy({
        branchInstructions: `${naming.instructions}\n\nReturn the complete branch name.`.trim(),
      });
  }
};
