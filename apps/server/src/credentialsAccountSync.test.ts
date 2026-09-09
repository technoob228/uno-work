import { describe, expect, it } from "vitest";

import { decodeBundle, encodeBundle } from "./credentialsAccountSync.ts";
import type { CredentialsBundle } from "./credentialsVault.ts";

const bundle: CredentialsBundle = {
  version: 1,
  credentials: [
    {
      label: "github",
      url: "https://github.com",
      username: "mikhail",
      password: "s3cret",
      notes: "личный",
    },
    { label: "grafana", url: "https://grafana.example", username: "admin", password: "pw" },
  ],
};

describe("credentials account bundle", () => {
  it("round-trips through the account secret payload", () => {
    expect(decodeBundle(encodeBundle(bundle))).toEqual(bundle);
  });

  it("drops rows without url/username/password instead of failing the whole pull", () => {
    const decoded = decodeBundle(
      JSON.stringify({
        version: 1,
        credentials: [
          { url: "https://ok.example", username: "u", password: "p" },
          { url: "https://broken.example", username: "u" },
          "nonsense",
        ],
      }),
    );
    expect(decoded?.credentials.map((item) => item.url)).toEqual(["https://ok.example"]);
  });

  it("falls back to the url as a label when the snapshot has none", () => {
    const decoded = decodeBundle(
      JSON.stringify({ credentials: [{ url: "https://x.example", username: "u", password: "p" }] }),
    );
    expect(decoded?.credentials[0]?.label).toBe("https://x.example");
  });

  it("returns null for a snapshot that is not a credentials bundle", () => {
    expect(decodeBundle("not json")).toBeNull();
    expect(decodeBundle(JSON.stringify({ hello: "world" }))).toBeNull();
  });
});
