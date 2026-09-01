import type { EnvironmentId } from "@t3tools/contracts";
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { EnvironmentScopeBanner } from "../environments/scope/EnvironmentScopeBanner";
import { useEnvironmentScope } from "../environments/scope/scopes";

/**
 * Layout for everything one environment's daemon owns. The environment is in
 * the path, so a reload or a back/forward keeps editing the same machine
 * rather than whichever one happens to be active, and the banner states which
 * machine that is before any save reaches it.
 */
function EnvironmentSettingsLayout() {
  const { environmentId } = Route.useParams();
  const scope = useEnvironmentScope(environmentId as EnvironmentId);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-6 pt-6 sm:px-8">
        <div className="mx-auto w-full max-w-3xl">
          <EnvironmentScopeBanner scope={scope} environmentId={environmentId as EnvironmentId} />
        </div>
      </div>
      <Outlet />
    </div>
  );
}

export const Route = createFileRoute("/settings/environment/$environmentId")({
  beforeLoad: ({ params, location }) => {
    if (location.pathname.replace(/\/$/, "").endsWith(params.environmentId)) {
      throw redirect({
        to: "/settings/environment/$environmentId/general",
        params,
        replace: true,
      });
    }
  },
  component: EnvironmentSettingsLayout,
});
