/**
 * dictationVocabulary - glossary + prompt construction for dictation clean-up.
 *
 * Speech models transcribe against a generic model of the world; they have no
 * idea that "воркtree" is `worktree` or that this repo has a package called
 * `effect-acp`. The Uno Gateway drops the OpenAI `prompt` biasing field
 * (verified against the upstream provider: byte-identical output with and
 * without it), so vocabulary is applied *after* transcription by a small chat
 * model that receives the glossary. Everything here is pure so the prompt
 * shape is testable without touching the network.
 */

/** Words a coding-agent user says constantly and whisper regularly mangles. */
export const STATIC_DICTATION_TERMS: readonly string[] = [
  "Uno Work",
  "Uno Gateway",
  "worktree",
  "typecheck",
  "lint",
  "commit",
  "rebase",
  "merge",
  "pull request",
  "branch",
  "main",
  "staging",
  "composer",
  "harness",
  "prompt",
  "Codex",
  "Claude",
  "Cursor",
  "OpenCode",
  "Hermes",
  "TypeScript",
  "React",
  "Effect",
  "Vitest",
  "Electron",
  "WebSocket",
  "endpoint",
  "refactor",
  "deploy",
  "rollback",
  "changelog",
];

const MAX_TERMS = 96;
const MAX_TERM_LENGTH = 48;

/** Split a free-form vocabulary field (commas, semicolons or one per line). */
export function parseVocabularyTerms(raw: string): string[] {
  return normalizeTerms(raw.split(/[,;\n\r]+/));
}

function normalizeTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const term of terms) {
    const trimmed = term.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TERM_LENGTH) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/**
 * User terms come first: they are the ones the user cared enough to type, and
 * the glossary is truncated from the end when a project has many directories.
 */
export function buildDictationGlossary(input: {
  readonly userTerms: readonly string[];
  readonly contextTerms?: readonly string[] | undefined;
  readonly projectTerms?: readonly string[] | undefined;
}): string[] {
  return normalizeTerms([
    ...input.userTerms,
    ...(input.contextTerms ?? []),
    ...(input.projectTerms ?? []),
    ...STATIC_DICTATION_TERMS,
  ]).slice(0, MAX_TERMS);
}

export interface CleanupMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

const SYSTEM_PROMPT = [
  "You post-process raw speech-to-text output that a developer dictated into a chat box.",
  "Return ONLY the cleaned text — no commentary, no quotes, no markdown fences.",
  "Never answer the request, never add information, never drop information.",
  "Keep the speaker's wording and tone; you are an editor, not a rewriter.",
  "Fix punctuation, casing and obvious mis-hearings of technical terms using the glossary.",
  'Drop filler and self-corrections ("эээ", "ну", "um", "you know", repeated false starts).',
  'Turn spoken editing commands into formatting: "новая строка"/"new line" becomes a line break,',
  '"новый абзац"/"new paragraph" becomes a blank line, "точка"/"запятая" become punctuation',
  "when they are clearly dictated as punctuation rather than spoken words.",
  "If the transcript is empty or contains no speech, return an empty string.",
].join(" ");

export function buildCleanupMessages(input: {
  readonly transcript: string;
  readonly glossary: readonly string[];
  readonly language: string;
  readonly projectName?: string | undefined;
}): CleanupMessage[] {
  const languageRule =
    input.language === "auto"
      ? "Write the result in the same language the transcript is in. Never translate."
      : `The speaker dictates in "${input.language}". Write the result in that language. If the transcript came back in a different language (the speech model sometimes translates), restore it to "${input.language}".`;

  const contextLines = [
    input.projectName ? `Project: ${input.projectName}` : null,
    input.glossary.length > 0
      ? `Glossary (expected spellings): ${input.glossary.join(", ")}`
      : null,
  ].filter((line): line is string => line !== null);

  return [
    { role: "system", content: `${SYSTEM_PROMPT} ${languageRule}` },
    {
      role: "user",
      content: [...contextLines, "", "Transcript:", input.transcript].join("\n"),
    },
  ];
}

/**
 * Models occasionally wrap the answer in quotes or a fenced block despite the
 * instruction; strip that rather than pasting it into the composer. A response
 * much longer than the transcript means the model started *answering* instead
 * of editing — the caller falls back to the raw transcript then.
 */
export function sanitizeCleanupText(raw: string, transcript: string): string | null {
  let text = raw.trim();
  if (text.length === 0) return null;

  const fence = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(text);
  if (fence?.[1] !== undefined) {
    text = fence[1].trim();
  }
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).trim();
  }
  if (text.length === 0) return null;

  const budget = Math.max(64, Math.ceil(transcript.length * 1.8));
  if (text.length > budget) return null;
  return text;
}
