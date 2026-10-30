/**
 * A ```mermaid block of an answer or a document: the diagram, with its code a
 * click away. While the answer streams it stays code: half a diagram can't be
 * drawn. Whatever goes wrong, the reader gets the code.
 */
import { CodeIcon, WorkflowIcon } from "lucide-react";
import { Component, Suspense, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "../../lib/utils";
import { ExpandedImageDialog } from "./ExpandedImageDialog";
import { MermaidDiagram } from "./MermaidDiagram";

/** A renderer that throws leaves the code on screen; a new `key` tries again. */
class DiagramBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function MarkdownMermaidCodeBlock({
  code,
  isStreaming,
  className,
  children,
}: {
  code: string;
  isStreaming: boolean;
  /** Where the toggle sits: next to the block's copy button, or in the corner. */
  className?: string;
  /** The highlighted code. */
  children: ReactNode;
}) {
  const [showCode, setShowCode] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const showDiagram = !showCode && !isStreaming && code.trim().length > 0;
  const label = showCode ? "Show diagram" : "Show code";
  return (
    <>
      {isStreaming ? null : (
        <button
          type="button"
          className={cn("chat-markdown-copy-button", className)}
          onClick={() => setShowCode((value) => !value)}
          title={label}
          aria-label={label}
        >
          {showCode ? <WorkflowIcon className="size-3" /> : <CodeIcon className="size-3" />}
        </button>
      )}
      {showDiagram ? (
        <DiagramBoundary key={code} fallback={children}>
          <Suspense
            fallback={
              <pre className="invisible" aria-hidden>
                {code}
              </pre>
            }
          >
            <MermaidDiagram source={code} onExpand={setExpanded} />
          </Suspense>
        </DiagramBoundary>
      ) : (
        children
      )}
      {expanded
        ? createPortal(
            <ExpandedImageDialog
              preview={{ images: [{ src: expanded, name: "Diagram" }], index: 0 }}
              onClose={() => setExpanded(null)}
            />,
            document.body,
          )
        : null}
    </>
  );
}
