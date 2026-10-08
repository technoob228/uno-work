/**
 * The two disks of Files, side by side: this computer's home folder and the
 * account's Cloud storage (S3), like Finder's sidebar locations.
 */
import { CloudIcon, HardDriveIcon } from "lucide-react";

import { cn } from "../../lib/utils";

export function FilesLocationSwitch({
  location,
  onComputer,
  onCloud,
}: {
  location: "computer" | "cloud";
  onComputer: () => void;
  onCloud: () => void;
}) {
  const item = (active: boolean) =>
    cn(
      "flex h-7 items-center gap-1.5 rounded-md px-2 text-sm transition-colors",
      active
        ? "bg-background font-medium text-foreground shadow-xs"
        : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div
      className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/70 p-0.5"
      role="tablist"
      aria-label="Location"
    >
      <button
        type="button"
        role="tab"
        aria-selected={location === "computer"}
        className={item(location === "computer")}
        onClick={onComputer}
      >
        <HardDriveIcon className="size-3.5" />
        <span className="hidden sm:inline">This computer</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={location === "cloud"}
        className={item(location === "cloud")}
        onClick={onCloud}
      >
        <CloudIcon className="size-3.5" />
        <span className="hidden sm:inline">Cloud storage</span>
      </button>
    </div>
  );
}

/** One line on what this location is and what happens to it (flows v2, E5). */
export const FILES_LOCATION_NOTE = {
  computer:
    "Files on this computer. They live with it: if the computer is deleted, they go too. Keep what must stay in Cloud storage.",
  cloud:
    "Shared by all your computers. It stays when a computer is deleted, and copies of your computers are kept here too.",
} as const;

export function FilesLocationNote({ location }: { location: "computer" | "cloud" }) {
  return (
    <p
      className="mt-1.5 text-xs leading-snug text-muted-foreground"
      data-testid="files-location-note"
    >
      <span className="font-medium text-foreground sm:hidden">
        {location === "computer" ? "This computer. " : "Cloud storage. "}
      </span>
      {FILES_LOCATION_NOTE[location]}
    </p>
  );
}
