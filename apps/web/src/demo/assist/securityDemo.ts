/**
 * Settings → Security in the assist demo: what the console answers on
 * GET /api/v1/security/protection (fishcode box/security_protection.go).
 *
 *   ?security=off  (default) 404 NOT_ENABLED — Protection is not on for the
 *                  account, as in production while SECURITY_PROTECTION is off
 *   ?security=on   Protection on, every computer Open
 *   ?security=hold after "Stop everything & report": computers stopped, the
 *                  report open (the banner on top of the page)
 */
import { HttpResponse, http, type HttpHandler } from "msw";

import { MACHINES } from "../heavyFixtures";

type SecurityDemo = "off" | "on" | "hold";

function securityDemo(): SecurityDemo {
  if (typeof location === "undefined") return "off";
  const value = new URLSearchParams(location.search).get("security");
  return value === "on" || value === "hold" ? value : "off";
}

function protection(mode: SecurityDemo) {
  const held = mode === "hold";
  const computers = [MACHINES.work, MACHINES.product]
    .filter((machine) => machine.boxId !== null)
    .map((machine, index) => ({
      id: machine.boxId!,
      name: machine.label,
      status: held ? "stopped" : index === 0 ? "running" : "sleeping",
      mode: "inherit",
    }));
  return {
    isolation: {
      all: "open",
      computers,
      uno_ai_when_isolated: true,
      limited_allow: ["github.com", "registry.npmjs.org", "pypi.org"],
    },
    private_network: { set_up: false, devices: [] },
    emergency: held
      ? {
          id: "12",
          reported_at: new Date(Date.now() - 25 * 60_000).toISOString(),
          stopped: computers.map(({ id, name }) => ({ id, name })),
          note: "An app I didn't install is sending email.",
          signed_out: false,
          state: "open",
        }
      : null,
  };
}

export function securityDemoHandlers(): HttpHandler[] {
  return [
    http.get("*/_account/api/v1/security/protection", () => {
      const mode = securityDemo();
      return mode === "off"
        ? HttpResponse.json({ error: "NOT_ENABLED", code: "NOT_ENABLED" }, { status: 404 })
        : HttpResponse.json(protection(mode));
    }),
  ];
}
