import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";

import { resolveDiffThemeName } from "./diffRendering";

const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

export function getCodeHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    highlighterPromiseCache.delete(language);
    if (language === "text") {
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw err;
    }
    // Language not supported by Shiki — fall back to "text"
    return getCodeHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

// Special files without a meaningful extension
const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: "docker",
  makefile: "make",
  gnumakefile: "make",
  "cmakelists.txt": "cmake",
  ".gitignore": "ini",
  ".gitattributes": "ini",
  ".editorconfig": "ini",
  ".npmrc": "ini",
};

// Extensions whose Shiki language id differs from the extension itself.
// Anything not listed is passed through as-is — Shiki aliases cover most
// cases (py, rb, rs, kt, cs, sh, …) and unsupported ids fall back to "text".
const EXT_LANGUAGE_OVERRIDES: Record<string, string> = {
  h: "c",
  hpp: "cpp",
  hxx: "cpp",
  cc: "cpp",
  cxx: "cpp",
  mjs: "js",
  cjs: "js",
  mts: "ts",
  cts: "ts",
  yml: "yaml",
  htm: "html",
  markdown: "md",
  svg: "xml",
  plist: "xml",
  gql: "graphql",
  gitignore: "ini",
  env: "ini",
  cfg: "ini",
  conf: "ini",
  ini: "ini",
  properties: "ini",
  txt: "text",
  log: "text",
  lock: "text",
};

export function shikiLanguageForFileName(name: string): string {
  const base = (name.toLowerCase().split(/[\\/]/).pop() ?? "").trim();
  if (!base) return "text";
  const named = FILENAME_LANGUAGES[base];
  if (named) return named;
  if (base.startsWith(".env")) return "ini";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "text";
  const ext = base.slice(dot + 1);
  if (!ext) return "text";
  return EXT_LANGUAGE_OVERRIDES[ext] ?? ext;
}
