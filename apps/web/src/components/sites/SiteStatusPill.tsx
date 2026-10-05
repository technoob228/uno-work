/**
 * Who can open a site, the same pill everywhere a site is listed: "Live"
 * (anyone with the link) or "Password" with a lock.
 */
import { LockIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { siteStatus, siteStatusTitle } from "./sitesModel";

export function SiteStatusPill({
  site,
  className,
}: {
  site: { readonly hasPassword: boolean };
  className?: string;
}) {
  const status = siteStatus(site);
  return (
    <span
      data-testid="site-status"
      title={siteStatusTitle(site)}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        status.locked
          ? "bg-muted text-muted-foreground"
          : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        className,
      )}
    >
      {status.locked ? <LockIcon className="size-3 shrink-0" /> : null}
      {status.label}
    </span>
  );
}
