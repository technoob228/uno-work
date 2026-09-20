import { Layer } from "effect";
import { RpcSerialization } from "effect/unstable/rpc";

/**
 * Mobile-compat: JSON-сериализация RPC с коерсией request id.
 *
 * Наш сервер живёт на effect 4.0.0-beta.59, где id RPC-запроса на проводе —
 * строка (bigint.toString()), а входящий кадр с числовым id жёстко
 * отвергается ("Invalid request id"). Апстримный T3-клиент (мобилка из
 * сторов) собран на effect 4.0.0-rc.115, где id — number (счётчик 0,1,2…)
 * и уходит на провод числом; ответы сервера он матчит по СТРОГОМУ равенству
 * ключа в Map, так что наш строковый requestId в ответе он тоже не найдёт.
 *
 * Этот слой прозрачно чинит оба направления на границе сокета:
 *  -入 client→server: Request.id / Ack.requestId / Interrupt.requestId
 *    number → string; числовые id запоминаются per-connection;
 *  - 出 server→client: Chunk/Exit/Defect/Interrupt requestId string → number,
 *    только для запросов, пришедших с числовым id (наши обычные клиенты
 *    со строковыми id не затрагиваются). На Exit id забывается.
 *
 * makeUnsafe() у effect/rpc вызывается per-socket, поэтому Set числовых id
 * в замыкании не течёт между клиентами.
 */
export const jsonMobileCompat = RpcSerialization.RpcSerialization.of({
  contentType: "application/json",
  includesFraming: false,
  makeUnsafe: () => {
    const decoder = new TextDecoder();
    const numericIds = new Set<string>();

    const coerceIncoming = (message: unknown): unknown => {
      if (message === null || typeof message !== "object") return message;
      const frame = message as { _tag?: string; id?: unknown; requestId?: unknown };
      if (frame._tag === "Request" && typeof frame.id === "number") {
        const id = String(frame.id);
        numericIds.add(id);
        return { ...frame, id };
      }
      if (
        (frame._tag === "Ack" || frame._tag === "Interrupt") &&
        typeof frame.requestId === "number"
      ) {
        return { ...frame, requestId: String(frame.requestId) };
      }
      return message;
    };

    const coerceOutgoing = (message: unknown): unknown => {
      if (message === null || typeof message !== "object") return message;
      const frame = message as { _tag?: string; requestId?: unknown };
      if (typeof frame.requestId !== "string" || !numericIds.has(frame.requestId)) {
        return message;
      }
      if (frame._tag === "Exit") {
        numericIds.delete(frame.requestId);
      }
      return { ...frame, requestId: Number(frame.requestId) };
    };

    return {
      decode: (bytes) => {
        const parsed: unknown = JSON.parse(
          typeof bytes === "string" ? bytes : decoder.decode(bytes),
        );
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        return messages.map(coerceIncoming);
      },
      encode: (response) =>
        JSON.stringify(
          Array.isArray(response) ? response.map(coerceOutgoing) : coerceOutgoing(response),
        ),
    };
  },
});

export const layerJsonMobileCompat = Layer.succeed(
  RpcSerialization.RpcSerialization,
  jsonMobileCompat,
);
