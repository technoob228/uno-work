import { useCallback, useEffect, useState } from "react";
import type { AssistantEditableFileName, EnvironmentId } from "@t3tools/contracts";

import { readAssistantFile, writeAssistantFile } from "../../lib/managerApi";
import { Button } from "../ui/button";

/**
 * Editor for one of the assistant's workspace files (AGENTS.md, NOTES.md,
 * ROUTING.md) read and written through the manager file route. `showName`
 * hides the raw file name on owner-facing surfaces that already explain what
 * the text is for.
 */
export function FileEditor({
  environmentId,
  projectId,
  name,
  readOnly,
  onError,
  showName = true,
}: {
  environmentId: EnvironmentId;
  projectId: string;
  name: AssistantEditableFileName;
  readOnly: boolean;
  onError: (message: string) => void;
  showName?: boolean;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setContent(null);
    setDirty(false);
    void readAssistantFile({ environmentId, projectId, name })
      .then((result) => setContent(result.content))
      .catch(() => onError(`Failed to read ${name}.`));
  }, [environmentId, projectId, name, onError]);

  const save = useCallback(() => {
    if (content === null) return;
    void writeAssistantFile({ environmentId, projectId, name, content })
      .then(() => setDirty(false))
      .catch(() => onError(`Failed to save ${name}.`));
  }, [environmentId, projectId, name, content, onError]);

  return (
    <div className="space-y-2 pb-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-muted-foreground">{showName ? name : ""}</span>
        <Button size="xs" variant="outline" disabled={!dirty || readOnly} onClick={save}>
          {dirty ? "Save" : "Saved"}
        </Button>
      </div>
      <textarea
        value={content ?? "Loading…"}
        disabled={content === null || readOnly}
        onChange={(event) => {
          setContent(event.target.value);
          setDirty(true);
        }}
        spellCheck={false}
        aria-label={name}
        className="h-48 w-full resize-y rounded-lg border border-border bg-background p-3 font-mono text-[11px] leading-relaxed"
      />
    </div>
  );
}
