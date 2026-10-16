/**
 * The mock's Settings → Security (16.10): protection (isolation + the red
 * button), and the Advanced part (overview, network, access journal) — kept in
 * memory, a reload starts over.
 */
import { http, HttpResponse } from "msw";

import type {
  ComputerIsolation,
  EmergencyStopBody,
  IsolationBody,
  IsolationMode,
  Protection,
} from "../components/settings/security/protectionModel";

interface DemoComputer {
  readonly id: number;
  readonly name: string;
  status: string;
  mode: ComputerIsolation;
}

export function demoSecurityHandlers(
  computers: ReadonlyArray<{ id: number; name: string; status: string }>,
) {
  const state = {
    all: "open" as IsolationMode,
    computers: computers.map(
      (computer): DemoComputer => ({ ...computer, mode: "inherit" as ComputerIsolation }),
    ),
    devices: [] as Array<{ name: string; last_seen?: string }>,
    unoAi: true,
    emergency: null as Protection["emergency"],
  };

  const protection = (): Protection => ({
    isolation: {
      all: state.all,
      computers: state.computers.map((computer) => ({ ...computer })),
      uno_ai_when_isolated: state.unoAi,
      limited_allow: ["github.com", "registry.npmjs.org", "pypi.org", "archive.ubuntu.com"],
    },
    private_network: {
      set_up: state.devices.length > 0,
      devices: state.devices,
      address_hint: "uno-work.uno",
    },
    emergency: state.emergency,
  });

  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  return [
    http.get("*/_account/api/v1/security/protection", () => HttpResponse.json(protection())),
    http.put("*/_account/api/v1/security/isolation", async ({ request }) => {
      const body = (await request.json()) as IsolationBody;
      if (body.scope === "uno_ai") state.unoAi = body.on;
      else if (body.scope === "all") state.all = body.mode;
      else {
        const computer = state.computers.find((item) => item.id === body.box_id);
        if (computer) computer.mode = body.mode;
      }
      // The first time something is isolated the mock "adds" a laptop once the
      // dialog was seen — here simply after a while, so both states show.
      if (state.devices.length === 0 && body.scope !== "uno_ai" && body.mode === "isolated") {
        setTimeout(() => state.devices.push({ name: "MacBook", last_seen: ago(0) }), 20_000);
      }
      return HttpResponse.json(protection());
    }),
    http.post("*/_account/api/v1/security/emergency-stop", async ({ request }) => {
      const body = (await request.json()) as EmergencyStopBody;
      await new Promise((resolve) => setTimeout(resolve, 900));
      const stopped = state.computers.filter(
        (computer) => !["stopped", "archived", "deleted"].includes(computer.status),
      );
      for (const computer of stopped) computer.status = "stopped";
      state.emergency = {
        id: "inc-demo-1",
        reported_at: new Date().toISOString(),
        stopped: stopped.map(({ id, name }) => ({ id, name })),
        signed_out: body.sign_out,
        state: "open",
        ...(body.note ? { note: body.note } : {}),
      };
      return HttpResponse.json(protection());
    }),
    http.get("*/_account/api/v1/security/summary", () =>
      HttpResponse.json({
        computers: state.computers.map((computer, index) => ({
          box_id: computer.id,
          name: computer.name,
          status: computer.status,
          last_access: { at: ago(4 + index * 50), who: "You", channel: "uno_work" },
          entries_30d: 41 - index * 12,
          uno_unexplained_30d: 0,
          uno_maintenance_30d: index === 0 ? 1 : 0,
        })),
      }),
    ),
    http.get("*/_account/api/v1/boxes/:id/security/access-log", ({ params }) => {
      const id = Number(params.id);
      const entries = [
        { id: 1, box_id: id, at: ago(4), channel: "uno_work", actor: "owner", who: "You" },
        {
          id: 2,
          box_id: id,
          at: ago(35),
          channel: "agent",
          actor: "agent",
          who: "Your AI agent (Claude Code)",
        },
        {
          id: 3,
          box_id: id,
          at: ago(60 * 26),
          channel: "ssh",
          actor: "owner",
          who: "You",
          from_ip: "84.17.40.12",
          client: "SSH key “MacBook”",
        },
      ];
      return HttpResponse.json({
        box_id: id,
        since: ago(60 * 24 * 30),
        entries,
        summary: {
          total: entries.length,
          you: 2,
          agents: 1,
          uno_auto: 0,
          uno_unexplained: 0,
          uno_maintenance: 0,
          ssh_others: 0,
          failed_ssh_attempts: 128,
          failed_ssh_sources: 9,
        },
        guest_scan: { status: "ok", at: ago(30) },
      });
    }),
    http.get("*/_account/api/v1/boxes/:id/security/network", ({ params }) =>
      HttpResponse.json({
        policy: {
          internet: "open",
          open_mode: "all",
          open_ports: [],
          allowed_ips: [],
          ssh_enabled: true,
        },
        is_work_machine: true,
        ports: [
          {
            id: 1,
            internal_port: 80,
            protocol: "tcp",
            external_port: 80,
            address: `box-${String(params.id)}.app.uno4.dev`,
            kind: "uno_work",
            configured: "public",
            effective: "public",
          },
          {
            id: 2,
            internal_port: 22,
            protocol: "tcp",
            external_port: 22195,
            address: "185.130.227.16:22195",
            kind: "ssh",
            configured: "public",
            effective: "public",
          },
          {
            id: 3,
            internal_port: 8693,
            protocol: "tcp",
            external_port: 8693,
            address: `ai-limits-${String(params.id)}.app.uno4.dev`,
            kind: "app",
            app_name: "AI limits",
            configured: "private",
            effective: "private",
          },
        ],
        vpn: { installed: false, app_id: "wg-easy" },
        your_ip: "84.17.40.12",
      }),
    ),
  ];
}
