import type * as Http from "node:http";
import type * as Net from "node:net";

/**
 * Стартовый шлюз HTTP-сервера демона.
 *
 * `@effect/platform-node` делает `server.listen()` при сборке слоя, а
 * обработчики `request`/`upgrade` вешает только в `serve()` — после того как
 * собраны ВСЕ сервисы демона. На 1 vCPU это 20+ секунд. Всё, что приходит в
 * это окно, Node принимает и не отвечает никогда: у `request` нет слушателя.
 * nginx на ноде держит такой запрос до `proxy_read_timeout` (час), и человек,
 * впервые открывший свою машину, смотрит на белый лист, пока не перезагрузит
 * страницу (замер 21.09: первый запрос к свежему боксу 30+ с без единого
 * байта, в браузере — 6+ минут).
 *
 * Шлюз вешается сразу после создания сервера и до подключения роутера
 * отвечает сам:
 * - навигация браузера → брендированная страница «Starting your computer…»,
 *   которая опрашивает {@link STARTUP_STATUS_PATH} и перезагружается, как
 *   только отвечает настоящий роутер (hash `/pair#token=…` переживает reload);
 * - прочие запросы → 503 + `Retry-After`;
 * - WebSocket upgrade → 503 и закрытие сокета (без слушателя Node молча
 *   рвёт сокет, клиент видит это как обрыв без причины).
 *
 * Как только кто-то другой подписывается на `request` (это `serve()`), шлюз
 * снимает свои слушатели и больше не участвует.
 */

export const STARTUP_STATUS_PATH = "/__uno/startup";
/** Заголовок, по которому страница отличает ответ шлюза от настоящего роутера. */
export const STARTUP_GATE_HEADER = "x-uno-work-starting";

export interface StartupGateHandle {
  /** Снят ли шлюз (роутер подключён или вызван `release`). */
  readonly released: () => boolean;
  /** Снять шлюз вручную (например, если сервер закрывается). */
  readonly release: () => void;
}

export interface StartupGateOptions {
  /** Секунд с начала старта процесса — для честного таймера на странице. */
  readonly uptimeSeconds?: () => number;
}

function wantsHtml(req: Http.IncomingMessage): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const dest = req.headers["sec-fetch-dest"];
  if (dest === "document" || dest === "iframe") return true;
  const accept = req.headers.accept ?? "";
  return accept.includes("text/html");
}

function pathOf(req: Http.IncomingMessage): string {
  const url = req.url ?? "/";
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

const COMMON_HEADERS = {
  "cache-control": "no-store, max-age=0",
  "retry-after": "2",
  [STARTUP_GATE_HEADER]: "1",
} as const;

export function startupStatusBody(uptimeSeconds: number): string {
  return JSON.stringify({
    starting: true,
    phase: "daemon",
    uptimeSeconds: Math.max(0, Math.round(uptimeSeconds)),
  });
}

export function handleStartupRequest(
  req: Http.IncomingMessage,
  res: Http.ServerResponse,
  uptimeSeconds: number,
): void {
  // Тело запроса не нужно, но его надо дочитать, иначе keep-alive залипнет.
  req.resume();
  const path = pathOf(req);
  if (path === STARTUP_STATUS_PATH) {
    res.writeHead(503, { ...COMMON_HEADERS, "content-type": "application/json; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : startupStatusBody(uptimeSeconds));
    return;
  }
  if (wantsHtml(req)) {
    // 503, а не 200: страницу никто не должен закэшировать как ответ маршрута.
    res.writeHead(503, { ...COMMON_HEADERS, "content-type": "text/html; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : STARTING_PAGE_HTML);
    return;
  }
  res.writeHead(503, { ...COMMON_HEADERS, "content-type": "application/json; charset=utf-8" });
  res.end(
    req.method === "HEAD"
      ? undefined
      : JSON.stringify({ error: "starting", detail: "Uno Work is starting, retry shortly" }),
  );
}

export function rejectStartupUpgrade(socket: Net.Socket): void {
  if (socket.destroyed) return;
  socket.end(
    "HTTP/1.1 503 Service Unavailable\r\n" +
      "Retry-After: 2\r\n" +
      `${STARTUP_GATE_HEADER}: 1\r\n` +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n\r\n",
  );
}

export function installStartupGate(
  server: Http.Server,
  options: StartupGateOptions = {},
): StartupGateHandle {
  const uptime = options.uptimeSeconds ?? (() => process.uptime());
  let released = false;

  const onRequest = (req: Http.IncomingMessage, res: Http.ServerResponse) => {
    // Роутер уже подключён (в том же тике, до снятия шлюза) — отвечает он.
    if (released || server.listenerCount("request") > 1) return;
    handleStartupRequest(req, res, uptime());
  };
  const onUpgrade = (_req: Http.IncomingMessage, socket: Net.Socket) => {
    if (released || server.listenerCount("upgrade") > 1) return;
    rejectStartupUpgrade(socket);
  };

  const release = () => {
    if (released) return;
    released = true;
    server.off("request", onRequest);
    server.off("upgrade", onUpgrade);
    server.off("newListener", onNewListener);
  };

  // `newListener` приходит ДО добавления слушателя; снимаемся на следующем
  // тике, а до тех пор проверка listenerCount пропускает запросы к роутеру.
  function onNewListener(event: string | symbol, listener: unknown) {
    if (event === "request" && listener !== onRequest) {
      setImmediate(release);
    }
  }

  server.on("request", onRequest);
  server.on("upgrade", onUpgrade);
  server.on("newListener", onNewListener);
  server.once("close", release);

  return { released: () => released, release };
}

/**
 * Страница ожидания. Самодостаточная: ни одного внешнего ресурса (ассеты SPA
 * отдаёт роутер, которого ещё нет), марка Uno — инлайном, как в
 * `apps/web/public/uno-mark.svg`. Цвета — те же, что у boot-shell в index.html.
 */
export const STARTING_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#161616" media="(prefers-color-scheme: dark)" />
<title>Starting your computer… · Uno Work</title>
<style>
  :root { color-scheme: light dark; --bg:#ffffff; --fg:#262626; --muted:#737373; --line:#e5e5e5; --accent:#5b5be8; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161616; --fg:#f5f5f5; --muted:#a3a3a3; --line:#2a2a2a; --accent:#8c8cff; } }
  html, body { height:100%; margin:0; background:var(--bg); color:var(--fg);
    font-family:"DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  main { min-height:100%; display:flex; align-items:center; justify-content:center; padding:24px; box-sizing:border-box; }
  .card { width:100%; max-width:360px; }
  .mark { width:48px; height:48px; display:block; margin-bottom:24px; animation:pulse 1.8s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:.55 } }
  @media (prefers-reduced-motion: reduce) { .mark, .spin { animation:none } }
  h1 { font-size:22px; font-weight:600; margin:0 0 6px; letter-spacing:-.01em; }
  p.lead { margin:0 0 24px; color:var(--muted); font-size:15px; line-height:1.45; }
  ol { list-style:none; margin:0; padding:0; border-top:1px solid var(--line); }
  li { display:flex; align-items:center; gap:12px; padding:12px 0; border-bottom:1px solid var(--line); font-size:15px; }
  li .dot { width:18px; height:18px; flex:none; border-radius:50%; box-sizing:border-box; display:flex; align-items:center; justify-content:center; }
  li.done .dot { background:var(--accent); }
  li.done .dot::after { content:""; width:5px; height:9px; border:solid #fff; border-width:0 2px 2px 0; transform:translateY(-1px) rotate(45deg); }
  li.now .dot { border:2px solid var(--line); border-top-color:var(--accent); }
  li.now .spin { animation:spin .9s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg) } }
  li.todo { color:var(--muted); }
  li.todo .dot { border:2px solid var(--line); }
  li .t { margin-left:auto; color:var(--muted); font-variant-numeric:tabular-nums; font-size:13px; }
  .slow { display:none; margin-top:20px; font-size:14px; line-height:1.45; color:var(--muted); }
  .slow.on { display:block; }
  button { font:inherit; font-size:14px; margin-top:12px; padding:8px 14px; border-radius:8px; border:1px solid var(--line); background:transparent; color:var(--fg); cursor:pointer; }
</style>
</head>
<body>
<main>
  <div class="card" role="status" aria-live="polite">
    <svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b5be8"/><stop offset="1" stop-color="#8c8cff"/></linearGradient></defs><rect width="32" height="32" rx="7" fill="url(#g)"/><path d="M10.6 9.5h3v9.1c0 1.5 1.1 2.5 2.4 2.5s2.4-1 2.4-2.5V9.5h3v9.1c0 3.2-2.4 5.4-5.4 5.4s-5.4-2.2-5.4-5.4z" fill="#fff"/></svg>
    <h1>Starting your computer…</h1>
    <p class="lead">Your machine just turned on. This usually takes a few seconds — the page opens by itself.</p>
    <ol>
      <li class="done"><span class="dot"></span>Machine is on</li>
      <li class="now" id="s-app"><span class="dot spin"></span>Starting Uno Work<span class="t" id="t"></span></li>
      <li class="todo" id="s-open"><span class="dot"></span>Opening your workspace</li>
    </ol>
    <div class="slow" id="slow">This is taking longer than usual. We keep trying — you can also reload the page.<br /><button type="button" onclick="location.reload()">Reload</button></div>
  </div>
</main>
<script>
(function () {
  var started = Date.now(), base = null, done = false;
  var t = document.getElementById("t"), slow = document.getElementById("slow");
  function tick() {
    var s = Math.round((Date.now() - started) / 1000) + (base || 0);
    t.textContent = s + "s";
    if (Date.now() - started > 60000) slow.className = "slow on";
  }
  function ready() {
    if (done) return; done = true;
    document.getElementById("s-app").className = "done";
    document.getElementById("s-app").firstChild.className = "dot";
    document.getElementById("s-open").className = "now";
    document.getElementById("s-open").firstChild.className = "dot spin";
    location.reload();
  }
  function poll() {
    fetch("${STARTUP_STATUS_PATH}", { cache: "no-store", credentials: "same-origin" }).then(function (r) {
      if (!r.headers.get("${STARTUP_GATE_HEADER}") && r.status < 500) return ready();
      if (r.headers.get("${STARTUP_GATE_HEADER}")) {
        return r.json().then(function (j) { if (base === null && j && typeof j.uptimeSeconds === "number") { base = j.uptimeSeconds; started = Date.now(); } });
      }
    }).catch(function () {}).then(function () { if (!done) setTimeout(poll, 1000); });
  }
  setInterval(tick, 500); tick(); setTimeout(poll, 700);
})();
</script>
</body>
</html>`;
