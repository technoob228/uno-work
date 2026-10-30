/**
 * Terminal on Home. A shell on the wrong computer is the one mistake that can
 * cost something, and Home has no computer of its own (Misha 30.10): with
 * several computers the button asks where; with one it just opens. A space is
 * its computer, so there it just opens too.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, TerminalIcon } from "lucide-react";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import { useStore } from "../../../store";
import type { SidebarDComputer } from "../../sidebar/sidebarDView.logic";
import { Button } from "../../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { useHomeLaunchers } from "../useHomeLaunchers";
import { KindIcon, dotClass, statusWords, useLive } from "./ComputersOverview";

export function HomeTerminalButton(props: {
  /** Where it can open; one means no question. */
  computers: ReadonlyArray<SidebarDComputer>;
  /** The computer Home's picker shows: a one-off terminal leaves it there. */
  homeId: EnvironmentId | null;
  /** The one computer's link is down. */
  linkDown: boolean;
  onOpen: () => void;
}) {
  const computers = useMemo(
    () =>
      props.computers.toSorted(
        (a, b) => Number(a.environmentId === null) - Number(b.environmentId === null),
      ),
    [props.computers],
  );
  if (computers.length < 2) {
    return (
      <Button
        size="xs"
        variant="ghost"
        onClick={props.onOpen}
        disabled={props.linkDown}
        aria-label="Terminal"
        title={props.linkDown ? "This computer is offline" : "Open a terminal on this computer"}
        data-testid="home-terminal"
      >
        <TerminalIcon className="size-3.5" />
        <span className="hidden sm:inline">Terminal</span>
      </Button>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            aria-label="Terminal: choose a computer"
            data-testid="home-terminal"
          />
        }
      >
        <TerminalIcon className="size-3.5" />
        <span className="hidden sm:inline">Terminal</span>
        <ChevronDownIcon className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>Open a terminal on</MenuGroupLabel>
          {computers.map((computer) =>
            computer.environmentId !== null ? (
              <LiveOption
                key={computer.key}
                computer={computer}
                environmentId={computer.environmentId as EnvironmentId}
                homeId={props.homeId}
              />
            ) : (
              <Option
                key={computer.key}
                computer={computer}
                dot={dotClass(null, true)}
                note="Asleep"
              />
            ),
          )}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function LiveOption(props: {
  computer: SidebarDComputer;
  environmentId: EnvironmentId;
  homeId: EnvironmentId | null;
}) {
  const live = useLive(props.environmentId);
  const launchers = useHomeLaunchers(props.environmentId);
  const openOnce = () => {
    void launchers.openTerminal().then(() => {
      if (props.homeId) useStore.getState().setActiveEnvironmentId(props.homeId);
    });
  };
  return (
    <Option
      computer={props.computer}
      dot={dotClass(live, false)}
      note={live.up ? null : statusWords(live)}
      onPick={live.up ? openOnce : undefined}
    />
  );
}

function Option(props: {
  computer: SidebarDComputer;
  dot: string;
  note: string | null;
  onPick?: (() => void) | undefined;
}) {
  return (
    <MenuItem
      disabled={props.onPick === undefined}
      onClick={props.onPick}
      data-testid="home-terminal-option"
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", props.dot)} />
      <KindIcon cloud={props.computer.cloud ?? false} className="size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{props.computer.label}</span>
      {props.note ? (
        <span className="shrink-0 text-xs text-muted-foreground">{props.note}</span>
      ) : null}
    </MenuItem>
  );
}
