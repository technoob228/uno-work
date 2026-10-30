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
  narrow = false,
}: {
  location: "computer" | "cloud";
  onComputer: () => void;
  onCloud: () => void;
  /** No room for both names (a phone, the panel's column): the open one keeps its name. */
  narrow?: boolean | undefined;
}) {
  const item = (active: boolean) =>
    cn(
      "flex h-7 items-center gap-1.5 rounded-md px-2 text-sm transition-colors",
      active
        ? "bg-background font-medium text-foreground shadow-xs"
        : "text-muted-foreground hover:text-foreground",
    );
  // Under 400 px the open name goes too: it pushed Recent off the row.
  const label = (active: boolean) =>
    narrow ? (active ? "sr-only min-[400px]:not-sr-only" : "sr-only") : "hidden sm:inline";
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
        title="This computer"
        onClick={onComputer}
      >
        <HardDriveIcon className="size-3.5" />
        <span className={label(location === "computer")}>This computer</span>
      </button>
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

/** What Cloud storage is and what becomes of it (flows v2, E5). */
export function CloudStorageNote() {
  return (
    <p className="mt-1.5 text-xs leading-snug text-muted-foreground" data-testid="files-cloud-note">
      Shared by all your computers. It stays when a computer is deleted, and copies of your
      computers are kept here too.
    </p>
  );
}
