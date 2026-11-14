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
import { mkdirSync, rmSync, cpSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
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

// node-pty, built once here (Misha 11.11): every machine used to compile it with
// node-gyp during an update (~1.3 GB of memory), and on a 2 GB computer with a
// live assistant earlyoom killed the compiler: "couldn't be installed. Nothing
// changed". On a linux-x64 pack the package goes into the tarball as a local
// npm package with prebuilds/linux-x64/pty.node (N-API, glibc >= 2.34 — the
// symbols it imports), so its install script finds the prebuild and skips
// node-gyp. install.sh checks it loads and rebuilds from source if it doesn't.
// Packed anywhere else (a Mac): the machine compiles it as before.
const prebuiltNodePty = packPrebuiltNodePty();
if (prebuiltNodePty) {
  manifest.dependencies["node-pty"] = `file:${prebuiltNodePty}`;
  manifest.files.push("prebuilt");
}
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

function packPrebuiltNodePty(): string | null {
  if (process.platform !== "linux" || process.arch !== "x64") return null;
  const require = createRequire(join(serverDir, "package.json"));
  const ptyDir = dirname(require.resolve("node-pty/package.json"));
  const built = join(ptyDir, "build", "Release", "pty.node");
  if (!existsSync(built)) {
    // An install that skipped lifecycle scripts (a reused node_modules, as on
    // the work-build box): build it here once, the way its install script would.
    try {
      execFileSync("npx", ["--yes", "node-gyp", "rebuild"], { cwd: ptyDir, stdio: "inherit" });
    } catch (cause) {
      console.log(`[pack] node-pty: couldn't build ${built} (${String(cause)}), machines compile it`);
    }
  }
  if (!existsSync(built)) {
    console.log(`[pack] node-pty: no ${built}, machines compile it`);
    return null;
  }
  const ptyPackage = JSON.parse(readFileSync(join(ptyDir, "package.json"), "utf8")) as {
    version: string;
    files?: string[];
  };
  const work = join(outDir, "node-pty-prebuilt");
  const pkg = join(work, "package");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(pkg, { recursive: true });
  // What npm would publish (package.json "files"), minus the other platforms'
  // prebuilds; src/deps/binding.gyp stay for the rebuild-from-source fallback.
  for (const entry of ["package.json", "LICENSE", "README.md", ...(ptyPackage.files ?? [])]) {
    const name = entry.replace(/\/$/, "");
    if (name === "prebuilds" || !existsSync(join(ptyDir, name))) continue;
    cpSync(join(ptyDir, name), join(pkg, name), { recursive: true });
  }
  mkdirSync(join(pkg, "prebuilds", "linux-x64"), { recursive: true });
  cpSync(built, join(pkg, "prebuilds", "linux-x64", "pty.node"));
  const name = `node-pty-${ptyPackage.version}-linux-x64.tgz`;
  mkdirSync(join(stageDir, "prebuilt"), { recursive: true });
  execFileSync("tar", ["-czf", join(stageDir, "prebuilt", name), "-C", work, "package"], {
    stdio: "inherit",
  });
  rmSync(work, { recursive: true, force: true });
  const spec = relative(stageDir, join(stageDir, "prebuilt", name));
  console.log(`[pack] node-pty ${ptyPackage.version}: prebuilt linux-x64 → ${spec}`);
  return spec;
}
