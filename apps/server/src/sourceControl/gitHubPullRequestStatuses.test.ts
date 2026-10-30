import { describe, expect, it } from "vitest";

import { buildStatusQuery, parseStatusResponse } from "./gitHubPullRequestStatuses.ts";

const node = (overrides: Record<string, unknown> = {}) => ({
  number: 12,
  title: "Fix login",
  url: "https://github.com/acme/app/pull/12",
  state: "OPEN",
  isDraft: false,
  headRefName: "fix/login",
  baseRefName: "main",
  isCrossRepository: false,
  updatedAt: "2026-10-30T09:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewDecision: "APPROVED",
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  ...overrides,
});

describe("buildStatusQuery", () => {
  it("asks for everything in one document and keeps branch names out of the query", () => {
    const { query, variables } = buildStatusQuery({
      repository: "acme/app",
      numbers: [12, 15],
      branches: ['evil") { x } #', "fix/login"],
    });
    expect(query).toContain("pr12: pullRequest(number: 12)");
    expect(query).toContain("pr15: pullRequest(number: 15)");
    expect(query).toContain("rateLimit { cost remaining limit resetAt }");
    expect(query).not.toContain("evil");
    expect(variables).toMatchObject({
      owner: "acme",
      name: "app",
      branch0: 'evil") { x } #',
      branch1: "fix/login",
    });
  });
});

describe("parseStatusResponse", () => {
  it("maps state, checks and review, and reads the budget", () => {
    const response = parseStatusResponse(
      JSON.stringify({
        data: {
          rateLimit: { cost: 1, remaining: 4900, limit: 5000, resetAt: "2026-10-30T11:00:00Z" },
          repository: { pr12: node() },
        },
      }),
      [],
    );
    expect(response).toMatchObject({
      ok: true,
      read: { budget: { remaining: 4900, limit: 5000, cost: 1 } },
    });
    if (!response.ok) throw new Error(response.detail);
    expect(response.read.byNumber.get(12)).toMatchObject({
      state: "open",
      checks: "passing",
      review: "approved",
      headRefName: "fix/login",
    });
  });

  it("gives branches their matches, in the order they were asked", () => {
    const response = parseStatusResponse(
      JSON.stringify({
        data: {
          repository: {
            branch0: { nodes: [] },
            branch1: {
              nodes: [node({ number: 3, state: "MERGED", mergedAt: "2026-10-30T09:00:00Z" })],
            },
          },
        },
      }),
      ["no-pr", "fix/login"],
    );
    if (!response.ok) throw new Error(response.detail);
    expect(response.read.byBranch.get("no-pr")).toEqual([]);
    expect(response.read.byBranch.get("fix/login")?.[0]).toMatchObject({
      number: 3,
      state: "merged",
    });
  });

  it("keeps the good part of a document when one number is gone", () => {
    const response = parseStatusResponse(
      JSON.stringify({
        data: { repository: { pr12: node(), pr99: null } },
        errors: [{ message: "Could not resolve to a PullRequest with the number of 99." }],
      }),
      [],
    );
    if (!response.ok) throw new Error(response.detail);
    expect([...response.read.byNumber.keys()]).toEqual([12]);
  });

  it("fails when GitHub sent no data at all", () => {
    expect(
      parseStatusResponse(JSON.stringify({ errors: [{ message: "API rate limit exceeded" }] }), []),
    ).toEqual({ ok: false, detail: "API rate limit exceeded" });
    expect(parseStatusResponse("gh: not json", [])).toMatchObject({ ok: false });
  });

  it("reads pending and failing checks", () => {
    const rollup = (state: string | null) => ({
      commits: { nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }] },
    });
    const response = parseStatusResponse(
      JSON.stringify({
        data: {
          repository: {
            pr1: node({ number: 1, ...rollup("PENDING") }),
            pr2: node({ number: 2, ...rollup("FAILURE") }),
            pr3: node({ number: 3, ...rollup(null) }),
          },
        },
      }),
      [],
    );
    if (!response.ok) throw new Error(response.detail);
    expect(response.read.byNumber.get(1)?.checks).toBe("pending");
    expect(response.read.byNumber.get(2)?.checks).toBe("failing");
    expect(response.read.byNumber.get(3)?.checks).toBe("none");
  });
});
