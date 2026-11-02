/**
 * The disks of Files, side by side: this computer's home folder and the
 * account's Cloud storage (S3), like Finder's sidebar locations. With several
 * computers connected the first one is a menu of them all (Misha 01.11).
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, CloudIcon, HardDriveIcon, LaptopIcon } from "lucide-react";
import { useMemo } from "react";

import { useMachineRows } from "../../hooks/useMachineRows";
import { cn } from "../../lib/utils";
import { useSpacesOn } from "../../spaces";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";

interface FilesComputer {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly cloud: boolean;
}

/** The computers Files can open: connected right now. A space is its computer: none to pick. */
export function useFilesComputers(): ReadonlyArray<FilesComputer> {
  const rows = useMachineRows();
  const spacesOn = useSpacesOn();
  return useMemo(
    () =>
      spacesOn
        ? []
        : rows.flatMap((row) =>
            row.environmentId !== null && row.status === "online"
              ? [
                  {
                    environmentId: row.environmentId as EnvironmentId,
                    label: row.label,
                    cloud: row.kind === "uno_box",
                  },
                ]
              : [],
          ),
    [rows, spacesOn],
  );
}

export function FilesLocationSwitch({
  location,
  environmentId = null,
  onPickComputer,
  onComputer,
  onCloud,
  narrow = false,
}: {
  location: "computer" | "cloud";
  /** The computer Files is on. */
  environmentId?: EnvironmentId | null | undefined;
  /** Without it the first disk stays "This computer", whatever is connected. */
  onPickComputer?: ((environmentId: EnvironmentId) => void) | undefined;
  onComputer: () => void;
  onCloud: () => void;
  /** No room for both names (a phone, the panel's column): the open one keeps its name. */
  narrow?: boolean | undefined;
}) {
  const computers = useFilesComputers();
  const item = (active: boolean) =>
    cn(
      "flex h-7 items-center gap-1.5 rounded-md px-2 text-sm transition-colors",
      active
        ? "bg-background font-medium text-foreground shadow-xs"
        : "text-muted-foreground hover:text-foreground",
    );
  // Under 400 px the open name goes too: it pushed Recent off the row.
  // `not-sr-only` brings back `white-space: normal`, so a long computer name
  // wrapped onto two lines in the panel (Misha 02.11): kept on one, cut short.
  const label = (active: boolean) =>
    cn(
      narrow ? (active ? "sr-only min-[400px]:not-sr-only" : "sr-only") : "hidden sm:inline",
      "whitespace-nowrap!",
    );
  return (
    <div
      className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/70 p-0.5"
      role="tablist"
      aria-label="Location"
    >
      {onPickComputer && computers.length > 1 ? (
        <ComputerMenu
          computers={computers}
          environmentId={environmentId}
          onPick={onPickComputer}
          className={item(location === "computer")}
          labelClassName={label(location === "computer")}
          selected={location === "computer"}
        />
      ) : (
        <button
          type="button"
          role="tab"
          aria-selected={location === "computer"}
          className={item(location === "computer")}
          title="This computer"
          onClick={onComputer}
        >
          <HardDriveIcon className="size-3.5" />
          <span className={label(location === "computer")}>This computer</span>
        </button>
      )}
      <button
        type="button"
        role="tab"
        aria-selected={location === "cloud"}
        className={item(location === "cloud")}
        title="Cloud storage"
        onClick={onCloud}
      >
        <CloudIcon className="size-3.5" />
        <span className={label(location === "cloud")}>Cloud storage</span>
      </button>
    </div>
  );
}

function ComputerMenu({
  computers,
  environmentId,
  onPick,
  className,
  labelClassName,
  selected,
}: {
  computers: ReadonlyArray<FilesComputer>;
  environmentId: EnvironmentId | null;
  onPick: (environmentId: EnvironmentId) => void;
  className: string;
  labelClassName: string;
  selected: boolean;
}) {
  const name =
    computers.find((computer) => computer.environmentId === environmentId)?.label ??
    "This computer";
  return (
    <Menu>
      <MenuTrigger
        role="tab"
        aria-selected={selected}
        aria-label={`Computer: ${name}`}
        title={name}
        className={className}
        data-testid="files-computer-menu"
      >
        <HardDriveIcon className="size-3.5" />
        <span className={cn(labelClassName, "min-w-0 max-w-40 truncate")}>{name}</span>
        <ChevronDownIcon className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-56">
        <MenuRadioGroup
          value={environmentId ?? ""}
          onValueChange={(value) => onPick(value as EnvironmentId)}
        >
          {computers.map((computer) => {
            const Icon = computer.cloud ? CloudIcon : LaptopIcon;
            return (
              <MenuRadioItem
                key={computer.environmentId}
                value={computer.environmentId}
                data-testid="files-computer-option"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{computer.label}</span>
                </span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** What Cloud storage is and what becomes of it (flows v2, E5). */
export function CloudStorageNote() {
  return (
    <p className="mt-1.5 text-xs leading-snug text-muted-foreground" data-testid="files-cloud-note">
      Shared by all your computers. It stays when a computer is deleted, and copies of your
      computers are kept here too.
    </p>
  );
}
