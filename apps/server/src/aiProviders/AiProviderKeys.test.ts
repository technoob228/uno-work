import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import {
  fetchProviderModels,
  makeAiProviderKeys,
  resolveProviderBaseUrl,
  secretNameForProvider,
} from "./AiProviderKeys.ts";

const SECRET = "xai-SECRET-abcdefghijklmnop-9876";

function makeStore() {
  const memory = new Map<string, Uint8Array>();
  return {
    memory,
    layer: {
      get: (name: string) => Effect.succeed(memory.get(name) ?? null),
      set: (name: string, value: Uint8Array) => Effect.sync(() => void memory.set(name, value)),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: (name: string) => Effect.sync(() => void memory.delete(name)),
    },
  };
}

function run<A, E>(
  store: ReturnType<typeof makeStore>,
  body: (keys: Effect.Success<ReturnType<typeof makeAiProviderKeys>>) => Effect.Effect<A, E>,
  fetchImpl?: typeof fetch,
) {
  return Effect.runPromise(
    makeAiProviderKeys(fetchImpl ? { fetchImpl } : undefined).pipe(
      Effect.flatMap(body),
      Effect.provideService(ServerSecretStore, store.layer),
    ),
  );
}

const modelsResponse = (ids: ReadonlyArray<string>) =>
  new Response(JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("AiProviderKeys", () => {
  it("stores a key in the secret store and only ever shows its last four characters", async () => {
    const store = makeStore();
    const summary = await run(store, (keys) => keys.set({ provider: "xai", apiKey: SECRET }));
    expect(summary).toMatchObject({
      provider: "xai",
      configured: true,
      keyHint: "9876",
      baseUrl: "https://api.x.ai/v1",
    });
    expect(store.memory.has(secretNameForProvider("xai"))).toBe(true);
    const list = await run(store, (keys) => keys.list());
    expect(JSON.stringify(list)).not.toContain(SECRET);
    expect(list.find((entry) => entry.provider === "openai")?.configured).toBe(false);
    expect(await run(store, (keys) => keys.resolve("xai"))).toEqual({
      apiKey: SECRET,
      baseUrl: "https://api.x.ai/v1",
    });
  });

  it("needs an http(s) base URL for a custom provider", async () => {
    const store = makeStore();
    await expect(
      run(store, (keys) => keys.set({ provider: "custom", apiKey: SECRET })),
    ).rejects.toMatchObject({ status: 400 });
    const summary = await run(store, (keys) =>
      keys.set({ provider: "custom", apiKey: SECRET, baseUrl: "https://llm.example.com/v1/" }),
    );
    expect(summary.baseUrl).toBe("https://llm.example.com/v1");
    expect(resolveProviderBaseUrl("custom", "ftp://x")).toBeNull();
    expect(resolveProviderBaseUrl("custom", "https://user:pw@x.dev/v1")).toBeNull();
  });

  it("removes a key", async () => {
    const store = makeStore();
    await run(store, (keys) => keys.set({ provider: "openai", apiKey: SECRET }));
    await run(store, (keys) => keys.remove("openai"));
    expect(await run(store, (keys) => keys.resolve("openai"))).toBeNull();
  });

  it("tests a key against /models with its own base URL", async () => {
    const store = makeStore();
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        auth: new Headers(init?.headers).get("authorization"),
      });
      return modelsResponse(["grok-4.7", "grok-4.20"]);
    }) as unknown as typeof fetch;
    await run(store, (keys) => keys.set({ provider: "xai", apiKey: SECRET }));
    const result = await run(store, (keys) => keys.test({ provider: "xai" }), fetchImpl);
    expect(result).toEqual({ ok: true, modelCount: 2, error: null });
    expect(calls[0]).toEqual({ url: "https://api.x.ai/v1/models", auth: `Bearer ${SECRET}` });
  });

  it("reports a rejected key without echoing it", async () => {
    const store = makeStore();
    const fetchImpl = (async () =>
      new Response(`{"error":"bad key ${SECRET}"}`, { status: 401 })) as unknown as typeof fetch;
    const result = await run(
      store,
      (keys) => keys.test({ provider: "openrouter", apiKey: SECRET }),
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("rejected the key (401)");
    expect(result.error).not.toContain(SECRET);
  });

  it("asks for a key when there is nothing to test", async () => {
    const result = await run(makeStore(), (keys) => keys.test({ provider: "openai" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No key");
  });
});

describe("fetchProviderModels", () => {
  it("reads OpenAI's list and a bare array, naming models by display_name", async () => {
    const withData = await fetchProviderModels({
      baseUrl: "https://x/v1",
      apiKey: "k",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ data: [{ id: "a", display_name: "Model A" }, { id: "a" }, { id: "" }] }),
        )) as unknown as typeof fetch,
    });
    expect(withData).toEqual({ ok: true, models: [{ id: "a", name: "Model A" }] });
    const bare = await fetchProviderModels({
      baseUrl: "https://x/v1",
      apiKey: "k",
      fetchImpl: (async () =>
        new Response(JSON.stringify([{ id: "b" }]))) as unknown as typeof fetch,
    });
    expect(bare).toEqual({ ok: true, models: [{ id: "b", name: "b" }] });
  });

  it("explains an unreachable host", async () => {
    const result = await fetchProviderModels({
      baseUrl: "https://x/v1",
      apiKey: "k",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({
      ok: false,
      error: "Could not reach the provider — check the base URL and the network.",
    });
  });
});
