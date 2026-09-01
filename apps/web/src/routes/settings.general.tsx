import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Settings used to live at one flat level, mixing this device's preferences
 * with the daemon's. The paths that survive point at the app scope, which is
 * the half that belongs to no machine — an old link can never land the user on
 * a page that writes to a daemon they did not choose.
 */
export const Route = createFileRoute("/settings/general")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/app/general", replace: true });
  },
});
