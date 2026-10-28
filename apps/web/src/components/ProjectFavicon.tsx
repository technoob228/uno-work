import type { EnvironmentId } from "@t3tools/contracts";
import { FolderIcon } from "lucide-react";
import { useState } from "react";
import { resolveEnvironmentHttpUrl } from "../environments/runtime";
import { deriveProjectIdentity } from "../projectIdentity";
import { ProjectMonogram } from "./ProjectMonogram";

const loadedProjectFaviconSrcs = new Set<string>();

/**
 * The project's own icon (favicon / logo found in its folder); until it loads,
 * or when it has none, two letters of `name` in a color of their own (as in
 * upstream T3 Code), or a folder when no name is given.
 */
export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  name?: string | undefined;
  className?: string;
}) {
  const src = (() => {
    try {
      return resolveEnvironmentHttpUrl({
        environmentId: input.environmentId,
        pathname: "/api/project-favicon",
        searchParams: { cwd: input.cwd },
      });
    } catch {
      return null;
    }
  })();
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    src && loadedProjectFaviconSrcs.has(src) ? "loaded" : "loading",
  );

  const fallback = (() => {
    if (input.name !== undefined && input.name.trim().length > 0) {
      const identity = deriveProjectIdentity(input.name);
      return (
        <ProjectMonogram
          text={identity.monogram}
          color={identity.color}
          className={`size-3.5 ${input.className ?? ""}`}
        />
      );
    }
    return (
      <FolderIcon
        className={`size-3.5 shrink-0 text-muted-foreground/50 ${input.className ?? ""}`}
      />
    );
  })();

  if (!src) return fallback;

  return (
    <>
      {status !== "loaded" ? fallback : null}
      <img
        src={src}
        alt=""
        className={`size-3.5 shrink-0 rounded-sm object-contain ${status === "loaded" ? "" : "hidden"} ${input.className ?? ""}`}
        onLoad={() => {
          loadedProjectFaviconSrcs.add(src);
          setStatus("loaded");
        }}
        onError={() => setStatus("error")}
      />
    </>
  );
}
