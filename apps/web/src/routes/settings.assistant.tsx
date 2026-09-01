import { createFileRoute, redirect } from "@tanstack/react-router";

import { readPrimaryEnvironmentDescriptor } from "../environments/primary/context";

/**
 * Assistants belong to a daemon, so the old environment-less path resolves to
 * the primary one explicitly rather than staying ambiguous.
 */
export const Route = createFileRoute("/settings/assistant")({
  beforeLoad: () => {
    const primary = readPrimaryEnvironmentDescriptor();
    if (!primary) {
      throw redirect({ to: "/settings/app/general", replace: true });
    }
    throw redirect({
      to: "/settings/environment/$environmentId/assistants",
      params: { environmentId: primary.environmentId },
      replace: true,
    });
  },
});
