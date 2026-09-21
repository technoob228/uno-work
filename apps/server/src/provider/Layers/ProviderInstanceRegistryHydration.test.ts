import { OpenCodeSettings, ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import { Equal, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const settingsWith = (input: unknown = {}) => Schema.decodeUnknownSync(ServerSettings)(input);

const configOf = (entry: { readonly config?: unknown } | undefined): Record<string, unknown> =>
  (entry?.config ?? {}) as Record<string, unknown>;

const UNO_ID = ProviderInstanceId.make("uno");
const CODEX_ID = ProviderInstanceId.make("codex");

describe("deriveProviderInstanceConfigMap — uno gateway key fingerprint", () => {
  it("stamps the uno envelope with the account key fingerprint", () => {
    const map = deriveProviderInstanceConfigMap(
      settingsWith({ uno: { apiKey: "uno_usr_abcd1234" } }),
    );

    expect(configOf(map[UNO_ID]).unoGatewayKeyFingerprint).toBe("1234");
    // Only the uno envelope carries the stamp — a key change must not churn
    // the other drivers' instances.
    expect(configOf(map[CODEX_ID]).unoGatewayKeyFingerprint).toBeUndefined();
  });

  it("stamps an empty fingerprint when no key is configured", () => {
    const map = deriveProviderInstanceConfigMap(settingsWith({}));

    expect(configOf(map[UNO_ID]).unoGatewayKeyFingerprint).toBe("");
  });

  it("keeps the envelope stable while the key does not change", () => {
    const a = deriveProviderInstanceConfigMap(settingsWith({ uno: { apiKey: "unollm_box_key1" } }));
    const b = deriveProviderInstanceConfigMap(settingsWith({ uno: { apiKey: "unollm_box_key1" } }));

    // Same equality the registry's reconcile uses: an unchanged key must be
    // a no-op (no instance teardown).
    expect(Equal.equals(a[UNO_ID], b[UNO_ID])).toBe(true);
  });

  it("changes only the uno envelope when the key appears after startup", () => {
    const before = deriveProviderInstanceConfigMap(settingsWith({}));
    const after = deriveProviderInstanceConfigMap(
      settingsWith({ uno: { apiKey: "unollm_box_key1" } }),
    );

    // The console writes the gateway key into settings.json after the daemon
    // is already running (fishcode work_llm_key.go). Reconcile must rebuild
    // exactly the uno instance so it refetches the model catalog with the
    // key — and must leave every other instance alone.
    expect(Equal.equals(before[UNO_ID], after[UNO_ID])).toBe(false);
    expect(Equal.equals(before[CODEX_ID], after[CODEX_ID])).toBe(true);
  });

  it("stamps explicit providerInstances uno entries too", () => {
    const map = deriveProviderInstanceConfigMap(
      settingsWith({
        uno: { apiKey: "uno_usr_abcd9999" },
        providerInstances: {
          uno: { driver: "uno", config: { binaryPath: "/custom/uno-code" } },
        },
      }),
    );

    const config = configOf(map[UNO_ID]);
    expect(config.binaryPath).toBe("/custom/uno-code");
    expect(config.unoGatewayKeyFingerprint).toBe("9999");
  });

  it("keeps the stamped config decodable by the uno driver's schema", () => {
    const map = deriveProviderInstanceConfigMap(
      settingsWith({ uno: { apiKey: "uno_usr_abcd1234" } }),
    );

    // The registry pipes the envelope config through `driver.configSchema`
    // (OpenCodeSettings for UnoDriver); the stamp must be ignored as an
    // excess property, not turn the instance into an "unavailable" shadow.
    const decoded = Schema.decodeUnknownSync(OpenCodeSettings)(map[UNO_ID]?.config);
    expect(decoded.enabled).toBe(true);
  });
});
