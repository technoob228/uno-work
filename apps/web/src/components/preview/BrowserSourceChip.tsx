/**
 * "Opens in: This app ▾" — the small chip in a browser tab's address bar
 * (plan 22, step 4). It lists only the sources this client really has and is
 * not shown when there is one (the web build: only the computer's browser).
 * Picking the other source opens the same address there, in place of this
 * tab; "Use by default" makes the Browser tile and "+" open there next time.
 */
import { ChevronDownIcon } from "lucide-react";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import {
  BROWSER_SOURCE_DESCRIPTION,
  BROWSER_SOURCE_LABEL,
  type BrowserSource,
  isDefaultBrowserSource,
  nextBrowserOpenIn,
  showBrowserSourceChip,
} from "./browserSource";
import { usePreviewPane } from "./PreviewPaneContext";
import { useChatBrowser } from "./useChatBrowser";

export function BrowserSourceChip({
  source,
  tabId,
  url,
}: {
  /** Where this tab's page runs. */
  source: BrowserSource;
  tabId: string;
  /** The page's address; empty for a new tab. */
  url: string;
}) {
  const { sources, openInSource } = useChatBrowser();
  const { closeFile } = usePreviewPane();
  const browserOpenIn = useSettings((settings) => settings.browserOpenIn);
  const { updateSettings } = useUpdateSettings();
  if (!showBrowserSourceChip(sources)) return null;

  const label = BROWSER_SOURCE_LABEL[source];
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`Opens in: ${label}`}
            title={`Opens in: ${label}`}
            data-testid="browser-source-chip"
            className={cn(
              "inline-flex h-6 min-w-0 max-w-36 shrink-0 cursor-pointer items-center gap-1 rounded-md bg-accent px-1.5 text-[11px] font-medium text-foreground hover:bg-accent/70",
            )}
          />
        }
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-72">
        <MenuGroup>
          <MenuGroupLabel>Opens in</MenuGroupLabel>
          <MenuRadioGroup
            value={source}
            onValueChange={(value) => {
              const next = value as BrowserSource;
              if (next === source) return;
              // The same address in the other browser, in place of this tab.
              openInSource(next, url);
              closeFile(tabId);
            }}
          >
            {sources.map((candidate) => (
              <MenuRadioItem key={candidate} value={candidate}>
                <span className="flex min-w-0 flex-col py-0.5">
                  <span>{BROWSER_SOURCE_LABEL[candidate]}</span>
                  <span className="text-xs text-muted-foreground">
                    {BROWSER_SOURCE_DESCRIPTION[candidate]}
                  </span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuCheckboxItem
          checked={isDefaultBrowserSource(browserOpenIn, source)}
          onCheckedChange={(checked) =>
            void updateSettings({ browserOpenIn: nextBrowserOpenIn(source, checked) })
          }
          data-testid="browser-source-default"
        >
          Use by default
        </MenuCheckboxItem>
      </MenuPopup>
    </Menu>
  );
}
