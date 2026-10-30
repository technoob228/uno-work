/**
 * Files of the mock (w0138, points 4 and 8): what the panel reads when a
 * seeded tab opens (`filesystem.readFile`), and the share/upload answers the
 * ↗ menu needs (links from the computer, a copy in Cloud storage). Markdown
 * lives here as text; png/pdf/docx are real files in `public/demo-files/`.
 */
import { WS_METHODS } from "@t3tools/contracts";
import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";

import type { NormalizedWsRpcRequestBody } from "./rpcHarness";
import type { DemoMachine } from "./heavyFixtures";

const TEXT: Record<string, string> = {
  "README.md": `# landing

The new landing of Uno: **One place to build and deploy with AI**.

## Three flows
1. **A site in a minute** — write what you want, get a link.
2. **Card → server → it works** — your agent gets its own computer.
3. **Your team of agents** — Claude and Codex keep working while you sleep.

## Where things are
- \`pricing.md\` — the pricing section (by jobs, not by specs)
- \`hero.md\` — headline and the line under it
- \`assets/\` — screens of Uno Work for every step

Preview: \`npm run dev\` → http://localhost:5173
`,
  "pricing.md": `# Pricing

Pick by the job, not by the specs.

| Plan | For | Price |
|---|---|---|
| **One agent** | one agent working all day | $10 / month |
| **A team of agents** | 3–5 agents in parallel, sites and apps | $30 / month |
| **All night** | long runs, a server that never sleeps | $90 / month |

Specs go in a small line under each card: *4 vCPU · 8 GB · 80 GB* and so on.

> Every plan: a clean exit IP, Cloud storage, links that work while you sleep.

## FAQ
- **Can I bring my own Claude or Codex?** Yes — sign in inside Uno Work.
- **What if I stop paying?** Your computer sleeps; files stay for 30 days.
`,
  "hero.md": `# Hero

**One place to build and deploy with AI**

Your agent gets its own computer: code, sites and apps run there while you sleep.

[Start free] [See it work]

---
Variants: V1 calm (chosen), V2 dark, V3 warm — see \`hero-variants.png\`.
`,
  "flow-2.md": `# Flow 2 — card → server → it works

1. **Why a card.** "Your agent needs its own computer. It costs $10 a month — you can stop any time."
2. **Pay.** One screen, the card form, nothing else.
3. **It's ready.** "Your computer is on. Say what to build." — the chat opens on it.
4. **It works.** The agent deploys; you get a link.

_Draft — the agent is still writing step 4._
`,
  "competitors.md": `# Competitors — pricing pages

| Product | Starts at | Sells by |
|---|---|---|
| Replit | $20 | seats + usage |
| Lovable | $25 | messages |
| Railway | $5 | usage |
| Hetzner | €4 | specs |

What nobody says: **what happens at night**. That's ours.
`,
  "AGENTS.md": `# AGENTS.md

- Keep copy short: one sentence per step.
- Real screens of Uno Work only — no stock images.
- Ask before changing prices.
`,
};

const bar = (label: string, september: number, october: number) => `
  <div class="row"><span>${label}</span>
    <div class="bars">
      <i class="sep" style="width:${september}%"></i>
      <i class="oct" style="width:${october}%"></i>
    </div>
    <b>+${Math.round((october / september - 1) * 100)}%</b>
  </div>`;

/** The page of the showcase chat, stored as the daemon stores one. */
const DEMO_PAGE = injectHtmlRenderBootstrap(`<!doctype html><html><head><style>
.head{display:flex;gap:28px;margin-bottom:18px}
.head div{font-size:13px;color:var(--muted-foreground)}
.head strong{display:block;font-size:30px;font-weight:600;color:var(--foreground)}
.row{display:grid;grid-template-columns:110px 1fr 56px;gap:12px;align-items:center;margin:12px 0;font-size:14px}
.bars i{display:block;height:11px;border-radius:3px;margin:3px 0}
.sep{background:var(--border)}
.oct{background:var(--info)}
.row b{text-align:right;font-weight:600}
.key{display:flex;gap:16px;margin-top:14px;font-size:12px;color:var(--muted-foreground)}
.key i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}
</style></head><body>
<div class="head">
  <div><strong>$4,180</strong>Revenue in October</div>
  <div><strong>212</strong>New signups</div>
  <div><strong>18.4%</strong>Paid after the brief</div>
</div>
${bar("Signups", 58, 78)}${bar("Finished brief", 41, 66)}${bar("Paid", 32, 52)}
<div class="key"><span><i class="sep"></i>September</span><span><i class="oct"></i>October</span></div>
</body></html>`);

const DEMO_TEXT: Record<string, string> = {
  "demo-october-page.html": DEMO_PAGE,
  "launch-report.md": `# Launch report

Signups are up **18%** since the new form went live.

| Week | Signups | Welcome emails |
|---|---|---|
| 1 | 412 | 0 |
| 2 | 486 | 486 |

Next: send the thank-you page live and watch the blog links.
`,
  "index.html": `<!doctype html>
<html>
  <head><title>Landing</title><link rel="stylesheet" href="styles.css" /></head>
  <body><h1>One place to build and deploy with AI</h1><p>Start free</p></body>
</html>
`,
  "mail.ts": `export async function sendWelcomeEmail(to: string, data: { name: string }) {
  return mailer.send({ to, template: "welcome", data });
}
`,
};

const ASSETS: Record<string, string> = {
  "hero-variants.png": "image/png",
  "brand-guide.pdf": "application/pdf",
  "pricing-research.docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

async function readAsset(name: string, mimeType: string) {
  const response = await fetch(`${import.meta.env.BASE_URL}demo-files/${name}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return {
    content: btoa(binary),
    encoding: "base64",
    size: bytes.length,
    truncated: false,
    mimeType,
  };
}

function readFile(path: string) {
  const name = baseName(path);
  const mime = ASSETS[name];
  if (mime) return readAsset(name, mime);
  const text = TEXT[name] ?? DEMO_TEXT[name] ?? `# ${name}\n\nA file of the mock.\n`;
  return {
    content: text,
    encoding: "utf8",
    size: text.length,
    truncated: false,
    mimeType: "text/markdown",
  };
}

// ── The computer's files for the Files panel and the chat's file chips ──

/** Relative to the home folder. */
const DEMO_TREE = [
  "UnoWork/Reports/launch-report.md",
  "UnoWork/Reports/october-numbers.csv",
  "Documents/brief.docx",
  "Documents/meeting notes.md",
  "Downloads/hero-variants.png",
  "projects/landing/README.md",
  "projects/landing/AGENTS.md",
  "projects/landing/Dockerfile",
  "projects/landing/package.json",
  "projects/landing/pricing.md",
  "projects/landing/hero.md",
  "projects/landing/.env.example",
  "projects/landing/app/signup/page.tsx",
  "projects/landing/app/api/signup/route.ts",
  "projects/landing/app/api/signup/route.test.ts",
  "projects/landing/lib/mail.ts",
  "projects/landing/docs/launch-plan.md",
  "projects/landing/web/index.html",
  "projects/landing/web/styles.css",
];

function demoEntries(machine: DemoMachine) {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const entry = (path: string, kind: "file" | "directory") => ({
    name: baseName(path),
    path,
    kind,
    size: kind === "file" ? 2048 : 0,
    modifiedAt: at,
    hidden: baseName(path).startsWith("."),
    isSymlink: false,
  });
  const byPath = new Map<string, ReturnType<typeof entry>>();
  for (const relative of DEMO_TREE) {
    const parts = relative.split("/");
    parts.forEach((_, index) => {
      const path = `${machine.home}/${parts.slice(0, index + 1).join("/")}`;
      byPath.set(path, entry(path, index === parts.length - 1 ? "file" : "directory"));
    });
  }
  return [...byPath.values()];
}

/** What `files.list` shows for a folder of the tree; null for one it doesn't know. */
export function demoFolderEntries(machine: DemoMachine, folder: string) {
  const inside = demoEntries(machine).filter((entry) => {
    const slash = entry.path.lastIndexOf("/");
    return entry.path.slice(0, slash) === folder;
  });
  return inside.length > 0 ? inside : null;
}

function searchEntries(machine: DemoMachine, body: NormalizedWsRpcRequestBody) {
  const under = typeof body.path === "string" ? body.path : machine.home;
  const needle = String(body.query ?? "").toLowerCase();
  const entries = demoEntries(machine).filter(
    (entry) => entry.path.startsWith(`${under}/`) && entry.name.toLowerCase().includes(needle),
  );
  return { entries, truncated: false };
}

/** The computer's side of the chat's chips, as `fileMentions.ts` on the server decides. */
function resolveMentions(machine: DemoMachine, body: NormalizedWsRpcRequestBody) {
  const all = demoEntries(machine);
  const cwd = typeof body.cwd === "string" ? body.cwd : machine.home;
  const mentions = (body.mentions as string[] | undefined) ?? [];
  const find = (mention: string) => {
    const clean = mention.replace(/\/$/, "").replace(/^\.\//, "");
    const asWritten = clean.startsWith("~/")
      ? `${machine.home}/${clean.slice(2)}`
      : clean.startsWith("/")
        ? clean
        : `${cwd}/${clean}`;
    const direct = all.find((entry) => entry.path === asWritten);
    if (direct || clean.startsWith("~/") || clean.startsWith("/")) return direct;
    return all.find((entry) => entry.kind === "file" && entry.path.endsWith(`/${clean}`));
  };
  return {
    results: mentions.map((mention) => {
      const found = find(mention);
      return { mention, path: found?.path ?? null, kind: found?.kind ?? null };
    }),
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const token = () => Math.random().toString(36).slice(2, 12);

/** Links made from a computer in this session, per computer. */
const sharesByEnv = new Map<string, Array<Record<string, unknown>>>();

/**
 * Answers the RPC of files, links and Cloud storage, or `undefined` when the
 * request is not about them (demoBoot answers it then).
 */
export function answerFileRpc(machine: DemoMachine, body: NormalizedWsRpcRequestBody): unknown {
  switch (body._tag) {
    case WS_METHODS.filesystemReadFile:
      return readFile(String(body.path ?? ""));
    case WS_METHODS.filesSearch:
      return searchEntries(machine, body);
    case WS_METHODS.filesResolveMentions:
      return resolveMentions(machine, body);
    case WS_METHODS.filesShareList: {
      const shares = sharesByEnv.get(machine.environmentId) ?? [];
      const path = typeof body.path === "string" ? body.path : null;
      return { shares: path ? shares.filter((share) => share.path === path) : shares };
    }
    case WS_METHODS.filesShareCreate: {
      const path = String(body.path ?? "");
      const share = {
        id: `share-${token()}`,
        token: token(),
        path,
        name: baseName(path),
        kind: "file",
        createdAt: iso(0),
        expiresAt:
          typeof body.expiresInSeconds === "number" ? iso(body.expiresInSeconds * 1000) : null,
        revokedAt: null,
        hasPassword: typeof body.password === "string" && body.password.length > 0,
        access: typeof body.access === "string" ? body.access : "view",
        accessCount: 0,
        lastAccessedAt: null,
        urlPath: `/s/${token()}`,
      };
      sharesByEnv.set(machine.environmentId, [
        ...(sharesByEnv.get(machine.environmentId) ?? []),
        share,
      ]);
      return wait(500).then(() => share);
    }
    case WS_METHODS.filesShareRevoke: {
      const shares = sharesByEnv.get(machine.environmentId) ?? [];
      const share = shares.find((candidate) => candidate.id === body.id) ?? shares[0];
      sharesByEnv.set(
        machine.environmentId,
        shares.filter((candidate) => candidate !== share),
      );
      return { ...share, revokedAt: iso(0) };
    }
    case WS_METHODS.filesDriveState:
      return {
        available: true,
        message: null,
        bucketId: 7,
        usedBytes: 2_400_000_000,
        quotaBytes: 50_000_000_000,
        telegram: {
          sharedBot: "uno_drive_bot",
          sharedBotReady: true,
          ownBot: null,
          ownBotsAvailable: false,
          chats: [],
          downloadLimitBytes: 50_000_000,
        },
      };
    case WS_METHODS.filesCloudState:
      return {
        available: true,
        message: null,
        usedBytes: 2_400_000_000,
        quotaBytes: 50_000_000_000,
        overQuota: false,
        buckets: [{ id: 7, name: "my-files", usedBytes: 2_400_000_000 }],
      };
    case WS_METHODS.filesCloudCopyToCloud: {
      const paths = Array.isArray(body.paths) ? body.paths : [];
      // Long enough to see "Uploading to Cloud storage…".
      return wait(1800).then(() => ({
        files: paths.length,
        bytes: 18_432 * paths.length,
        skipped: [],
      }));
    }
    case WS_METHODS.filesEnsureSpace:
      return Promise.resolve({});
    case WS_METHODS.filesCloudUploadStep:
      return Promise.resolve({
        refusal: {
          status: null,
          message: "Files this big don't upload in the demo.",
          detail: "",
        },
      });
    case WS_METHODS.filesDriveShareCreate:
      return wait(500).then(() => ({
        id: Math.floor(Math.random() * 10_000),
        key: String(body.key ?? ""),
        url: `https://drive.uno4.me/s/${token()}`,
        expiresAt: iso(
          (typeof body.expiresInHours === "number" && body.expiresInHours > 0
            ? body.expiresInHours
            : 24 * 7) * 3_600_000,
        ),
        downloads: 0,
        createdVia: "app",
        createdAt: iso(0),
      }));
    default:
      return undefined;
  }
}
