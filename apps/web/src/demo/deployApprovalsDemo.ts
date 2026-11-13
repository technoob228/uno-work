/**
 * The ops gate's deploy-window requests in the demo (deployApprovals/): one
 * waiting, one open window, one denied — and Deny / Close / Freeze change
 * them, as the console would. Only in the demo build; nothing leaves the page.
 */
import { HttpResponse, http } from "msw";

interface DemoRequest {
  id: number;
  machine: string;
  summary: string;
  minutes: number;
  status: "requested" | "approved" | "denied" | "closed";
  decided_by: string;
  expires_at: string | null;
  status_line: string;
  approve_url?: string;
}

const t0 = Date.now();
let frozen = false;
const requests: DemoRequest[] = [
  {
    id: 7,
    machine: "box-395",
    summary: "fishcode 6b6fe043 → прод: решения по окнам из Uno Work, миграция 295",
    minutes: 30,
    status: "requested",
    decided_by: "",
    expires_at: null,
    status_line: "⏳ ждёт решения",
    approve_url: "https://gate.uno4.work/r/7",
  },
  {
    id: 6,
    machine: "box-395",
    summary: "uno-work release 0.0.189 на app.uno4.work",
    minutes: 20,
    status: "approved",
    decided_by: "Миша",
    expires_at: new Date(t0 + 12 * 60_000).toISOString(),
    status_line: "✅ Открыто",
  },
  {
    id: 5,
    machine: "box-395",
    summary: "перезапуск консоли без причины",
    minutes: 10,
    status: "denied",
    decided_by: "Миша",
    expires_at: null,
    status_line: "❌ Отказано · в Uno Work",
  },
];

function inbox() {
  return HttpResponse.json({
    approver: true,
    frozen,
    web: true,
    passkeys: 1,
    requests: requests.map((q) => ({ ...q, via: "", created_at: new Date(t0).toISOString() })),
    now: new Date().toISOString(),
  });
}

function decide(id: number, from: DemoRequest["status"], to: DemoRequest["status"], line: string) {
  const q = requests.find((item) => item.id === id);
  if (!q || q.status !== from) {
    return HttpResponse.json({ ok: false, message: "Уже решено" }, { status: 409 });
  }
  q.status = to;
  q.status_line = line;
  delete q.approve_url;
  return HttpResponse.json({ ok: true, message: line, request: q });
}

export function deployApprovalHandlers() {
  return [
    http.get("*/_account/api/v1/ops-gate/inbox", () => inbox()),
    http.post("*/_account/api/v1/ops-gate/inbox/:id/deny", ({ params }) =>
      decide(Number(params.id), "requested", "denied", "❌ Отказано · в Uno Work"),
    ),
    http.post("*/_account/api/v1/ops-gate/inbox/:id/close", ({ params }) =>
      decide(Number(params.id), "approved", "closed", "⏹ Закрыто · в Uno Work"),
    ),
    http.post("*/_account/api/v1/ops-gate/inbox/freeze", () => {
      frozen = true;
      for (const q of requests) {
        if (q.status === "requested") q.status = "denied";
        if (q.status === "approved") q.status = "closed";
        q.status_line = "🧊 Заморожено";
      }
      return HttpResponse.json({ ok: true, message: "🧊 Заморожено" });
    }),
  ];
}
