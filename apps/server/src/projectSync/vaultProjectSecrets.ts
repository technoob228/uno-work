/**
 * The project's keys in the Uno vault (fishcode `/api/v1/work/projects/{name}/secrets`,
 * scope `project`, keyed by the synced project's name). A cloud computer
 * signs in with its machine key, a laptop with the account key given to Uno
 * Work. Values are only ever returned to the caller; never logged, never in
 * an error message.
 *
 * Someone else's project shared with this person goes through the team routes
 * (`/api/v1/work/team/projects/{id}`, see TEAM_API.md): read only, and only what the
 * owner ticked. Managing a team is not here and never will be: this computer's
 * key can't do it, that's the person's own sign-in in the interface.
 *
 * @module projectSync/vaultProjectSecrets
 */

export interface VaultSecretMeta {
  readonly name: string;
  readonly version: number;
  readonly updatedAt: string | null;
}

export interface ProjectVault {
  readonly list: (project: string) => Promise<ReadonlyArray<VaultSecretMeta>>;
  readonly reveal: (
    project: string,
    names?: ReadonlyArray<string>,
  ) => Promise<Readonly<Record<string, string>>>;
  readonly set: (
    project: string,
    name: string,
    value: string,
  ) => Promise<{ readonly version: number; readonly changed: boolean }>;
  readonly remove: (project: string, name: string) => Promise<void>;
}

/** A project with a team this person is in. */
export interface SharedProject {
  readonly id: number;
  readonly name: string;
  readonly role: "owner" | "editor";
  readonly owner: { readonly username: string | null; readonly email: string | null };
  /** When this person joined: their membership, new after being removed and invited again. */
  readonly joinedAt: string | null;
}

export type SharedProjectKeys = Pick<ProjectVault, "list" | "reveal">;

export interface ProjectTeams {
  /** Empty when teams aren't on for this account. */
  readonly projects: () => Promise<ReadonlyArray<SharedProject>>;
  readonly keys: (teamId: number) => SharedProjectKeys;
}

export class ProjectVaultError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** What a console answer means for the person (never the body: it could echo a value). */
function problem(status: number, code: string): string {
  if (status === 401) return "Uno didn't accept this computer's key. Sign in to Uno again.";
  if (code === "WORK_TEAM_DISABLED") return "Shared projects aren't available right now.";
  if (code === "ASSISTANT_COMPUTER_NO_PROJECT_KEYS") {
    return "An assistant's own computer doesn't get your project keys.";
  }
  if (status === 403) return "This computer's key isn't allowed to read project keys.";
  if (status === 404 && code !== "NOT_FOUND") {
    return "Keys can't travel with projects yet: your Uno console doesn't support it.";
  }
  if (status === 503) return "The Uno vault isn't available right now. Try again later.";
  if (code === "PROJECT_SECRETS_LIMIT") return "A project can keep at most 200 keys.";
  if (code === "SECRET_NAME_RESERVED") {
    return "That name changes how programs start (LD_*, NODE_OPTIONS, …); use an app-specific name.";
  }
  if (status === 400) return "Uno refused that key (check its name).";
  return `The Uno vault answered ${status}.`;
}

interface ConsoleAccess {
  readonly baseUrl: string;
  /** Read each time: the console may link the computer after start. */
  readonly token: () => Promise<string | null>;
  readonly fetch?: typeof fetch;
}

function consoleCaller(input: ConsoleAccess) {
  const doFetch = input.fetch ?? fetch;
  return async (
    method: string,
    route: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> => {
    const token = await input.token();
    if (!token) {
      throw new ProjectVaultError(
        "Sign in to your Uno account on this computer so keys can travel with the project.",
        401,
      );
    }
    let response: Response;
    try {
      response = await doFetch(`${input.baseUrl}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ProjectVaultError(
        "Couldn't reach the Uno vault. Check the internet connection.",
        0,
      );
    }
    const text = await response.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const code =
        typeof json === "object" && json !== null && typeof (json as any).error === "string"
          ? String((json as any).error)
          : "";
      throw new ProjectVaultError(problem(response.status, code), response.status);
    }
    return { status: response.status, json };
  };
}

function secretsFrom(json: unknown): ReadonlyArray<VaultSecretMeta> {
  const raw = (json as { secrets?: unknown } | null)?.secrets;
  return Array.isArray(raw)
    ? raw.flatMap((entry: any) =>
        typeof entry?.name === "string"
          ? [
              {
                name: entry.name,
                version: Number(entry.version) || 0,
                updatedAt: typeof entry.updated_at === "string" ? entry.updated_at : null,
              },
            ]
          : [],
      )
    : [];
}

function valuesFrom(json: unknown): Readonly<Record<string, string>> {
  const values = (json as { values?: unknown } | null)?.values;
  const out: Record<string, string> = {};
  if (values && typeof values === "object") {
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === "string") out[name] = value;
    }
  }
  return out;
}

export function consoleProjectVault(input: ConsoleAccess): ProjectVault {
  const call = consoleCaller(input);
  const base = (project: string) => `/api/v1/work/projects/${encodeURIComponent(project)}/secrets`;
  return {
    list: async (project) => secretsFrom((await call("GET", base(project))).json),
    reveal: async (project, names) =>
      valuesFrom(
        (
          await call("POST", `${base(project)}/reveal`, {
            ...(names && names.length > 0 ? { names } : {}),
          })
        ).json,
      ),
    set: async (project, name, value) => {
      const { json } = await call("PUT", `${base(project)}/${encodeURIComponent(name)}`, { value });
      const raw = json as { version?: unknown; changed?: unknown } | null;
      return { version: Number(raw?.version) || 0, changed: raw?.changed !== false };
    },
    remove: async (project, name) => {
      try {
        await call("DELETE", `${base(project)}/${encodeURIComponent(name)}`);
      } catch (error) {
        if (error instanceof ProjectVaultError && error.status === 404) return;
        throw error;
      }
    },
  };
}

/**
 * The projects this person is in, and the keys the owner gave them. Only what
 * a computer's key may do: looking, never inviting or giving keys.
 */
export function consoleProjectTeams(input: ConsoleAccess): ProjectTeams {
  const call = consoleCaller(input);
  const root = "/api/v1/work/team/projects";
  return {
    projects: async () => {
      let json: unknown;
      try {
        json = (await call("GET", root)).json;
      } catch (error) {
        // Teams aren't on here, or this key has no say in them: nothing changes for anyone.
        if (error instanceof ProjectVaultError && [403, 404].includes(error.status)) return [];
        throw error;
      }
      const raw = (json as { projects?: unknown } | null)?.projects;
      return Array.isArray(raw)
        ? raw.flatMap((project: any) =>
            Number.isSafeInteger(project?.id) &&
            typeof project?.name === "string" &&
            (project?.role === "owner" || project?.role === "editor")
              ? [
                  {
                    id: project.id as number,
                    name: project.name as string,
                    role: project.role as "owner" | "editor",
                    owner: {
                      username:
                        typeof project.owner?.username === "string" ? project.owner.username : null,
                      email: typeof project.owner?.email === "string" ? project.owner.email : null,
                    },
                    joinedAt: typeof project.joined_at === "string" ? project.joined_at : null,
                  },
                ]
              : [],
          )
        : [];
    },
    keys: (teamId) => ({
      list: async () => secretsFrom((await call("GET", `${root}/${teamId}/secrets`)).json),
      reveal: async (_project, names) =>
        valuesFrom(
          (
            await call("POST", `${root}/${teamId}/secrets/reveal`, {
              ...(names && names.length > 0 ? { names } : {}),
            })
          ).json,
        ),
    }),
  };
}
