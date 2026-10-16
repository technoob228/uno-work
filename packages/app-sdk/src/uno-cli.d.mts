// Types of uno-cli.mjs — the `uno` shell command (~/.uno/sdk/bin/uno).

export declare const MCP_PATH: string;
export declare const GUIDE_PATH: string;
export declare const CALL_TIMEOUT_MS: number;
export declare const TRANSFER_TIMEOUT_MS: number;
export declare const USAGE: string;
export declare const UNO_API_CLI_HINT: string;

export type Render = "status" | "cleanup" | "find" | "put" | "get" | "link" | "raw";

export type Plan =
  | { kind: "help" }
  | { kind: "usage-error"; message: string }
  | {
      kind: "call";
      tool: string;
      args: Record<string, unknown>;
      json: boolean;
      render: Render;
      timeoutMs: number;
      /** The tool may wait for the person's Allow. */
      mayAsk: boolean;
    }
  | { kind: "drive-ls"; folder: string; json: boolean }
  | { kind: "guide"; topic: string }
  /** Not ours: handed to the Uno API CLI (`uno boxes list`) when one is on PATH. */
  | { kind: "delegate"; argv: string[] };

export interface Where {
  cwd: string;
  home: string;
}

export declare function planCommand(argv: string[], where: Where): Plan;
export declare function absolutePath(raw: string, where: Where): string;

export declare class UnoCliError extends Error {}

export interface Bridge {
  url: string;
  token: string;
}

export declare function bridgeFromEnv(env: NodeJS.ProcessEnv): Bridge;
export declare function callTool(
  bridge: Bridge,
  tool: string,
  args: Record<string, unknown>,
  options?: { timeoutMs?: number },
): Promise<unknown>;
export declare function fetchGuide(bridge: Bridge, topic: string): Promise<string>;

export declare function findOtherUno(input: {
  pathValue: string | undefined;
  skipDirs: string[];
}): string | null;
export declare function runOtherUno(
  file: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<number>;

export declare function formatBytes(bytes: unknown): string;
export declare function renderStatus(status: unknown): string;
export declare function renderListing(listing: unknown): string;
export declare function renderResult(
  render: Render,
  result: unknown,
  args: Record<string, unknown>,
): string;

export declare function run(
  argv: string[],
  options?: { env?: NodeJS.ProcessEnv; cwd?: string; home?: string },
): Promise<void>;
