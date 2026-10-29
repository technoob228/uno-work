/**
 * The question over a new chat's centred composer (upstream T3 Code's
 * `DraftHeroHeadline`, #4055): "What should we do in [Home folder ▾] on
 * [This Mac ▾]?". Both are real pickers, the first thing a new chat asks:
 *
 * - the folder — the chat moves there with what was typed (the folder chip
 *   used to sit in the header, easy to miss);
 * - the computer — a new chat in that computer's home folder, with the words
 *   carried over. In the browser on a Work address a computer that runs
 *   another Uno Work version opens in its own interface (a page load, as the
 *   computer menu does).
 *
 * `DraftHeroStarters` — a few hints under the box, Home's own (made from the
 * work this person did here): a click only types them in.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { memo, useMemo } from "react";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { useChatOnComputer, useFolderChats, useHomeFolderPath } from "../../hooks/useFolderChats";
import { useSwitchEnvironment } from "../../hooks/useSwitchEnvironment";
import { normalizeProjectPathForComparison } from "../../lib/projectPaths";
import { currentStaleBundlePage, switchReloadUrl } from "../../staleBundle";
import { readStaleBundleMachine } from "../../staleBundleMachine";
import { useHomeStarters } from "../computer/home/useHomeStarters";
import { useHomeThreads } from "../computer/home/HomeThreads";
import { toastManager } from "../ui/toast";
import { DraftHeroProjectHeading } from "./DraftHeroProjectHeading";
import { NewChatComputerPicker, useNewChatComputerName } from "./NewChatComputerPicker";
import { NewChatFolderPicker } from "./NewChatFolderPicker";

/** Hints under the centred box: a few, not a wall. */
const MAX_DRAFT_HERO_STARTERS = 3;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const DraftHeroHeadline = memo(function DraftHeroHeadline({
  environmentId,
  draftId,
  projectName,
  projectCwd,
}: {
  environmentId: EnvironmentId;
  draftId: DraftId;
  projectName: string;
  projectCwd: string;
}) {
  const home = useHomeFolderPath(environmentId);
  const { moveDraftToFolder } = useFolderChats(environmentId);
  const { moveDraft } = useChatOnComputer();
  const switchEnvironment = useSwitchEnvironment();
  const computerName = useNewChatComputerName(environmentId);
  const inHome =
    home !== null &&
    normalizeProjectPathForComparison(home) === normalizeProjectPathForComparison(projectCwd);
  const folder = inHome ? null : { cwd: projectCwd, name: projectName };

  const folderPicker = (
    <NewChatFolderPicker
      variant="inline"
      environmentId={environmentId}
      folder={folder}
      onPick={(next, projectRef) => {
        if (next === null ? inHome : next.cwd === projectCwd) return;
        return moveDraftToFolder(draftId, next?.cwd ?? null, projectRef).catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Couldn't switch the folder",
            description: errorText(error),
          });
        });
      }}
    />
  );
  const computerPicker = (
    <NewChatComputerPicker
      variant="inline"
      environmentId={environmentId}
      onPick={(target) => {
        // Another Uno Work version in the browser: that computer's own page.
        if (switchReloadUrl(currentStaleBundlePage(), readStaleBundleMachine(target))) {
          switchEnvironment(target);
          return;
        }
        return moveDraft(draftId, target).catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Couldn't start the chat on that computer",
            description: errorText(error),
          });
        });
      }}
    />
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center px-2">
      <DraftHeroProjectHeading
        folderPicker={folderPicker}
        computerPicker={computerPicker}
        folderName={folder ? folder.name : "Home folder"}
        computerName={computerName}
      />
    </div>
  );
});

export const DraftHeroStarters = memo(function DraftHeroStarters({
  environmentId,
  draftId,
  onPicked,
}: {
  environmentId: EnvironmentId;
  draftId: DraftId;
  /** After a hint is typed in (focus the box). */
  onPicked: () => void;
}) {
  const { threads, now } = useHomeThreads();
  const starters = useHomeStarters({ environmentId, threads, now });
  // A hint from a chat in another folder would need the chat moved: Home's
  // box does that, here it would surprise — keep the ones that fit any folder.
  const shown = useMemo(
    () => starters.filter((starter) => !starter.folder).slice(0, MAX_DRAFT_HERO_STARTERS),
    [starters],
  );
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-center gap-2" data-testid="draft-hero-starters">
      {shown.map((starter) => (
        <button
          key={starter.id}
          type="button"
          title={starter.prompt}
          onClick={() => {
            setPrompt(draftId, starter.prompt);
            onPicked();
          }}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-card px-3.5 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none"
          data-testid="draft-hero-starter"
        >
          <span className="truncate">{starter.label}</span>
        </button>
      ))}
    </div>
  );
});
