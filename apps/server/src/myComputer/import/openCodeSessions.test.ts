import { describe, expect, it } from "vitest";

import {
  openCodeDbCommand,
  parseSessionRow,
  parseSqlOutput,
  readOpenCodeHistory,
  readOpenCodeSchema,
  sessionsPageSql,
  shellQuote,
  sqlite3Command,
  type SqlRow,
} from "./openCodeSessions.ts";

const columns = (names: ReadonlyArray<string>) => names.map((name) => ({ name }));

describe("quoting", () => {
  it("survives quotes in both shells", () => {
    expect(shellQuote("posix", "it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("windows", "it's")).toBe(`'it''s'`);
  });

  it("builds read-only commands", () => {
    expect(sqlite3Command("posix", "/h/opencode.db", "SELECT 1")).toBe(
      "sqlite3 -readonly -json '/h/opencode.db' 'SELECT 1'",
    );
    expect(openCodeDbCommand("posix", "SELECT 1")).toBe("opencode db 'SELECT 1' --format json");
  });
});

describe("parseSqlOutput", () => {
  it("takes no output for no rows and refuses what isn't JSON", () => {
    expect(parseSqlOutput("")).toEqual([]);
    expect(parseSqlOutput('[{"id":1}]')).toEqual([{ id: 1 }]);
    expect(parseSqlOutput("Error: no such table")).toBeNull();
  });
});

describe("readOpenCodeSchema", () => {
  const known: Record<string, ReadonlyArray<string>> = {
    session: [
      "id",
      "directory",
      "title",
      "time_created",
      "time_updated",
      "parent_id",
      "time_archived",
    ],
    message: ["id", "session_id", "time_created", "time_updated", "data"],
    part: ["id", "message_id", "session_id", "time_created", "data"],
  };
  const run =
    (tables: Record<string, ReadonlyArray<string>>) =>
    async (sql: string): Promise<ReadonlyArray<SqlRow>> => {
      const table = /pragma_table_info\('(\w+)'\)/.exec(sql)?.[1] ?? "";
      return columns(tables[table] ?? []);
    };

  it("reads a schema it knows", async () => {
    expect(await readOpenCodeSchema(run(known))).toEqual({ hasParentId: true, hasArchived: true });
  });

  it("gives up on one it doesn't, like the dev branch's session_v2", async () => {
    expect(await readOpenCodeSchema(run({ session_v2: known.session! }))).toBeNull();
  });
});

describe("sessionsPageSql", () => {
  it("selects named columns of sessions a person would see, and no login table", () => {
    const sql = sessionsPageSql({ hasParentId: true, hasArchived: true }, 400);
    expect(sql).toContain("parent_id IS NULL");
    expect(sql).toContain("time_archived IS NULL");
    expect(sql).toContain("LIMIT 400 OFFSET 400");
    expect(sql).not.toMatch(/credential|account|\*/);
  });
});

describe("parseSessionRow", () => {
  const row = {
    id: "ses_abc123",
    directory: "/Users/test/projects/gamma",
    title: "Refactor the parser",
    time_created: 1_790_000_000_000,
    time_updated: 1_790_000_100_000,
  };

  it("reads a session", () => {
    expect(parseSessionRow(row)).toMatchObject({
      sessionId: "ses_abc123",
      title: "Refactor the parser",
      cwd: "/Users/test/projects/gamma",
      fingerprint: "1790000100000",
    });
  });

  it("drops OpenCode's placeholder title", () => {
    expect(parseSessionRow({ ...row, title: "New session - 2026-10-31T13:47" })?.title).toBeNull();
  });

  it("refuses an id that could leave the query, and a row without dates", () => {
    expect(parseSessionRow({ ...row, id: "ses_1' OR '1'='1" })).toBeNull();
    expect(parseSessionRow({ ...row, time_updated: null })).toBeNull();
  });
});

describe("readOpenCodeHistory", () => {
  it("joins text parts, in order, and asks only for text", async () => {
    const queries: Array<string> = [];
    const run = async (sql: string): Promise<ReadonlyArray<SqlRow>> => {
      queries.push(sql);
      if (sql.includes("FROM message")) {
        return [
          { id: "msg_2", time_created: 2000, role: "assistant" },
          { id: "msg_1", time_created: 1000, role: "user" },
        ];
      }
      return [
        { message_id: "msg_1", text: "Hello" },
        { message_id: "msg_2", text: "Hi." },
        { message_id: "msg_2", text: "How can I help?" },
      ];
    };
    const history = await readOpenCodeHistory(run, "ses_abc123");
    expect(history.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "Hello"],
      ["assistant", "Hi.\n\nHow can I help?"],
    ]);
    expect(queries.some((sql) => sql.includes("'$.type') = 'text'"))).toBe(true);
    expect(queries.join(" ")).not.toMatch(/credential|account/);
  });

  it("won't run anything for an id that isn't a session id", async () => {
    let asked = 0;
    const run = async () => {
      asked += 1;
      return [];
    };
    await readOpenCodeHistory(run, "x'; DROP TABLE session; --");
    expect(asked).toBe(0);
  });
});
