/**
 * Text-like files: markdown reads as a document, text and code with syntax
 * colours; all of them (plus web pages) edit in the browser with ⌘S / Ctrl+S.
 * Markdown edits as the document it reads as, or — the person's switch — as
 * code with a live preview next to it; HTML as source with a live preview.
 */
import { CodeIcon, ColumnsIcon, FileTextIcon, Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "../../../lib/utils";
import { CodeFileView } from "../../preview/CodeFileView";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import type { FileEditorProps, FileOpener, FileViewProps } from "../fileOpeners";
import { useFileText } from "../fileSource";
import { Paper, ViewerLoading, ViewerMessage, viewerErrorText } from "./common";
import {
  MarkdownDocumentEditor,
  type MarkdownDocumentEditorHandle,
} from "./MarkdownDocumentEditor";
import {
  MARKDOWN_EDIT_MODE_KEY,
  type MarkdownEditMode,
  parseMarkdownEditMode,
} from "./markdownDocumentEdit";

const TEXT_MAX_BYTES = 10 * 1024 * 1024;

const markdownComponents: Components = {
  a({ href, children, ...rest }) {
    const external = !!href && /^[a-z][a-z0-9+.-]*:/i.test(href);
    return (
      <a href={href} {...rest} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
        {children}
      </a>
    );
  },
};

export function MarkdownDocument({ markdown }: { markdown: string }) {
  return (
    <div className="preview-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownView({ source }: FileViewProps) {
  const { data, error, isPending } = useFileText(source);
  if (isPending) return <ViewerLoading />;
  if (error) {
    return (
      <ViewerMessage kind="markdown" title="Couldn't open this file" tone="error">
        {viewerErrorText(error)}
      </ViewerMessage>
    );
  }
  return (
    <div className="h-full overflow-y-auto bg-muted/30">
      <Paper>
        {data.trim().length === 0 ? (
          <p className="text-muted-foreground">This document is empty. Press Edit to write.</p>
        ) : (
          <MarkdownDocument markdown={data} />
        )}
      </Paper>
    </div>
  );
}

function TextView({ source }: FileViewProps) {
  const { data, error, isPending } = useFileText(source);
  if (isPending) return <ViewerLoading />;
  if (error) {
    return (
      <ViewerMessage kind={source.kind} title="Couldn't open this file" tone="error">
        {viewerErrorText(error)}
      </ViewerMessage>
    );
  }
  if (source.kind === "text") {
    return (
      <div className="h-full overflow-y-auto bg-muted/30">
        <Paper>
          <pre className="font-sans text-[15px] leading-relaxed whitespace-pre-wrap break-words text-foreground">
            {data || "This file is empty."}
          </pre>
        </Paper>
      </div>
    );
  }
  return (
    <div className="h-full min-h-0">
      <CodeFileView fileId={`files:${source.path}`} fileName={source.name} content={data} />
    </div>
  );
}

function readMarkdownEditMode(): MarkdownEditMode {
  try {
    return parseMarkdownEditMode(window.localStorage.getItem(MARKDOWN_EDIT_MODE_KEY));
  } catch {
    return "document";
  }
}

function TextEditor({ source, onClose, onDirtyChange }: FileEditorProps) {
  // The shell may keep this editor open after a save (Files → Tree edits in
  // place): the text loaded before stays on screen while the saved version loads.
  const { data, error, isPending } = useFileText(source, { keepPrevious: true });
  const [draft, setDraft] = useState<string | null>(null);
  // What was just saved, until the file is read back: the draft is clean against it.
  const [savedText, setSavedText] = useState<string | null>(null);
  useEffect(() => setSavedText(null), [data]);
  // The document view is typed into directly: it is rendered once from the
  // text first loaded and must not be re-rendered under the person's caret
  // when the file is read back after a save.
  const [loadedText, setLoadedText] = useState<string | null>(null);
  if (loadedText === null && data !== undefined) setLoadedText(data);
  const [saving, setSaving] = useState(false);
  const withPreview = source.kind === "markdown" || source.kind === "html";
  const [showPreview, setShowPreview] = useState(withPreview);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Markdown: the document itself by default, its code when the person switched to it.
  const isMarkdown = source.kind === "markdown";
  const [markdownMode, setMarkdownMode] = useState<MarkdownEditMode>(readMarkdownEditMode);
  const asDocument = isMarkdown && markdownMode === "document";
  // What the document view is rendered from: the file, or the code as it stood at the switch.
  const [documentBase, setDocumentBase] = useState<{ markdown: string; version: number } | null>(
    null,
  );
  const documentRef = useRef<MarkdownDocumentEditorHandle | null>(null);

  const value = draft ?? data ?? "";
  const dirty = draft !== null && draft !== (savedText ?? data);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const save = useCallback(async () => {
    // ⌘S with nothing to save does nothing (it used to close the editor).
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await source.save(value);
      setSavedText(value);
      toastManager.add({ type: "success", title: "Saved", description: source.name });
      onDirtyChange(false);
      onClose(true);
    } catch (saveError) {
      toastManager.add({
        type: "error",
        title: "Couldn't save",
        description: viewerErrorText(saveError),
      });
    } finally {
      setSaving(false);
    }
  }, [dirty, onClose, onDirtyChange, saving, source, value]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  useEffect(() => {
    if (!isPending) textareaRef.current?.focus();
  }, [isPending]);

  const switchMarkdownMode = (mode: MarkdownEditMode) => {
    if (mode === markdownMode) return;
    // The draft is always the markdown as it stands; the document re-renders from it.
    if (mode === "document") {
      setDocumentBase((current) => ({ markdown: value, version: (current?.version ?? 0) + 1 }));
    }
    setMarkdownMode(mode);
    try {
      window.localStorage.setItem(MARKDOWN_EDIT_MODE_KEY, mode);
    } catch {
      // Storage is off: the choice holds for this editor only.
    }
  };

  const preview = useMemo(() => {
    if (!showPreview) return null;
    if (source.kind === "markdown") {
      return (
        <div className="h-full overflow-y-auto bg-muted/30">
          <Paper>
            <MarkdownDocument markdown={value} />
          </Paper>
        </div>
      );
    }
    return (
      <iframe
        title="Preview"
        srcDoc={value}
        sandbox="allow-scripts"
        className="h-full w-full border-0 bg-white"
      />
    );
  }, [showPreview, source.kind, value]);

  if (isPending) return <ViewerLoading />;
  if (error) {
    return (
      <ViewerMessage kind={source.kind} title="Couldn't open this file" tone="error">
        {viewerErrorText(error)}
      </ViewerMessage>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn("size-1.5 rounded-full", dirty ? "bg-warning" : "bg-success")}
            aria-hidden
          />
          {dirty ? "Unsaved changes" : "All changes saved"}
          <span className="hidden sm:inline">· ⌘S to save</span>
        </span>
        <span className="flex-1" />
        {isMarkdown ? (
          <span className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
            <Button
              size="xs"
              variant={asDocument ? "secondary" : "ghost"}
              aria-pressed={asDocument}
              onClick={() => switchMarkdownMode("document")}
              data-testid="markdown-edit-mode-document"
            >
              <FileTextIcon />
              Document
            </Button>
            <Button
              size="xs"
              variant={asDocument ? "ghost" : "secondary"}
              aria-pressed={!asDocument}
              onClick={() => switchMarkdownMode("code")}
              data-testid="markdown-edit-mode-code"
            >
              <CodeIcon />
              Code
            </Button>
          </span>
        ) : null}
        {withPreview && !asDocument ? (
          <Button
            size="sm"
            variant={showPreview ? "secondary" : "ghost"}
            onClick={() => setShowPreview((current) => !current)}
          >
            <ColumnsIcon />
            Preview
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => onClose(false)} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? <Loader2Icon className="animate-spin" /> : null}
          Save
        </Button>
      </div>
      {asDocument ? (
        <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30">
          <Paper>
            <MarkdownDocumentEditor
              key={documentBase?.version ?? 0}
              ref={documentRef}
              markdown={documentBase?.markdown ?? loadedText ?? data ?? ""}
              onInput={() => setDraft(documentRef.current?.read() ?? value)}
              label={`Contents of ${source.name}`}
              autoFocus
            />
          </Paper>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={source.kind === "markdown" || source.kind === "text"}
            aria-label={`Contents of ${source.name}`}
            className={cn(
              "h-full min-w-0 flex-1 resize-none border-0 bg-background p-4 text-[13px] leading-relaxed text-foreground outline-none",
              source.kind === "text" || source.kind === "markdown"
                ? "font-sans text-[15px]"
                : "font-mono",
              showPreview && preview ? "border-r border-border" : "",
            )}
          />
          {showPreview && preview ? (
            <div className="hidden min-w-0 flex-1 md:block">{preview}</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export const textOpeners: ReadonlyArray<FileOpener> = [
  {
    id: "builtin.markdown",
    label: "Document",
    match: (file) => (file.kind === "markdown" ? 10 : 0),
    View: MarkdownView,
    Editor: TextEditor,
    editLabel: "Edit",
    maxBytes: TEXT_MAX_BYTES,
  },
  {
    id: "builtin.text",
    label: "Text",
    match: (file) => (file.kind === "text" || file.kind === "code" ? 10 : 0),
    View: TextView,
    Editor: TextEditor,
    editLabel: "Edit",
    maxBytes: TEXT_MAX_BYTES,
  },
];

/** HTML edits as source with a live preview; viewing stays in mediaOpeners. */
export const htmlEditor = TextEditor;
