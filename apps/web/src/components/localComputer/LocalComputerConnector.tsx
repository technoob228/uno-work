/**
 * "Connect my computer" where people look for it: as a connector in Settings
 * and in the setup, and in the computer menu. All of it renders nothing while
 * the account doesn't have the feature.
 */
import type { EnvironmentId, MyComputer } from "@t3tools/contracts";
import { LaptopIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { cn } from "../../lib/utils";
import { localComputer } from "../../localComputer/localComputerStore";
import { useImportStatus } from "../../localComputer/useChatImport";
import { STATUS_POLL_SCREEN_MS, useMyComputers } from "../../localComputer/useMyComputers";
import { STATUS_DOT_CLASS } from "../computerSwitcher/useComputerSwitcher";
import { Button } from "../ui/button";
import { importedLine } from "./chatImport.logic";
import { computerStatusLine } from "./connectComputer.logic";

function Row({
  name,
  status,
  dot,
  side,
  testId,
}: {
  name: string;
  status: string;
  dot: "online" | "offline" | null;
  side: ReactNode;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-4 px-4 py-3.5 sm:px-5" data-testid={testId}>
      <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-background">
        <LaptopIcon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{name}</div>
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {dot !== null ? (
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                STATUS_DOT_CLASS[dot === "online" ? "connected" : "disconnected"],
              )}
            />
          ) : null}
          <span className="truncate">{status}</span>
        </div>
      </div>
      <div className="shrink-0">{side}</div>
    </div>
  );
}

function ComputerRow({
  environmentId,
  computer,
  updatedAt,
}: {
  environmentId: EnvironmentId | null;
  computer: MyComputer;
  updatedAt: number;
}) {
  const imported = importedLine(useImportStatus(environmentId, computer.id).data);
  const status = computerStatusLine(computer, updatedAt);
  return (
    <Row
      name={computer.name}
      status={imported !== null ? `${status} · ${imported}` : status}
      dot={computer.online ? "online" : "offline"}
      testId={`connector-computer-${computer.id}`}
      side={
        <Button variant="outline" size="sm" onClick={() => localComputer.openManage(computer.id)}>
          Manage computer
        </Button>
      }
    />
  );
}

/** The rows of a Connectors list. `className` is for a list it shares with others. */
export function LocalComputerConnector({ className }: { className?: string }) {
  const environmentId = usePrimaryEnvironmentId();
  const { enabled, computers, updatedAt } = useMyComputers(environmentId, {
    pollMs: STATUS_POLL_SCREEN_MS,
  });
  if (!enabled) return null;
  return (
    <div className={cn("divide-y divide-border", className)} data-testid="connector-my-computer">
      {computers.length === 0 ? (
        <Row
          name="My computer"
          status="Agents use it while it’s on"
          dot={null}
          testId="connector-my-computer-off"
          side={
            <Button size="sm" onClick={localComputer.openConnect} data-testid="connector-connect">
              Connect computer
            </Button>
          }
        />
      ) : (
        computers.map((computer) => (
          <ComputerRow
            key={computer.id}
            environmentId={environmentId}
            computer={computer}
            updatedAt={updatedAt}
          />
        ))
      )}
      {computers.length > 0 ? (
        <div className="px-4 py-2.5 sm:px-5">
          <button
            type="button"
            onClick={localComputer.openConnect}
            data-testid="connector-connect-another"
            className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <PlusIcon className="size-3.5" />
            Connect another computer
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The computer menu's lines. Fetched when the menu opens, never polled. */
export function LocalComputerMenuItems({ onOpen }: { onOpen: () => void }) {
  const environmentId = usePrimaryEnvironmentId();
  const { enabled, computers } = useMyComputers(environmentId);
  if (!enabled) return null;
  if (computers.length === 0) {
    return (
      <button
        type="button"
        onClick={() => {
          onOpen();
          localComputer.openConnect();
        }}
        data-testid="connect-my-computer"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-primary transition-colors hover:bg-primary/8"
      >
        <LaptopIcon className="size-3.5" />
        <span>Connect my computer</span>
      </button>
    );
  }
  return computers.map((computer) => (
    <button
      key={computer.id}
      type="button"
      onClick={() => {
        onOpen();
        localComputer.openManage(computer.id);
      }}
      data-testid="local-computer-row"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
    >
      <LaptopIcon className="size-3.5 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{computer.name}</span>
      <span className="text-[10px] text-muted-foreground">
        {computer.online ? "Connected" : "Offline"}
      </span>
      <span
        className={cn(
          "size-1.5 rounded-full",
          STATUS_DOT_CLASS[computer.online ? "connected" : "disconnected"],
        )}
      />
    </button>
  ));
}
