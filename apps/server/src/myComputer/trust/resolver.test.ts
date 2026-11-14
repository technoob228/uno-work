import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseResolverOutput, resolverCommand, type ResolveRequest } from "./resolver.ts";

const posix = process.platform !== "win32";
let root = "";

const run = (request: ResolveRequest, home = root) => {
  const out = execFileSync("/bin/sh", ["-c", resolverCommand(request)], {
    env: { ...process.env, HOME: home },
  }).toString();
  return parseResolverOutput(`login shell noise\n${out}`, request);
};

describe.runIf(posix)("resolver script (runs here in /bin/sh)", () => {
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uno-trust-")));
    fs.mkdirSync(path.join(root, "real/proj/pkg"), { recursive: true });
    fs.mkdirSync(path.join(root, "secret"), { recursive: true });
    fs.writeFileSync(path.join(root, "real/proj/package.json"), '{"workspaces":["pkg/*"]}');
    fs.writeFileSync(path.join(root, "real/proj/pkg/package.json"), '{"name":"x"}');
    fs.mkdirSync(path.join(root, "rust"));
    fs.writeFileSync(path.join(root, "rust/Cargo.toml"), "[workspace]\nmembers=[]\n");
    fs.symlinkSync("real/proj", path.join(root, "link"));
    fs.symlinkSync(path.join(root, "secret"), path.join(root, "real/proj/escape"));
    fs.symlinkSync("/nonexistent/far", path.join(root, "dangling"));
    fs.symlinkSync("loop2", path.join(root, "loop1"));
    fs.symlinkSync("loop1", path.join(root, "loop2"));
    fs.writeFileSync(path.join(root, "it's here"), "");
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("follows symlinks, also in the middle and through ..", () => {
    const req = {
      paths: [
        `${root}/link/pkg/package.json`,
        `${root}/link/../x`,
        `${root}/real/proj/escape/key`,
        `${root}/link/new/deeper/file.txt`,
      ],
      probes: [],
    };
    const facts = run(req)!;
    expect(facts.home).toBe(root);
    expect(facts.real.get(req.paths[0]!)).toBe(`${root}/real/proj/pkg/package.json`);
    // `..` taken physically: link -> real/proj, so link/.. is real/
    expect(facts.real.get(req.paths[1]!)).toBe(`${root}/real/x`);
    expect(facts.real.get(req.paths[2]!)).toBe(`${root}/secret/key`);
    expect(facts.real.get(req.paths[3]!)).toBe(`${root}/real/proj/new/deeper/file.txt`);
  });

  it("a dangling symlink resolves to where it points, a loop doesn't resolve", () => {
    const req = { paths: [`${root}/dangling`, `${root}/loop1`], probes: [] };
    const facts = run(req)!;
    expect(facts.real.get(`${root}/dangling`)).toBe("/nonexistent/far");
    expect(facts.real.get(`${root}/loop1`)).toBeNull();
  });

  it("expands ~ with the computer's home and survives quotes in names", () => {
    const req = { paths: ["~/link", `${root}/it's here`, "~"], probes: [] };
    const facts = run(req)!;
    expect(facts.real.get("~/link")).toBe(`${root}/real/proj`);
    expect(facts.real.get(`${root}/it's here`)).toBe(`${root}/it's here`);
    expect(facts.real.get("~")).toBe(root);
  });

  it("tells monorepo roots", () => {
    const req = {
      paths: [],
      probes: [`${root}/link`, `${root}/real/proj/pkg`, `${root}/rust`, `${root}/missing`],
    };
    const facts = run(req)!;
    expect(facts.monorepo.get(`${root}/link`)).toBe(true);
    expect(facts.monorepo.get(`${root}/real/proj/pkg`)).toBe(false);
    expect(facts.monorepo.get(`${root}/rust`)).toBe(true);
    expect(facts.monorepo.get(`${root}/missing`)).toBeNull();
  });

  it("a path argument can't inject commands", () => {
    const req = {
      paths: [`${root}/$(touch ${root}/pwned)`, `${root}/\`touch ${root}/pwned\``],
      probes: [],
    };
    run(req);
    expect(fs.existsSync(`${root}/pwned`)).toBe(false);
  });
});

describe("parseResolverOutput", () => {
  const req = { paths: ["/a", "/b"], probes: ["/c"] };
  it("no marker: no facts", () => {
    expect(parseResolverOutput("R:/a\nR:/b\nM1\n", req)).toBeNull();
  });
  it("missing lines read as unresolved", () => {
    const facts = parseResolverOutput("__uno_trust_v1__\nH:/Users/me\nR:/a\n", req)!;
    expect(facts.real.get("/a")).toBe("/a");
    expect(facts.real.get("/b")).toBeNull();
    expect(facts.monorepo.get("/c")).toBeNull();
  });
  it("control characters in paths are not sent", () => {
    const cmd = resolverCommand({ paths: ["/a\nR:/fake"], probes: [] });
    expect(cmd).not.toContain("R:/fake");
  });
});
