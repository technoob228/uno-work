import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsPatch,
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("defaults to an empty record so legacy configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
  });

  it("decodes a fully empty config (legacy on-disk shape) without complaint", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providerInstances).toEqual({});
    // Legacy `providers` struct is still hydrated with its per-driver defaults
    // so existing call sites keep working through the migration.
    expect(decoded.providers.codex.enabled).toBe(true);
  });

  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeServerSettings({
      providerInstances: {
        codex_personal: {
          driver: "codex",
          displayName: "Codex (personal)",
          config: { homePath: "~/.codex_personal" },
        },
        codex_work: {
          driver: "codex",
          config: { homePath: "~/.codex_work" },
        },
        ollama_local: {
          driver: "ollama",
          displayName: "Ollama (local)",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const personalId = ProviderInstanceId.make("codex_personal");
    const workId = ProviderInstanceId.make("codex_work");
    const ollamaId = ProviderInstanceId.make("ollama_local");

    expect(decoded.providerInstances[personalId]?.driver).toBe("codex");
    expect(decoded.providerInstances[workId]?.config).toEqual({ homePath: "~/.codex_work" });
    // Critical: a config naming a driver this build does not know about
    // (`ollama` is not in `ProviderDriverKind`) must round-trip without loss.
    // The runtime handles "driver not installed" — the schema must not.
    expect(decoded.providerInstances[ollamaId]?.driver).toBe("ollama");
    expect(decoded.providerInstances[ollamaId]?.config).toEqual({
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects instance keys that violate the slug pattern", () => {
    expect(() =>
      decodeServerSettings({
        providerInstances: { "1bad": { driver: "codex" } },
      }),
    ).toThrow();
  });
});

describe("ServerSettingsPatch.providerInstances", () => {
  it("treats providerInstances as an optional whole-map replacement", () => {
    const patch = decodeServerSettingsPatch({});
    expect(patch.providerInstances).toBeUndefined();

    const replacement = decodeServerSettingsPatch({
      providerInstances: {
        codex_personal: { driver: "codex", config: { homePath: "~/.codex" } },
      },
    });
    expect(replacement.providerInstances).toBeDefined();
    expect(replacement.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
  });

  it("preserves a fork-defined driver entry through patch decoding", () => {
    const patch = decodeServerSettingsPatch({
      providerInstances: {
        ollama_local: {
          driver: "ollama",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const ollamaId = ProviderInstanceId.make("ollama_local");
    expect(patch.providerInstances?.[ollamaId]?.driver).toBe("ollama");
  });
});

describe("ClientSettingsSchema.sidebarGroupLevels (0.0.138, additive)", () => {
  const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
  // 0.0.137's schema: the same struct without the new key.
  const { sidebarGroupLevels: _added, ...fields0137 } = ClientSettingsSchema.fields;
  const decodeClientSettings0137 = Schema.decodeUnknownSync(Schema.Struct(fields0137));

  it("reads settings saved before the key existed as null (not chosen yet)", () => {
    const decoded = decodeClientSettings({ sidebarInboxMode: true });
    expect(decoded.sidebarGroupLevels).toBeNull();
    expect(decoded.sidebarInboxMode).toBe(true);
    expect(DEFAULT_CLIENT_SETTINGS.sidebarGroupLevels).toBeNull();
  });

  it("round-trips a chosen grouping, one list included", () => {
    expect(
      decodeClientSettings({ sidebarGroupLevels: ["computer", "status"] }).sidebarGroupLevels,
    ).toEqual(["computer", "status"]);
    expect(decodeClientSettings({ sidebarGroupLevels: [] }).sidebarGroupLevels).toEqual([]);
  });

  it("lets 0.0.137 read settings written by 0.0.138 (the extra key is dropped)", () => {
    const written = Schema.encodeSync(ClientSettingsSchema)(
      decodeClientSettings({ sidebarInboxMode: true, sidebarGroupLevels: ["status"] }),
    );
    expect(written).toHaveProperty("sidebarGroupLevels", ["status"]);
    const read = decodeClientSettings0137(written);
    expect(read.sidebarInboxMode).toBe(true);
    expect(read).not.toHaveProperty("sidebarGroupLevels");
  });

  it("patches accept the key, null to reset", () => {
    const decodePatch = Schema.decodeUnknownSync(ClientSettingsPatch);
    expect(decodePatch({ sidebarGroupLevels: null })).toEqual({ sidebarGroupLevels: null });
    expect(decodePatch({ sidebarGroupLevels: ["project"] })).toEqual({
      sidebarGroupLevels: ["project"],
    });
  });
});
