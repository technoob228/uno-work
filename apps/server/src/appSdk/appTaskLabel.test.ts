import { describe, expect, it } from "vitest";

import { hermesAppLabelEnvironment } from "../provider/acp/HermesAcpSupport.ts";
import { unoSessionEnvironment } from "../provider/Drivers/UnoDriver.ts";
import {
  APP_LABEL_HEADER,
  gatewayBaseUrlForApp,
  makeThreadAppLabels,
  withAppLabelHeaders,
} from "./appTaskLabel.ts";

const unoConfig = JSON.stringify({
  provider: {
    uno: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://gw/v1", apiKey: "{env:UNO_API_KEY}" },
    },
    "uno-russia": { options: { baseURL: "https://gw/v1/russia" } },
    "uno-personal": { options: { headers: { "X-Warm": "1" } } },
  },
  instructions: ["/x.md"],
});

describe("thread app labels", () => {
  it("knows only the threads the daemon labelled, and only valid app ids", () => {
    const labels = makeThreadAppLabels();
    labels.labelThread("t1", "translator");
    labels.labelThread("t2", "../evil");
    expect(labels.appOfThread("t1")).toBe("translator");
    expect(labels.appOfThread("t2")).toBeNull();
    expect(labels.appOfThread("t3")).toBeNull();
    expect(labels.appOfThread(undefined)).toBeNull();
  });
});

describe("withAppLabelHeaders", () => {
  it("adds X-Uno-App to the gateway providers only, keeping everything else", () => {
    const out = JSON.parse(withAppLabelHeaders(unoConfig, "digest", ["uno", "uno-russia"])!);
    expect(out.provider.uno.options).toMatchObject({
      baseURL: "https://gw/v1",
      apiKey: "{env:UNO_API_KEY}",
      headers: { [APP_LABEL_HEADER]: "digest" },
    });
    expect(out.provider["uno-russia"].options.headers).toEqual({ [APP_LABEL_HEADER]: "digest" });
    expect(out.provider["uno-personal"].options.headers).toEqual({ "X-Warm": "1" });
    expect(out.instructions).toEqual(["/x.md"]);
  });

  it("leaves broken or foreign configs and bad labels alone", () => {
    expect(withAppLabelHeaders("not json", "digest", ["uno"])).toBe("not json");
    expect(withAppLabelHeaders(unoConfig, "Bad Id", ["uno"])).toBe(unoConfig);
    expect(withAppLabelHeaders(JSON.stringify({ a: 1 }), "digest", ["uno"])).toBe('{"a":1}');
    expect(withAppLabelHeaders(undefined, "digest", ["uno"])).toBeUndefined();
  });
});

describe("harness session environments", () => {
  const bridge = { UNO_WORK_BROWSER_URL: "http://127.0.0.1:1" };

  it("Uno: an app thread gets the labelled config, any other thread only the bridge", () => {
    expect(unoSessionEnvironment({ bridge, configContent: unoConfig, appId: null })).toEqual(
      bridge,
    );
    const env = unoSessionEnvironment({ bridge, configContent: unoConfig, appId: "digest" });
    expect(env.UNO_WORK_BROWSER_URL).toBe(bridge.UNO_WORK_BROWSER_URL);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).provider.uno.options.headers).toEqual({
      [APP_LABEL_HEADER]: "digest",
    });
  });

  it("Hermes: an app thread's base URL carries the label", () => {
    expect(hermesAppLabelEnvironment(null)).toEqual({});
    expect(hermesAppLabelEnvironment("../x")).toEqual({});
    expect(hermesAppLabelEnvironment("digest").OPENAI_BASE_URL).toMatch(/\/v1\/apps\/digest$/);
    expect(gatewayBaseUrlForApp("https://gw/v1/", "a")).toBe("https://gw/v1/apps/a");
  });
});
