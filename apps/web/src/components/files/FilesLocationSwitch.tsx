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
