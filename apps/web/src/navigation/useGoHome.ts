/**
 * "Home" — the computer's desktop (`/computer`), one click from anywhere:
 * the wordmark, the Home row at the top of the sidebar, the app bar and the
 * full-screen pill all lead here.
 */
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useSidebar } from "../components/ui/sidebar";
import { useNavStore } from "./navStore";

export function useGoHome() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const setAppFullscreen = useNavStore((state) => state.setAppFullscreen);
  return useCallback(() => {
    setAppFullscreen(false);
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/computer" });
  }, [isMobile, navigate, setAppFullscreen, setOpenMobile]);
}
