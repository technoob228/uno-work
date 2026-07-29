import { createFileRoute, redirect } from "@tanstack/react-router";

import { readPrimaryEnvironmentDescriptor } from "../environments/primary/context";

export const Route = createFileRoute("/settings/source-control")({
  beforeLoad: () => {
    const primary = readPrimaryEnvironmentDescriptor();
    if (!primary) {
      throw redirect({ to: "/settings/app/general", replace: true });
    }
    throw redirect({
      to: "/settings/environment/$environmentId/source-control",
      params: { environmentId: primary.environmentId },
      replace: true,
    });
  },
});
