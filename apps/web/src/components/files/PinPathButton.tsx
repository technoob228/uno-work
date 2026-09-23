/** "Pin" for the folder being browsed or the file being viewed. */
import { PinIcon, PinOffIcon } from "lucide-react";

import { pathTitle } from "../../navigation/pins";
import { usePins } from "../../navigation/usePins";
import { Button } from "../ui/button";

export function PinPathButton({ kind, path }: { kind: "file" | "folder"; path: string }) {
  const { isPinned, toggle } = usePins();
  const pinned = isPinned(kind, path);
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-pressed={pinned}
      title={pinned ? "Unpin from the sidebar" : "Pin to the sidebar"}
      className={pinned ? "text-primary" : undefined}
      onClick={() => toggle({ kind, title: pathTitle(path), target: path })}
    >
      {pinned ? <PinOffIcon /> : <PinIcon />}
      <span className="hidden lg:inline">{pinned ? "Unpin" : "Pin"}</span>
    </Button>
  );
}
