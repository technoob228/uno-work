import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  type HermesHistoryRow,
  findDuplicatedToolCallRowIds,
  repairHermesSessionHistory,
} from "./hermesSessionRepair.ts";

const assistantRow = (id: number, toolCallIds: ReadonlyArray<string>): HermesHistoryRow => ({
  id,
  role: "assistant",
  toolCalls: JSON.stringify(toolCallIds.map((callId) => ({ id: callId, type: "function" }))),
  toolCallId: null,
});

const toolRow = (id: number, toolCallId: string): HermesHistoryRow => ({
  id,
  role: "tool",
  toolCalls: null,
  toolCallId,
});

const textRow = (id: number, role: string): HermesHistoryRow => ({
  id,
  role,
  toolCalls: null,
  toolCallId: null,
});

describe("findDuplicatedToolCallRowIds", () => {
  it("keeps a healthy history untouched", () => {
    const rows = [
      textRow(1, "user"),
      assistantRow(2, ["call_a"]),
      toolRow(3, "call_a"),
      assistantRow(4, ["call_b"]),
      toolRow(5, "call_b"),
    ];

    expect(findDuplicatedToolCallRowIds(rows)).toEqual([]);
  });

  it("archives a repeated tool-call row together with its trailing results", () => {
    const rows = [
      textRow(1, "user"),
      assistantRow(2, ["call_a"]),
      toolRow(3, "call_a"),
      // The crash re-persisted the same assistant row and its result.
      assistantRow(4, ["call_a"]),
      toolRow(5, "call_a"),
      textRow(6, "user"),
    ];

    expect(findDuplicatedToolCallRowIds(rows)).toEqual([4, 5]);
  });

  it("stops archiving at the first row that is not a matching tool result", () => {
    const rows = [
      assistantRow(1, ["call_a"]),
      toolRow(2, "call_a"),
      assistantRow(3, ["call_a"]),
      toolRow(4, "call_a"),
      assistantRow(5, ["call_b"]),
      toolRow(6, "call_b"),
    ];

    expect(findDuplicatedToolCallRowIds(rows)).toEqual([3, 4]);
  });

  it("treats a different tool-call id set as a legitimate new turn", () => {
    const rows = [
      assistantRow(1, ["call_a", "call_b"]),
      toolRow(2, "call_a"),
      toolRow(3, "call_b"),
      assistantRow(4, ["call_a", "call_c"]),
      toolRow(5, "call_a"),
    ];

    expect(findDuplicatedToolCallRowIds(rows)).toEqual([]);
  });

  it("ignores rows whose tool_calls payload is not the expected shape", () => {
    const rows: ReadonlyArray<HermesHistoryRow> = [
      { id: 1, role: "assistant", toolCalls: "not json", toolCallId: null },
      { id: 2, role: "assistant", toolCalls: "not json", toolCallId: null },
      { id: 3, role: "assistant", toolCalls: "[]", toolCallId: null },
      { id: 4, role: "assistant", toolCalls: "[]", toolCallId: null },
    ];

    expect(findDuplicatedToolCallRowIds(rows)).toEqual([]);
  });
});

describe("repairHermesSessionHistory", () => {
  const created: Array<string> = [];

  const makeHermesHome = (): string => {
    const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "hermes-repair-"));
    created.push(home);
    return home;
  };

  const seedStateDb = (home: string, rows: ReadonlyArray<HermesHistoryRow>): string => {
    const statePath = nodePath.join(home, "state.db");
    const database = new DatabaseSync(statePath);
    database.exec(
      "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, " +
        "role TEXT NOT NULL, tool_call_id TEXT, tool_calls TEXT, active INTEGER NOT NULL DEFAULT 1)",
    );
    const insert = database.prepare(
      "INSERT INTO messages (id, session_id, role, tool_call_id, tool_calls) VALUES (?, ?, ?, ?, ?)",
    );
    for (const row of rows)
      insert.run(row.id, "session-1", row.role, row.toolCallId, row.toolCalls);
    database.close();
    return statePath;
  };

  const readActiveIds = (statePath: string): ReadonlyArray<number> => {
    const database = new DatabaseSync(statePath, { readOnly: true });
    const ids = (
      database.prepare("SELECT id FROM messages WHERE active = 1 ORDER BY id").all() as Array<{
        readonly id: number;
      }>
    ).map((row) => row.id);
    database.close();
    return ids;
  };

  afterEach(() => {
    while (created.length > 0) {
      const home = created.pop();
      if (home !== undefined) nodeFs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns 0 when the session database does not exist yet", async () => {
    const archived = await Effect.runPromise(repairHermesSessionHistory(makeHermesHome()));
    expect(archived).toBe(0);
  });

  it("archives the duplicated rows and leaves the rest active", async () => {
    const home = makeHermesHome();
    const statePath = seedStateDb(home, [
      textRow(1, "user"),
      assistantRow(2, ["call_a"]),
      toolRow(3, "call_a"),
      assistantRow(4, ["call_a"]),
      toolRow(5, "call_a"),
    ]);

    const archived = await Effect.runPromise(repairHermesSessionHistory(home));

    expect(archived).toBe(2);
    expect(readActiveIds(statePath)).toEqual([1, 2, 3]);
    expect(nodeFs.existsSync(`${statePath}.pre-repair.bak`)).toBe(true);
  });

  it("leaves a healthy database alone and writes no backup", async () => {
    const home = makeHermesHome();
    const statePath = seedStateDb(home, [
      textRow(1, "user"),
      assistantRow(2, ["call_a"]),
      toolRow(3, "call_a"),
    ]);

    const archived = await Effect.runPromise(repairHermesSessionHistory(home));

    expect(archived).toBe(0);
    expect(readActiveIds(statePath)).toEqual([1, 2, 3]);
    expect(nodeFs.existsSync(`${statePath}.pre-repair.bak`)).toBe(false);
  });

  it("degrades to 0 when the file is not a hermes session database", async () => {
    const home = makeHermesHome();
    nodeFs.writeFileSync(nodePath.join(home, "state.db"), "not a database");

    const archived = await Effect.runPromise(repairHermesSessionHistory(home));

    expect(archived).toBe(0);
  });
});
