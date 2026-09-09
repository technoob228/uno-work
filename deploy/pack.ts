#!/usr/bin/env bun
/**
 * Packs the built server into the tarball `install.sh` downloads.
 *
 * Mirrors what `apps/server/scripts/cli.ts publish` does for npm — resolves
 * `catalog:` specs to concrete versions and drops devDependencies/scripts — but
 * writes a tarball we host ourselves instead of publishing to a registry.
 *
 *   bun deploy/pack.ts [--out dist-tarball]
 */
import { mkdirSync, rmSync, cpSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { resolveCatalogDependencies } from "../scripts/lib/resolve-catalog.ts";
import rootPackageJson from "../package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

const repoRoot = resolve(import.meta.dirname, "..");
const serverDir = join(repoRoot, "apps/server");
const outIndex = process.argv.indexOf("--out");
const outDir = resolve(repoRoot, outIndex === -1 ? "dist-tarball" : process.argv[outIndex + 1]!);

for (const asset of ["dist/bin.mjs", "dist/client/index.html"]) {
  if (!existsSync(join(serverDir, asset))) {
    throw new Error(
      `Missing build asset: ${asset}. Run \`bun run build\` in apps/web then apps/server.`,
    );
  }
}

const stageDir = join(outDir, "package");
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

cpSync(join(serverDir, "dist"), join(stageDir, "dist"), { recursive: true });
cpSync(join(repoRoot, "deploy"), join(stageDir, "deploy"), {
  recursive: true,
  filter: (source) => !source.endsWith("pack.ts"),
});

const version = serverPackageJson.version;
const manifest = {
  name: "uno-work-server",
  version,
  type: serverPackageJson.type,
  bin: { "uno-work": "./dist/bin.mjs" },
  engines: serverPackageJson.engines,
  files: ["dist", "deploy"],
  dependencies: resolveCatalogDependencies(
    serverPackageJson.dependencies,
    rootPackageJson.workspaces.catalog,
    "apps/server",
  ),
  overrides: resolveCatalogDependencies(
    rootPackageJson.overrides,
    rootPackageJson.workspaces.catalog,
    "apps/server",
  ),
};
writeFileSync(join(stageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const tarballName = `uno-work-server-${version}.tar.gz`;
execFileSync("tar", ["-czf", join(outDir, tarballName), "-C", outDir, "package"], {
  stdio: "inherit",
});
execFileSync("cp", [join(outDir, tarballName), join(outDir, "uno-work-server-latest.tar.gz")]);

const sha = execFileSync("shasum", ["-a", "256", join(outDir, tarballName)], { encoding: "utf8" })
  .trim()
  .split(/\s+/)[0]!;
writeFileSync(join(outDir, "SHA256SUMS"), `${sha}  ${tarballName}\n`);

console.log(`[pack] ${join(outDir, tarballName)}`);
console.log(`[pack] sha256 ${sha}`);
