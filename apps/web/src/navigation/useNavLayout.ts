import { isElectron } from "../env";
import { useFeatureFlag } from "../hooks/useFeatureFlags";
import { useIsMobile } from "../hooks/useMediaQuery";
import { effectiveNavLayout, useNavStore, type NavLayout } from "./navStore";

/** The layout this window shows now (see `effectiveNavLayout`). */
export function useNavLayout(): NavLayout {
  const chosen = useNavStore((state) => state.layout);
  const labsEnabled = useFeatureFlag("navLayouts");
  const isMobile = useIsMobile();
  return effectiveNavLayout({ chosen, labsEnabled, isMobile, isDesktopApp: isElectron });
}
