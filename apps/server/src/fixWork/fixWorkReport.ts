/**
 * What Fix Work shows the agent and support, cleaned. The chat's own masking
 * (secretRedaction.ts) knows token prefixes and the daemon's known secrets; a
 * letter leaves the computer, so it also drops anything set next to a word like
 * "password" and long opaque strings.
 */
import { redactSecretsInText, REDACTED } from "../secretRedaction.ts";

const SECRET_NAME = String.raw`[\w.-]*(?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|apikey|credential|private[_-]?key|authorization|cookie|session)[\w.-]*`;

const RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly keep: (groups: ReadonlyArray<string>) => string;
}> = [
  // A header's whole value: "Bearer abc", or a cookie's "a=1; b=2".
  {
    pattern: /\b((?:proxy-)?authorization\s*[:=]\s*|(?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi,
    keep: ([name = ""]) => `${name}${REDACTED}`,
  },
  {
    pattern: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    keep: ([scheme = ""]) => `${scheme} ${REDACTED}`,
  },
  // NAME=value, "name": "value", name: value.
  {
    pattern: new RegExp(
      String.raw`(["']?\b${SECRET_NAME}["']?\s*[:=]\s*)(["']?)(?!\[redacted\])[^\s"',;]{4,}\2`,
      "gi",
    ),
    keep: ([name = ""]) => `${name}${REDACTED}`,
  },
  // user:password@host in an address.
  {
    pattern: /(\/\/[^/\s:@]+:)[^/\s@]+@/g,
    keep: ([user = ""]) => `${user}${REDACTED}@`,
  },
  // JWT; cloud keys the token list doesn't name; a PEM block, whole.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
    keep: () => REDACTED,
  },
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, keep: () => REDACTED },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, keep: () => REDACTED },
  { pattern: /\bAIza[A-Za-z0-9_-]{30,}/g, keep: () => REDACTED },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, keep: () => REDACTED },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    keep: () => REDACTED,
  },
  // A long run of hex or base64 with no meaning to a reader. Git hashes (40 hex) stay.
  {
    pattern:
      /(?<![\w/.-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{44,}={0,2}/g,
    keep: () => REDACTED,
  },
];

export function redactForSupport(text: string): { readonly text: string; readonly count: number } {
  const known = redactSecretsInText(text);
  let count = known === text ? 0 : known.split(REDACTED).length - 1;
  let next = known;
  for (const { pattern, keep } of RULES) {
    next = next.replace(pattern, (...match: Array<unknown>) => {
      count += 1;
      const groups = match.slice(1).filter((part): part is string => typeof part === "string");
      return keep(groups);
    });
  }
  return { text: next, count };
}

export interface FixWorkFacts {
  readonly generatedAt: string;
  readonly version: string;
  readonly platform: string;
  readonly mode: string;
  readonly host: string;
  readonly memory: { readonly freeMb: number; readonly totalMb: number };
  readonly disk: { readonly freeGb: number; readonly totalGb: number } | null;
  readonly uptimeHours: number;
  readonly paths: {
    readonly daemonFolder: string;
    readonly workspace: string;
  };
  readonly openCodeVersion: string;
  readonly agents: ReadonlyArray<{
    readonly name: string;
    readonly version: string | null;
    readonly status: string;
    readonly signedIn: string;
    readonly message: string | null;
  }>;
}

export function buildFixWorkContext(facts: FixWorkFacts): string {
  const agents = facts.agents.map(
    (agent) =>
      `- ${agent.name}: ${agent.version ?? "not installed"} · ${agent.status} · sign-in ${agent.signedIn}${agent.message ? ` · ${agent.message}` : ""}`,
  );
  return redactForSupport(
    [
      "# This computer",
      "",
      `Taken ${facts.generatedAt}.`,
      "",
      `- Uno Work ${facts.version} (${facts.mode}) on ${facts.host}`,
      `- System: ${facts.platform}, up ${facts.uptimeHours} h`,
      `- Memory: ${facts.memory.freeMb} MB free of ${facts.memory.totalMb} MB`,
      facts.disk
        ? `- Disk: ${facts.disk.freeGb} GB free of ${facts.disk.totalGb} GB`
        : "- Disk: unknown",
      `- Daemon's folder: ${facts.paths.daemonFolder}`,
      `- Projects: ${facts.paths.workspace}`,
      `- OpenCode version Uno Work is checked against: ${facts.openCodeVersion}`,
      "",
      "## Agents",
      "",
      ...(agents.length > 0 ? agents : ["- none"]),
      "",
    ].join("\n"),
  ).text;
}
