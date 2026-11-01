/**
 * "Connect my computer", the chat import: what this tab is showing. Which
 * programs the person unticked, and which computer's import the corner card
 * follows. What's true about the import lives on the daemon (`useChatImport.ts`).
 */
import type { ImportedChatTool } from "@t3tools/contracts";
import { create } from "zustand";

interface ImportFlowState {
  /** Programs unticked in the offer; everything is ticked until the person says. */
  readonly unticked: ReadonlySet<ImportedChatTool>;
  /** The computer whose import the corner card shows. */
  readonly followingId: string | null;
}

export const useImportFlow = create<ImportFlowState>(() => ({
  unticked: new Set(),
  followingId: null,
}));

export const importFlow = {
  toggleTool: (tool: ImportedChatTool) =>
    useImportFlow.setState(({ unticked }) => {
      const next = new Set(unticked);
      if (!next.delete(tool)) next.add(tool);
      return { unticked: next };
    }),
  follow: (computerId: string) => useImportFlow.setState({ followingId: computerId }),
  dismiss: () => useImportFlow.setState({ followingId: null, unticked: new Set() }),
};
