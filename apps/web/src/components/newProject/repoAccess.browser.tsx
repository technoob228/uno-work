import "../../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const api = vi.hoisted(() => ({
  cloneRepository: vi.fn(),
  getGithubAccount: vi.fn(),
  connectGithubAccount: vi.fn(),
  openAuthWindow: vi.fn(),
}));

vi.mock("../../environmentApi", () => ({
  ensureEnvironmentApi: () => ({ sourceControl: { cloneRepository: api.cloneRepository } }),
}));
vi.mock("../../lib/setupApi", () => ({
  getGithubAccount: api.getGithubAccount,
  connectGithubAccount: api.connectGithubAccount,
  openAuthWindow: api.openAuthWindow,
}));

import { RepoAccessNotice, useRepoClone } from "./repoAccess";

const REPO = "https://github.com/technoob228/uno-workspace.git";
const GIT_REFUSAL = new Error(
  "Source control repository operation cloneRepository failed for unknown: git clone -- https://github.com/technoob228/uno-workspace.git uno-workspace failed: Cloning into 'uno-workspace'... fatal: could not read Username for 'https://github.com': No such device or address",
);
const github = (connected: boolean) => ({
  available: true,
  reason: null,
  connected,
  accounts: connected ? ["technoob228"] : [],
  permission: "write" as const,
});

/** The notice as the person sees it (kept next to the report, not in the repository). */
const shot = (name: string) =>
  page.getByTestId("new-project-repo-private").screenshot({ path: `screenshots/${name}.png` });

function Harness() {
  const access = useRepoClone(EnvironmentId.make("env-test"));
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    try {
      const done = await access.clone({ remoteUrl: REPO, destinationPath: "/home/u/projects/x" });
      setResult(done ? `cloned ${done.remoteUrl}` : "refused");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className="w-[520px] p-4">
      <button type="button" onClick={() => void submit()}>
        Clone and open
      </button>
      <RepoAccessNotice
        access={access}
        remoteUrl={REPO}
        busy={false}
        onOpenGithub={() => void access.openGithub(submit)}
        onAskUno={() => setResult("ask-uno")}
      />
      <p data-testid="result">{result}</p>
      <p data-testid="error">{error}</p>
    </div>
  );
}

beforeEach(async () => {
  await page.viewport(720, 480);
  for (const fn of Object.values(api)) fn.mockReset();
  api.connectGithubAccount.mockResolvedValue({
    authorizeUrl: "https://github.com/apps/uno-deploy/installations/new?state=x",
  });
  api.openAuthWindow.mockResolvedValue({ ok: false, closed: true, external: false });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("a private repository in New project (Misha 20.10)", () => {
  it("offers Continue with GitHub, then clones over https by itself", async () => {
    api.cloneRepository
      .mockRejectedValueOnce(GIT_REFUSAL)
      .mockResolvedValueOnce({ cwd: "/home/u/projects/x", remoteUrl: REPO, repository: null });
    api.getGithubAccount.mockResolvedValueOnce(github(false)).mockResolvedValue(github(true));
    const screen = await render(<Harness />);

    await screen.getByText("Clone and open").click();
    await expect.element(screen.getByText("This repository is private.")).toBeInTheDocument();
    await expect.element(screen.getByText("Continue with GitHub")).toBeInTheDocument();
    // git's own words never reach the screen.
    expect(document.body.textContent).not.toContain("could not read Username");
    await shot("private-continue-with-github");

    await screen.getByText("Continue with GitHub").click();
    await expect.element(screen.getByTestId("result")).toHaveTextContent(`cloned ${REPO}`);
    expect(api.connectGithubAccount).toHaveBeenCalledTimes(1);
    expect(api.cloneRepository).toHaveBeenLastCalledWith({
      remoteUrl: REPO,
      destinationPath: "/home/u/projects/x",
    });
  });

  it("asks to give Uno access when GitHub is connected but the repository isn't on the list", async () => {
    api.cloneRepository.mockRejectedValue(GIT_REFUSAL);
    api.getGithubAccount.mockResolvedValue(github(true));
    const screen = await render(<Harness />);

    await screen.getByText("Clone and open").click();
    await expect
      .element(screen.getByText("Give Uno access to this repository"))
      .toBeInTheDocument();
    await expect.element(screen.getByText(/technoob228\)/)).toBeInTheDocument();
    await shot("private-give-access");

    // Back from GitHub and it still refuses: say exactly what to tick.
    await screen.getByText("Give Uno access to this repository").click();
    await expect.element(screen.getByText(/GitHub still doesn’t let Uno in/)).toBeInTheDocument();
    await shot("private-still-closed");
  });

  it("from the desktop app (GitHub in the system browser) clones again when the person is back", async () => {
    api.openAuthWindow.mockResolvedValue({ ok: false, closed: true, external: true });
    api.cloneRepository
      .mockRejectedValueOnce(GIT_REFUSAL)
      .mockResolvedValueOnce({ cwd: "/home/u/projects/x", remoteUrl: REPO, repository: null });
    api.getGithubAccount.mockResolvedValue(github(true));
    const screen = await render(<Harness />);

    await screen.getByText("Clone and open").click();
    await screen.getByText("Give Uno access to this repository").click();
    await expect.element(screen.getByText("Waiting for GitHub…")).toBeInTheDocument();
    expect(api.cloneRepository).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    await expect.element(screen.getByTestId("result")).toHaveTextContent(`cloned ${REPO}`);
  });

  it("falls back to the SSH-key chat off a cloud computer", async () => {
    api.cloneRepository.mockRejectedValue(GIT_REFUSAL);
    api.getGithubAccount.mockResolvedValue({ ...github(false), available: false });
    const screen = await render(<Harness />);

    await screen.getByText("Clone and open").click();
    await expect.element(screen.getByText("Let Uno connect GitHub")).toBeInTheDocument();
  });

  it("says other failures in plain words", async () => {
    api.cloneRepository.mockRejectedValue(
      new Error(
        "Source control repository operation cloneRepository failed for unknown: git clone -- x failed: fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com",
      ),
    );
    const screen = await render(<Harness />);

    await screen.getByText("Clone and open").click();
    await expect.element(screen.getByTestId("error")).toHaveTextContent(/internet connection/);
    expect(document.body.textContent).not.toContain("fatal");
    expect(api.getGithubAccount).not.toHaveBeenCalled();
  });
});
