// Проба WS-шима: имитирует кадры апстримного rc.115-клиента (числовые id).
const BASE = "http://127.0.0.1:13791";
const AT = process.env.AT;

const ticketRes = await fetch(`${BASE}/api/auth/websocket-ticket`, {
  method: "POST",
  headers: { authorization: `Bearer ${AT}` },
});
const { ticket } = await ticketRes.json();
console.log("ticket ok:", ticket.slice(0, 24) + "…");

const url = `ws://127.0.0.1:13791/ws?wsTicket=${encodeURIComponent(ticket)}&orchestrationProtocol=1&clientSurface=mobile&clientDeviceType=phone&connectionMethod=direct&clientOs=ios&clientAppVersion=0.0.42`;
const ws = new WebSocket(url);

const frames = [];
let done;
const finished = new Promise((r) => (done = r));

ws.onopen = () => {
  console.log("ws open");
  // как rc.115: счётчик с нуля, id — ЧИСЛО
  ws.send(JSON.stringify({ _tag: "Ping" }));
  ws.send(
    JSON.stringify({ _tag: "Request", id: 0, tag: "subscribeServerConfig", payload: {}, headers: [] }),
  );
  ws.send(
    JSON.stringify({ _tag: "Request", id: 1, tag: "server.probe", payload: {}, headers: [] }),
  );
  ws.send(
    JSON.stringify({
      _tag: "Request",
      id: 2,
      tag: "server.reportClientActivity",
      payload: { surface: "mobile", activeThreadId: null },
      headers: [],
    }),
  );
  ws.send(
    JSON.stringify({
      _tag: "Request",
      id: 3,
      tag: "orchestration.subscribeShell",
      // апстрим шлёт лишние поля — проверяем толерантность
      payload: { afterSequence: 0, requestCompletionMarker: true },
      headers: [],
    }),
  );
};

ws.onmessage = (ev) => {
  const frame = JSON.parse(ev.data);
  frames.push(frame);
  const rid = "requestId" in frame ? `rid=${JSON.stringify(frame.requestId)} (${typeof frame.requestId})` : "";
  const kind = frame.values?.[0]?.kind ?? frame.values?.[0]?.type ?? "";
  console.log(`<= ${frame._tag} ${rid} ${kind}`);
  if (frame._tag === "Defect") console.log("   DEFECT:", JSON.stringify(frame).slice(0, 300));
  if (frame._tag === "Exit" && frame.requestId === 1) {
    // probe завершился — ждём чуть-чуть хвост и выходим
    setTimeout(() => done(), 1500);
  }
};
ws.onerror = (e) => { console.log("ws error", e.message ?? e); done(); };
ws.onclose = (e) => { console.log("ws close", e.code, e.reason); done(); };

await finished;

const summary = {
  total: frames.length,
  numericRequestIds: frames.filter((f) => typeof f.requestId === "number").length,
  stringRequestIds: frames.filter((f) => typeof f.requestId === "string").length,
  defects: frames.filter((f) => f._tag === "Defect").length,
  pong: frames.some((f) => f._tag === "Pong"),
  serverConfigChunk: frames.some((f) => f._tag === "Chunk" && f.requestId === 0),
  probeExitOk: frames.some((f) => f._tag === "Exit" && f.requestId === 1 && f.exit?._tag === "Success"),
  activityExitOk: frames.some((f) => f._tag === "Exit" && f.requestId === 2 && f.exit?._tag === "Success"),
  shellSnapshotChunk: frames.some(
    (f) => f._tag === "Chunk" && f.requestId === 3 && f.values?.[0]?.kind === "snapshot",
  ),
};
console.log("SUMMARY", JSON.stringify(summary, null, 2));
ws.close();
process.exit(summary.defects === 0 && summary.serverConfigChunk && summary.shellSnapshotChunk ? 0 : 1);
