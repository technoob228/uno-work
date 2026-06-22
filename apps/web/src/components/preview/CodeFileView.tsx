import React, { Suspense, use, useMemo, type ReactNode } from "react";

import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName, type DiffThemeName } from "../../lib/diffRendering";
import { getCodeHighlighterPromise, shikiLanguageForFileName } from "../../lib/codeHighlighter";
import { MemoizedScrollArea } from "./previewScrollArea";

// Подсветка очень больших файлов блокирует main thread — выше порога показываем plain text.
const MAX_HIGHLIGHT_CHARS = 1_000_000;
const MAX_HIGHLIGHT_LINES = 20_000;

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

function PlainCode({ content }: { content: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed">
      {content}
    </pre>
  );
}

function HighlightedCode({
  content,
  language,
  themeName,
}: {
  content: string;
  language: string;
  themeName: DiffThemeName;
}) {
  const highlighter = use(getCodeHighlighterPromise(language));
  const html = useMemo(() => {
    try {
      return highlighter.codeToHtml(content, { lang: language, theme: themeName });
    } catch (error) {
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      return highlighter.codeToHtml(content, { lang: "text", theme: themeName });
    }
  }, [content, highlighter, language, themeName]);
  return <div className="preview-code-shiki" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function CodeFileView({
  fileId,
  fileName,
  content,
  language,
}: {
  fileId: string;
  fileName: string;
  content: string;
  language?: string | undefined;
}) {
  const { resolvedTheme } = useTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);
  const resolvedLanguage = language ?? shikiLanguageForFileName(fileName);
  const tooLarge = useMemo(() => {
    if (content.length > MAX_HIGHLIGHT_CHARS) return true;
    let lines = 1;
    for (let i = 0; i < content.length; i += 1) {
      if (content.charCodeAt(i) === 10) {
        lines += 1;
        if (lines > MAX_HIGHLIGHT_LINES) return true;
      }
    }
    return false;
  }, [content]);
  const plain = resolvedLanguage === "text" || tooLarge;

  return (
    <MemoizedScrollArea fileId={fileId} className="h-full">
      {plain ? (
        <PlainCode content={content} />
      ) : (
        <CodeHighlightErrorBoundary fallback={<PlainCode content={content} />}>
          <Suspense fallback={<PlainCode content={content} />}>
            <HighlightedCode content={content} language={resolvedLanguage} themeName={themeName} />
          </Suspense>
        </CodeHighlightErrorBoundary>
      )}
    </MemoizedScrollArea>
  );
}
