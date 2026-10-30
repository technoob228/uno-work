import { Suspense, useState } from "react";
import { createPortal } from "react-dom";

import { MermaidDiagram } from "../chat/MermaidDiagram";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";

export default function MermaidViewer(props: { readonly text: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  // A diagram lays out DOM before its SVG is sanitized. Refuse resource and
  // config syntax before that pass so a file cannot start requests. Node
  // metadata is YAML, whose escaped or aliased image keys can't be checked here.
  if (
    /%%\s*\{|^\s*---|<\/?[A-Za-z]|<[!?]|@\s*\{|\b(?:img|image)\s*:|url\s*\(|@import|(?:https?|data|blob|file):/im.test(
      props.text,
    )
  )
    return (
      <div role="alert" className="p-6 text-xs text-muted-foreground">
        This diagram has links, markup or its own settings, so it isn't drawn. Show the source to
        read it.
      </div>
    );
  return (
    <div className="h-full min-h-0 flex-1 overflow-auto p-6 [&_*]:animate-none!">
      <Suspense fallback={null}>
        <MermaidDiagram source={props.text} onExpand={setExpanded} />
      </Suspense>
      {expanded
        ? createPortal(
            <ExpandedImageDialog
              preview={{ images: [{ src: expanded, name: "Diagram" }], index: 0 }}
              onClose={() => setExpanded(null)}
            />,
            document.body,
          )
        : null}
    </div>
  );
}
