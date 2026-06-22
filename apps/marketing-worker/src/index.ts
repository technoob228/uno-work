interface Env {
  TG_BOT_TOKEN: string;
  TG_CHAT_ID: string;
}

const ALLOWED_ORIGINS = new Set([
  "https://uno4.work",
  "https://www.uno4.work",
  "http://localhost:4321",
  "http://localhost:4173",
]);

const HEADINGS: Record<string, string> = {
  sales: "Sales lead — Uno Work for business",
  "careers-builder": "Application — Builder / AI Product Manager",
  "careers-commerce": "Application — Commerce / BDM",
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get("Origin") ?? "";
    const cors = corsHeaders(origin);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(req.url);
    if (url.pathname !== "/lead") {
      return json({ error: "not_found" }, 404, cors);
    }
    if (req.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405, cors);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400, cors);
    }

    const payload = body as {
      type?: string;
      fields?: Record<string, unknown>;
    };

    const type = String(payload.type ?? "").trim();
    const fields = payload.fields;
    if (!type || !fields || typeof fields !== "object") {
      return json({ error: "missing_fields" }, 400, cors);
    }

    const heading = HEADINGS[type] ?? `Lead — ${type}`;
    const lines = [`<b>${escapeHtml(heading)}</b>`, ""];

    for (const [key, raw] of Object.entries(fields)) {
      if (raw === null || raw === undefined || raw === "") continue;
      const value = Array.isArray(raw) ? raw.map(String).filter(Boolean).join(", ") : String(raw);
      if (!value) continue;
      lines.push(`<b>${escapeHtml(prettyLabel(key))}:</b> ${escapeHtml(value)}`);
    }

    const tgRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TG_CHAT_ID,
        text: lines.join("\n"),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    const tgText = await tgRes.text();
    if (!tgRes.ok) {
      console.error("telegram_failed", tgRes.status, tgText);
      return json({ error: "telegram_failed" }, 502, cors);
    }

    try {
      const tgJson = JSON.parse(tgText) as {
        result?: { message_id?: number };
      };
      console.log(
        "telegram_ok",
        JSON.stringify({
          message_id: tgJson.result?.message_id,
        }),
      );
    } catch {
      console.log("telegram_ok_unparsed");
    }

    return json({ ok: true }, 200, cors);
  },
};

function corsHeaders(origin: string): Record<string, string> {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "https://uno4.work";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function prettyLabel(s: string): string {
  return s
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
