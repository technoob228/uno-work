import { QueryClient } from "@tanstack/react-query";
import type { EnvironmentId, FilesEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { filesQueryKeys } from "./filesApi";
import { shouldPrefetch, statFromListings } from "./filesPrefetch";

const env = "env-1" as EnvironmentId;
function entry(name: string, patch: Partial<FilesEntry> = {}): FilesEntry {
  return {
    name,
    path: `/home/u/${name}`,
    kind: "file",
    size: 100,
    modifiedAt: "2026-10-16T20:00:00.000Z",
    hidden: false,
    isSymlink: false,
    ...patch,
  } as FilesEntry;
}

describe("statFromListings", () => {
  it("finds a file in any cached folder listing of the computer", () => {
    const client = new QueryClient();
    client.setQueryData(filesQueryKeys.list(env, "/home/u", false), {
      path: "/home/u",
      rootPath: "/home/u",
      parentPath: null,
      entries: [entry("a.md"), entry("docs", { kind: "directory" })],
    });
    expect(statFromListings(client, env, "/home/u/a.md")?.entry.name).toBe("a.md");
    expect(statFromListings(client, env, "/home/u/docs")).toBeNull();
    expect(statFromListings(client, env, "/home/u/none.md")).toBeNull();
    expect(statFromListings(client, null, "/home/u/a.md")).toBeNull();
  });
});

describe("shouldPrefetch", () => {
  it("reads ahead small text-like files only", () => {
    expect(shouldPrefetch(entry("a.md"))).toBe(true);
    expect(shouldPrefetch(entry("a.ts"))).toBe(true);
    expect(shouldPrefetch(entry("a.png"))).toBe(false);
    expect(shouldPrefetch(entry("big.log", { size: 5 * 1024 * 1024 }))).toBe(false);
    expect(shouldPrefetch(entry("docs", { kind: "directory" }))).toBe(false);
  });
});
