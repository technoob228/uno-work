import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SIDEBAR_ADD_PROJECT_HINT, SidebarAddProjectButton } from "./SidebarAddProjectButton";
import { countOwnProjects, showSidebarAddProject } from "./sidebarAddProject.logic";

interface P {
  readonly id: string;
  readonly name: string;
}

const isHome = (project: P) => project.name === "Home folder";
const home: P = { id: "p-home", name: "Home folder" };
const assistant: P = { id: "assistant-home", name: "Uno" };
const otherAssistant: P = { id: "assistant-sales", name: "Sales" };
const landing: P = { id: "p-landing", name: "landing" };

function shown(projects: ReadonlyArray<P>, extra?: { loading?: boolean; setup?: boolean }) {
  return showSidebarAddProject({
    ownProjectCount: countOwnProjects(projects, isHome),
    loading: extra?.loading ?? false,
    projectBeingSetUp: extra?.setup ?? false,
  });
}

describe("sidebar Add a project button (Misha 28.10)", () => {
  it("shows on a new account with no projects at all", () => {
    expect(shown([])).toBe(true);
  });

  it("does not count Uno's folder, other assistants or the home folder as projects", () => {
    expect(countOwnProjects([home, assistant, otherAssistant], isHome)).toBe(0);
    expect(shown([home, assistant, otherAssistant])).toBe(true);
  });

  it("goes away once the person has one project", () => {
    expect(countOwnProjects([home, assistant, landing], isHome)).toBe(1);
    expect(shown([home, assistant, landing])).toBe(false);
    expect(shown([landing])).toBe(false);
  });

  it("waits while the computer's list is still loading (unknown is not empty)", () => {
    expect(shown([], { loading: true })).toBe(false);
  });

  it("steps aside while the setup is naming a project (the sidebar previews it)", () => {
    expect(shown([home, assistant], { setup: true })).toBe(false);
  });

  it("is a full-width button with the folder, Home's words and a one-line hint", () => {
    const html = renderToStaticMarkup(<SidebarAddProjectButton onAddProject={() => {}} />);
    expect(html).toContain('data-testid="sidebar-add-project-button"');
    expect(html).toContain(">Add a project<");
    expect(html).toContain(SIDEBAR_ADD_PROJECT_HINT);
    expect(html).toContain("w-full");
    expect(html).toContain("lucide-folder");
    expect(html.match(/<button/g)?.length).toBe(1);
  });
});
