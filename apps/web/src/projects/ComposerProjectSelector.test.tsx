import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ComposerProjectSelector,
  type ComposerProjectEntry,
  type ComposerProjectSelection,
} from "./ComposerProjectSelector";
import type { ProjectId } from "@octant/contracts/projects";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type { GithubCloneClient } from "@octant/client-runtime/github-clone-client";

const entries: ComposerProjectEntry[] = [
  {
    kind: "saved-project",
    projectId: "00000000-0000-0000-0000-000000000001" as ProjectId,
    displayName: "My Project",
    rootPath: "/home/user/project",
  },
  { kind: "add-folder" },
];

const projectSelection: ComposerProjectSelection = {
  projectId: "00000000-0000-0000-0000-000000000001" as ProjectId,
  displayName: "My Project",
};

describe("ComposerProjectSelector", () => {
  it("asks for a Project until one is chosen", () => {
    render(
      <ComposerProjectSelector entries={entries} onSelect={() => {}} onAddFolder={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Project: Choose a Project" })).toBeVisible();
  });

  it("names the chosen Project", () => {
    render(
      <ComposerProjectSelector
        entries={entries}
        selection={projectSelection}
        onSelect={() => {}}
        onAddFolder={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Project: My Project" })).toBeVisible();
  });

  it("refuses interaction while the thread is being created", () => {
    render(
      <ComposerProjectSelector
        entries={entries}
        onSelect={() => {}}
        onAddFolder={() => {}}
        disabled
      />,
    );
    expect(screen.getByRole("button", { name: "Project: Choose a Project" })).toBeDisabled();
  });

  it("announces itself as a listbox trigger that starts closed", () => {
    render(
      <ComposerProjectSelector entries={entries} onSelect={() => {}} onAddFolder={() => {}} />,
    );
    const trigger = screen.getByRole("button", { name: "Project: Choose a Project" });
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the way to add a folder when the search matches no saved Project", async () => {
    const user = userEvent.setup();
    render(
      <ComposerProjectSelector entries={entries} onSelect={() => {}} onAddFolder={() => {}} />,
    );

    await user.click(screen.getByRole("button", { name: "Project: Choose a Project" }));
    const search = screen.getByRole("combobox", { name: "Search Projects" });
    expect(search).toHaveFocus();
    await user.type(search, "missing");

    expect(screen.queryByRole("option", { name: /My Project/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "New Project from folder…" })).toBeVisible();
    // Nothing offers a thread with no Project: the list can only ever name one
    // or create one.
    expect(screen.queryByRole("option", { name: /No folder/ })).not.toBeInTheDocument();
  });

  it("supports arrow-key selection and restores focus on Escape", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ComposerProjectSelector entries={entries} onSelect={onSelect} onAddFolder={() => {}} />,
    );

    const trigger = screen.getByRole("button", { name: "Project: Choose a Project" });
    await user.click(trigger);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith(entries[0]);

    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it("offers a new Project from a GitHub repository inside the same menu and walks back to Projects", async () => {
    const user = userEvent.setup();
    const client: GithubClient = {
      authenticationSnapshot: async () => {
        throw new Error("not used");
      },
      executeAuthenticationCommand: async () => {
        throw new Error("not used");
      },
      readCatalogue: async (request) =>
        request.kind === "recent-repositories"
          ? ({ kind: "recent-repositories", rows: [] } as never)
          : ({
              kind: "repositories",
              page: {
                rows: [
                  {
                    nodeId: "R_node1",
                    owner: "octant",
                    name: "repo-1",
                    visibility: "private",
                    defaultBranch: "main",
                    viewerPermission: "admin",
                    capabilities: [],
                  },
                ],
                sort: "pushed-desc",
                hasNextPage: false,
                freshness: { status: "fresh" },
              },
            } as never),
      recordRecentRepository: async () => ({ kind: "recent-repositories", rows: [] }) as never,
    };
    const cloneClient: GithubCloneClient = {
      execute: async () => {
        throw new Error("not used");
      },
      listOperations: async () => ({ operations: [] }),
    };
    render(
      <ComposerProjectSelector
        entries={entries}
        github={{
          client,
          cloneClient,
          hostName: "This Mac",
          createProject: async () => undefined,
          onProjectCreated: () => {},
        }}
        onAddFolder={() => {}}
        onSelect={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project: Choose a Project" }));
    expect(screen.getByRole("option", { name: "New Project from folder…" })).toBeVisible();
    await user.click(screen.getByRole("option", { name: "New Project from GitHub repository…" }));

    expect(await screen.findByText("octant/repo-1")).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Search Projects" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to Projects" }));
    expect(screen.getByRole("combobox", { name: "Search Projects" })).toBeVisible();
  });

  it("keeps GitHub out of the menu when the host has no GitHub clients", async () => {
    const user = userEvent.setup();
    render(
      <ComposerProjectSelector entries={entries} onSelect={() => {}} onAddFolder={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: "Project: Choose a Project" }));
    expect(
      screen.queryByRole("option", { name: "New Project from GitHub repository…" }),
    ).not.toBeInTheDocument();
  });
});
