import { CheckIcon, CopyIcon } from "lucide-react";
import React, {
  Suspense,
  createContext,
  use,
  useCallback,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { EnvironmentId } from "@t3tools/contracts";
import { fileLinkParentSuffixes } from "./chat/fileLinkLabel";
import { FileMention, FileMentionContext } from "./chat/MarkdownFileLink";
import { extractCodeBlock } from "./chat/markdownCodeBlock";
import { MarkdownMermaidCodeBlock } from "./chat/MarkdownMermaidCodeBlock";
import { remarkFileMentions } from "./chat/remarkFileMentions";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { fnv1a32 } from "../lib/diffRendering";
import { getCodeHighlighterPromise } from "../lib/codeHighlighter";
import { LRUCache } from "../lib/lruCache";
import { useTheme } from "../hooks/useTheme";
import { fileMentionInHref, type FileMention as FileMentionValue } from "../fileMentions";
import { resolveMarkdownFileLinkTarget, rewriteMarkdownFileUriHref } from "../markdown-links";
import { chatLinkTarget, openUntrustedLinkExternally } from "../lib/externalLinks";
import { usePreviewPane } from "./preview/PreviewPaneContext";

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

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean;
  environmentId?: EnvironmentId | undefined;
}

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;
const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = match?.[1] ?? "text";
  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685)
  return raw === "gitignore" ? "ini" : raw;
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function MarkdownCodeBlock({ code, children }: { code: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  }, [code]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div className="chat-markdown-codeblock leading-snug">
      <button
        type="button"
        className="chat-markdown-copy-button"
        onClick={handleCopy}
        title={copied ? "Copied" : "Copy code"}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
      {children}
    </div>
  );
}

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

function SuspenseShikiCodeBlock({
  className,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = !isStreaming ? highlightedCodeCache.get(cacheKey) : null;

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  return (
    <UncachedShikiCodeBlock
      code={code}
      language={language}
      themeName={themeName}
      cacheKey={cacheKey}
      isStreaming={isStreaming}
    />
  );
}

interface UncachedShikiCodeBlockProps {
  code: string;
  language: string;
  themeName: DiffThemeName;
  cacheKey: string;
  isStreaming: boolean;
}

function UncachedShikiCodeBlock({
  code,
  language,
  themeName,
  cacheKey,
  isStreaming,
}: UncachedShikiCodeBlockProps) {
  const highlighter = use(getCodeHighlighterPromise(language));
  const highlightedHtml = useMemo(() => {
    try {
      return highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch (error) {
      // Log highlighting failures for debugging while falling back to plain text
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      // If highlighting fails for this language, render as plain text
      return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  }, [code, highlighter, language, themeName]);

  useEffect(() => {
    if (!isStreaming) {
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, code),
      );
    }
  }, [cacheKey, code, highlightedHtml, isStreaming]);

  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  );
}

const MARKDOWN_LINK_HREF_PATTERN = /\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const MARKDOWN_SAFE_IMAGE_DATA_URL_REGEX =
  /^data:image\/(?:png|jpeg|jpg|webp|gif|avif|bmp);base64,[a-z0-9+/=\r\n ]+$/i;

function extractMarkdownLinkHrefs(text: string): string[] {
  const hrefs: string[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    const href = match[1]?.trim();
    if (!href) continue;
    hrefs.push(href);
  }
  return hrefs;
}

function normalizeMarkdownLinkHrefKey(href: string): string {
  return rewriteMarkdownFileUriHref(href.trim()) ?? href.trim();
}

/**
 * A chat holding text from outside Uno (a form, a webhook): an image address
 * written by an agent that text steered would carry data out the moment the
 * chat opens. There a remote image stays a link.
 */
export const RemoteImagesOffContext = createContext(false);

function isSafeMarkdownImageSrc(src: string | undefined): src is string {
  if (!src) return false;
  return MARKDOWN_SAFE_IMAGE_DATA_URL_REGEX.test(src) || /^https?:\/\//i.test(src);
}

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkFileMentions];

function fileMentionBasename(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

function ChatMarkdown({ text, cwd, isStreaming = false, environmentId }: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
  const { openUrl } = usePreviewPane();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  // Links the agent wrote itself to a file: `[report](reports/q3.md)`, `file://…`.
  const fileLinkByHref = useMemo(() => {
    const byHref = new Map<string, FileMentionValue>();
    for (const href of extractMarkdownLinkHrefs(text)) {
      const normalizedHref = normalizeMarkdownLinkHrefKey(href);
      if (byHref.has(normalizedHref)) continue;
      // An address with no file look (`/pricing`) stays a link.
      if (!resolveMarkdownFileLinkTarget(normalizedHref, cwd ?? "/")) continue;
      const mention = fileMentionInHref(normalizedHref);
      if (mention) byHref.set(normalizedHref, mention);
    }
    return byHref;
  }, [cwd, text]);
  const fileLinkParentSuffixByPath = useMemo(
    () => fileLinkParentSuffixes([...fileLinkByHref.values()].map((mention) => mention.path)),
    [fileLinkByHref],
  );
  const fileMentionContext = useMemo(
    () => ({ environmentId, cwd, isStreaming, theme: resolvedTheme }),
    [cwd, environmentId, isStreaming, resolvedTheme],
  );
  const markdownUrlTransform = useCallback((href: string) => {
    if (MARKDOWN_SAFE_IMAGE_DATA_URL_REGEX.test(href)) {
      return href;
    }
    return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
  }, []);
  const remoteImagesOff = use(RemoteImagesOffContext);
  const markdownComponents = useMemo<Components>(
    () => ({
      img({ node: _node, src, alt }) {
        if (!isSafeMarkdownImageSrc(src)) {
          return alt ? <span>{alt}</span> : null;
        }
        if (remoteImagesOff && /^https?:/i.test(src)) {
          return (
            <a href={src} target="_blank" rel="noopener noreferrer">
              {alt || "Image"}
            </a>
          );
        }
        return (
          <img
            src={src}
            alt={alt ?? ""}
            loading="lazy"
            className="my-3 max-h-[640px] max-w-full rounded-lg border border-border bg-muted/20 object-contain shadow-sm"
          />
        );
      },
      a({ node: _node, href, ...props }) {
        const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
        const fileLink = normalizedHref ? fileLinkByHref.get(normalizedHref) : null;
        if (!fileLink) {
          const linkTarget = chatLinkTarget(href);
          return (
            <a
              {...props}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                props.onClick?.(event);
                if (
                  event.defaultPrevented ||
                  !linkTarget ||
                  !href ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey ||
                  event.button !== 0
                ) {
                  return;
                }
                event.preventDefault();
                // Own site / app / preview — the right panel at once; the
                // console and the rest of the web — a new tab (system browser
                // on desktop). Rule of 07.10 (flows v2, section 1).
                if (linkTarget === "own") openUrl(href);
                else openUntrustedLinkExternally(href);
              }}
            />
          );
        }

        const parentSuffix = fileLinkParentSuffixByPath.get(fileLink.path);
        const name = fileMentionBasename(fileLink.path);
        return (
          <FileMention
            path={fileLink.path}
            {...(fileLink.line !== undefined ? { line: String(fileLink.line) } : {})}
            {...(fileLink.column !== undefined ? { column: String(fileLink.column) } : {})}
            strong="true"
            link
            label={parentSuffix ? `${name} · ${parentSuffix}` : name}
            {...(props.className ? { className: props.className } : {})}
          >
            {props.children}
          </FileMention>
        );
      },
      // Not in `Components`: the element remarkFileMentions adds.
      ...({
        "file-mention": ({
          node: _node,
          ...props
        }: { node?: unknown } & Record<string, string>) => <FileMention {...props} />,
      } as unknown as Components),
      pre({ node: _node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }

        const highlighted = (
          <CodeHighlightErrorBoundary fallback={<pre {...props}>{children}</pre>}>
            {/* Reserve the block's height but stay hidden until Shiki has
                  coloured it, so plain text never flashes before the
                  highlighted version (upstream c07575f573). */}
            <Suspense
              fallback={
                <pre {...props} className="invisible" aria-hidden>
                  {children}
                </pre>
              }
            >
              <SuspenseShikiCodeBlock
                className={codeBlock.className}
                code={codeBlock.code}
                themeName={diffThemeName}
                isStreaming={isStreaming}
              />
            </Suspense>
          </CodeHighlightErrorBoundary>
        );
        return (
          <MarkdownCodeBlock code={codeBlock.code}>
            {extractFenceLanguage(codeBlock.className) === "mermaid" ? (
              <MarkdownMermaidCodeBlock
                code={codeBlock.code}
                isStreaming={isStreaming}
                className="right-9"
              >
                {highlighted}
              </MarkdownMermaidCodeBlock>
            ) : (
              highlighted
            )}
          </MarkdownCodeBlock>
        );
      },
    }),
    [
      diffThemeName,
      fileLinkByHref,
      fileLinkParentSuffixByPath,
      isStreaming,
      openUrl,
      remoteImagesOff,
    ],
  );

  return (
    <div
      className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/90"
      // Gates the fade-in of blocks that arrive while the answer streams.
      data-streaming={isStreaming ? "" : undefined}
    >
      <FileMentionContext.Provider value={fileMentionContext}>
        <ReactMarkdown
          remarkPlugins={MARKDOWN_REMARK_PLUGINS}
          components={markdownComponents}
          urlTransform={markdownUrlTransform}
        >
          {text}
        </ReactMarkdown>
      </FileMentionContext.Provider>
    </div>
  );
}

export default memo(ChatMarkdown);
