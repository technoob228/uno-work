/**
 * "Connect my computer", the chat import: the offer after connecting (and from
 * the computer's card), and the card in the corner while chats arrive. The
 * corner stays out of the way: the list fills up behind it.
 *
 * Nothing is imported without the person: the offer asks, "Not now" is final
 * until they come back to it from the computer's card.
 */
import type { EnvironmentId, MyComputerImportTool } from "@t3tools/contracts";
import { CheckIcon, Loader2Icon, MessagesSquareIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { importFlow, useImportFlow } from "../../localComputer/importStore";
import { localComputer, useLocalComputer } from "../../localComputer/localComputerStore";
import { useImportActions, useImportStatus } from "../../localComputer/useChatImport";
import { ClaudeAI, OpenAI, OpenCodeIcon } from "../Icons";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  alsoFoundLine,
  chatsLabel,
  importResultLine,
  offeredTools,
  selectedChats,
  selectedTools,
  skippedLine,
} from "./chatImport.logic";
import { Heading, Shell } from "./ConnectShell";

const TOOL_ICON = { claude: ClaudeAI, codex: OpenAI, opencode: OpenCodeIcon } as const;

function ToolRow({ tool, on }: { tool: MyComputerImportTool; on: boolean }) {
  const Icon = TOOL_ICON[tool.id];
  if (!tool.available) {
    return (
      <div
        className="flex items-center gap-3 px-1 py-1.5 text-muted-foreground"
        data-testid={`import-tool-${tool.id}`}
      >
        <Checkbox checked={false} disabled />
        <Icon className="size-4 shrink-0 opacity-60" />
        <span className="min-w-0 flex-1 truncate text-sm">{tool.name}</span>
        <span className="shrink-0 text-xs">{tool.unavailableReason}</span>
      </div>
    );
  }
  return (
    <label
      className="flex cursor-pointer items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-accent/60"
      data-testid={`import-tool-${tool.id}`}
    >
      <Checkbox checked={on} onCheckedChange={() => importFlow.toggleTool(tool.id)} />
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm">{tool.name}</span>
      <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
        {chatsLabel(tool.newChats)}, {tool.projects} {tool.projects === 1 ? "project" : "projects"}
      </span>
    </label>
  );
}

/** The offer itself, inside whichever card brought the person here. */
export function ImportOfferBody({
  environmentId,
  computerId,
  onDone,
}: {
  environmentId: EnvironmentId | null;
  computerId: string;
  onDone: () => void;
}) {
  const status = useImportStatus(environmentId, computerId).data;
  const actions = useImportActions(environmentId, computerId);
  const unticked = useImportFlow((state) => state.unticked);
  const [error, setError] = useState<string | null>(null);
  if (status === undefined) return null;
  const tools = offeredTools(status.tools);
  const count = selectedChats(status.tools, unticked);
  const alsoFound = alsoFoundLine(status.alsoFound);
  const skipped = skippedLine(status.skipped);

  const decline = () => {
    actions.decline().catch(() => undefined);
    onDone();
  };
  const start = async () => {
    setError(null);
    try {
      await actions.start(selectedTools(status.tools, unticked));
      importFlow.follow(computerId);
      onDone();
    } catch {
      setError("Couldn't start the import. Try again.");
    }
  };

  return (
    <>
      <div data-testid="import-offer" className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">Bring your chats to Uno Work?</p>
        <div className="flex flex-col">
          {tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} on={!unticked.has(tool.id)} />
          ))}
        </div>
        {alsoFound !== null ? (
          <p className="text-xs text-muted-foreground" data-testid="import-also-found">
            {alsoFound}
          </p>
        ) : null}
        {skipped !== null ? (
          <p className="text-xs text-muted-foreground" data-testid="import-skipped">
            {skipped}
          </p>
        ) : null}
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={decline} data-testid="connect-finish">
          Not now
        </Button>
        <Button disabled={count === 0} onClick={() => void start()} data-testid="import-start">
          Import {chatsLabel(count)}
        </Button>
      </div>
    </>
  );
}

export function ImportSearching({
  done,
  total,
  label = "Looking for chats on this computer",
}: {
  done: number;
  total: number;
  label?: string;
}) {
  return (
    <p
      className="flex items-center gap-2 text-sm text-muted-foreground"
      data-testid="import-searching"
    >
      <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
      <span>{label}</span>
      {total > 0 ? (
        <span className="tabular-nums">
          {done} of {total}
        </span>
      ) : null}
    </p>
  );
}

/** Coming back from the computer's card: a fresh search, then the offer. */
export function ImportDialog() {
  const environmentId = usePrimaryEnvironmentId();
  const computerId = useLocalComputer((state) => state.manageId);
  const status = useImportStatus(environmentId, computerId, { watch: true }).data;
  const { scan } = useImportActions(environmentId, computerId);
  const [asked, setAsked] = useState<"waiting" | "asked" | "failed">("waiting");
  useEffect(() => {
    if (computerId === null) return;
    scan().then(
      () => setAsked("asked"),
      () => setAsked("failed"),
    );
  }, [computerId, scan]);
  if (computerId === null) return null;
  const back = () => localComputer.openManage(computerId);
  const state = asked === "asked" ? status?.state : undefined;
  const offer = state === "ready" && status !== undefined && offeredTools(status.tools).length > 0;
  const closing =
    asked === "failed" || state === "failed" ? (
      <p role="alert" className="text-sm text-destructive">
        {status?.message ?? "Couldn't look for chats."}
      </p>
    ) : state === "ready" ? (
      <p className="text-sm text-muted-foreground" data-testid="import-nothing-new">
        No new chats on this computer.
      </p>
    ) : state === "done" && status?.result != null ? (
      <p className="text-sm text-muted-foreground" data-testid="import-result">
        {importResultLine(status.result)}
      </p>
    ) : state === "importing" && status !== undefined ? (
      <ImportSearching
        done={status.progress.done}
        total={status.progress.total}
        label="Importing your chats"
      />
    ) : (
      <ImportSearching done={status?.scanned.done ?? 0} total={status?.scanned.total ?? 0} />
    );
  return (
    <Shell testId="import-dialog" onEscape={back}>
      <Heading icon={<MessagesSquareIcon className="size-4" />} title="Import chats" />
      {offer ? (
        <ImportOfferBody environmentId={environmentId} computerId={computerId} onDone={back} />
      ) : (
        <>
          {closing}
          <div className="flex justify-end">
            <Button variant="ghost" onClick={back}>
              Close
            </Button>
          </div>
        </>
      )}
    </Shell>
  );
}

/** The corner card. The chats themselves show up in the list behind it. */
export function ImportProgress() {
  const environmentId = usePrimaryEnvironmentId();
  const computerId = useImportFlow((state) => state.followingId);
  const status = useImportStatus(environmentId, computerId, { watch: true }).data;
  const levels = useSettings((settings) => settings.sidebarGroupLevels);
  const { updateSettings } = useUpdateSettings();
  const running = status?.state === "importing";
  const finished = status?.state === "done";
  const failed = status?.state === "failed";
  const byProject = levels?.length === 1 && levels[0] === "project";
  useEffect(() => {
    // Chats arrive by project: the list has to show them that way.
    if (running && !byProject) updateSettings({ sidebarGroupLevels: ["project"] });
  }, [byProject, running, updateSettings]);
  if (computerId === null || status === undefined || (!running && !finished && !failed)) {
    return null;
  }
  const { done, total } = status.progress;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const imported = status.result?.imported ?? 0;
  const title = running
    ? "Importing your chats"
    : failed
      ? "The import stopped"
      : `${chatsLabel(imported)} imported`;
  const skipped = skippedLine(status.skipped);
  return (
    <div
      className="fixed right-6 bottom-6 z-40 flex w-80 flex-col gap-2.5 rounded-2xl border bg-popover p-4 text-popover-foreground shadow-lg/5"
      data-testid="import-progress"
    >
      <div className="flex items-center gap-2.5">
        {running ? (
          <Loader2Icon className="size-4 shrink-0 animate-spin text-primary" />
        ) : failed ? (
          <XIcon className="size-4 shrink-0 text-destructive" />
        ) : (
          <CheckIcon className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {running ? (
          <span className="text-sm text-muted-foreground tabular-nums">
            {done} of {total}
          </span>
        ) : (
          <button
            type="button"
            aria-label="Close"
            onClick={importFlow.dismiss}
            data-testid="import-dismiss"
            className="cursor-pointer rounded-md p-0.5 text-muted-foreground hover:bg-accent"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
      {running ? (
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}
      {finished && status.result !== null ? (
        <p className="text-xs text-muted-foreground" data-testid="import-result">
          {importResultLine(status.result)}
          {skipped !== null ? ` ${skipped}` : ""}
        </p>
      ) : null}
      {failed && status.message !== null ? (
        <p className="text-xs text-muted-foreground">{status.message}</p>
      ) : null}
    </div>
  );
}
