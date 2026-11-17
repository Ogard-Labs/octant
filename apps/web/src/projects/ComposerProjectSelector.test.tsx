import { render, screen, waitFor } from "@testing-library/react";
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

function manyProjects(count: number): ComposerProjectEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "saved-project" as const,
    projectId: `00000000-0000-0000-0000-${String(100 + i).padStart(12, "0")}` as ProjectId,
    displayName: `Project ${i + 1}`,
    rootPath: `/home/user/project-${i + 1}`,
  }));
}

const openTrigger = () => screen.getByRole("button", { name: "Project: Choose a Project" });

describe("ComposerProjectSelector", () => {
  it("offers the default folder as a way to start without choosing a Project", async () => {
    const onSelect = vi.fn();
    render(
      <ComposerProjectSelector
        entries={[...entries, { kind: "default-folder", rootPath: "/Users/ada/Octant/Work" }]}
        onSelect={onSelect}
        onAddFolder={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Project: Choose a Project" }));
    const row = screen.getByRole("option", { name: /^No Project/ });
    expect(row).toHaveTextContent("~/Octant/Work");
    await userEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith({
      kind: "default-folder",
      rootPath: "/Users/ada/Octant/Work",
    });
  });

  it("shows Code's refused default folder with its whole reason, dimmed, and refuses the start", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const reason = "Code needs a Git repository. You can change that in Code settings.";
    render(
      <ComposerProjectSelector
        entries={[
          {
            kind: "default-folder",
            rootPath: "/Users/example/Octant/Code",
            disabled: true,
            disabledReason: reason,
          },
          { kind: "add-folder" },
        ]}
        onAddFolder={vi.fn()}
        onSelect={onSelect}
      />,
    );
    await user.click(openTrigger());
    const row = screen.getByRole("option", { name: "No Project" });
    // Native `disabled` drops the option from keyboard/activedescendant
    // discovery; aria-disabled keeps the reason reachable without hover.
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).not.toBeDisabled();
    expect(row).toHaveAccessibleDescription(reason);
    expect(row).toHaveTextContent(reason);
    expect(row).toHaveClass("composer-folder-selector__option--two-line");
    await user.keyboard("{Enter}");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("holds only one quiet line and the actions when there are no Projects, with no search field", async () => {
    const user = userEvent.setup();
    render(
      <ComposerProjectSelector
        entries={[{ kind: "add-folder" }]}
        onAddFolder={() => {}}
        onSelect={() => {}}
      />,
    );
    await user.click(openTrigger());
    expect(screen.getByText("No Projects yet")).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Search Projects" })).toBeNull();
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "New Project from folder…",
    ]);
  });

  it("shows no search field and only its rows and actions with one Project", async () => {
    const user = userEvent.setup();
    render(
      <ComposerProjectSelector
        entries={entries}
        selection={projectSelection}
        onSelect={() => {}}
        onAddFolder={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Project: My Project" }));
    expect(screen.queryByRole("combobox", { name: "Search Projects" })).toBeNull();
    expect(screen.queryByText("No Projects yet")).toBeNull();
    // A lone group needs no label over it.
    expect(screen.queryByText("Projects")).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("offers a search field once there are more Projects than fit without scrolling", async () => {
    const user = userEvent.setup();
    render(
      <ComposerProjectSelector
        entries={[...manyProjects(8), { kind: "add-folder" }]}
        onAddFolder={() => {}}
        onSelect={() => {}}
      />,
    );
    await user.click(openTrigger());
    expect(screen.getByRole("combobox", { name: "Search Projects" })).toHaveFocus();
    await user.type(screen.getByRole("combobox", { name: "Search Projects" }), "Project 3");
    expect(screen.getAllByRole("option", { name: /^Project / })).toHaveLength(1);
  });

  it("marks the chosen Project with a check and no selected fill", async () => {
    const user = userEvent.setup();
    render(
      <ComposerProjectSelector
        entries={entries}
        selection={projectSelection}
        onSelect={() => {}}
        onAddFolder={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Project: My Project" }));
    const row = screen.getByRole("option", { name: /^My Project/ });
    expect(row).toHaveAttribute("aria-selected", "true");
    expect(row.querySelector(".octant-popover-option__check")).not.toBeNull();
    expect(row.className).not.toMatch(/selected/);
    expect(screen.getByRole("option", { name: "New Project from folder…" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("labels the Projects and server groups when both are listed", async () => {
    const user = userEvent.setup();
    render(
      <ComposerProjectSelector
        entries={[
          ...entries,
          {
            kind: "server-project",
            projectId: "00000000-0000-0000-0000-000000000002" as ProjectId,
            displayName: "Service",
            location: "devbox:/home/build/service",
          },
        ]}
        onAddFolder={() => {}}
        onSelect={() => {}}
      />,
    );
    await user.click(openTrigger());
    expect(screen.getByRole("group", { name: "Projects" })).toBeVisible();
    expect(screen.getByRole("group", { name: "On your servers" })).toBeVisible();
  });

  it("starts the keyboard on the chosen Project without drawing it pressed, and moves to the first and last row with Home and End", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const all = [...manyProjects(3), { kind: "add-folder" as const }];
    render(
      <ComposerProjectSelector
        entries={all}
        selection={{
          projectId: (all[1] as { projectId: ProjectId }).projectId,
          displayName: "Project 2",
        }}
        onSelect={onSelect}
        onAddFolder={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Project: Project 2" }));
    const rows = screen.getAllByRole("option");
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-activedescendant", rows[1]?.id);
    expect(rows[1]).not.toHaveAttribute("data-active");
    await user.keyboard("{End}");
    expect(rows[3]).toHaveAttribute("data-active", "true");
    await user.keyboard("{Home}");
    expect(rows[0]).toHaveAttribute("data-active", "true");
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(all[0]);
  });

  it("closes on an outside press", async () => {
    const user = userEvent.setup();
    render(
      <ComposerProjectSelector entries={entries} onSelect={() => {}} onAddFolder={() => {}} />,
    );
    await user.click(openTrigger());
    expect(screen.getByRole("listbox", { name: "Project options" })).toBeVisible();
    await user.click(document.body);
    expect(screen.queryByRole("listbox", { name: "Project options" })).toBeNull();
  });

  it("asks for a Project until one is chosen", () => {
    render(
      <ComposerProjectSelector entries={entries} onSelect={() => {}} onAddFolder={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Project: Choose a Project" })).toBeVisible();
  });

  it("offers an unfiled thread and selects it when no Project is selected", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ComposerProjectSelector
        entries={[...entries, { kind: "unfiled" }]}
        onSelect={onSelect}
        onAddFolder={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Project: No Project" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Project: No Project" }));
    const row = screen.getByRole("option", { name: /No Project/ });
    expect(row).toHaveTextContent("Start an unfiled thread");
    expect(row).toHaveAttribute("aria-selected", "true");
    await user.click(row);
    expect(onSelect).toHaveBeenCalledWith({ kind: "unfiled" });
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

  it("announces itself as a popup trigger that starts closed", () => {
    render(
      <ComposerProjectSelector entries={entries} onSelect={() => {}} onAddFolder={() => {}} />,
    );
    const trigger = screen.getByRole("button", { name: "Project: Choose a Project" });
    expect(trigger).toHaveAttribute("aria-haspopup");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the way to add a folder when the search matches no saved Project", async () => {
    const user = userEvent.setup();
    render(
      <ComposerProjectSelector
        entries={[...manyProjects(8), { kind: "add-folder" }]}
        onSelect={() => {}}
        onAddFolder={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project: Choose a Project" }));
    const search = screen.getByRole("combobox", { name: "Search Projects" });
    expect(search).toHaveFocus();
    await user.type(search, "missing");

    expect(screen.queryByRole("option", { name: /^Project 1/ })).not.toBeInTheDocument();
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
    // Opening with nothing chosen starts on the first row.
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(entries[0]);

    await user.click(trigger);
    // The keyboard is inside the popup first, so Escape has somewhere to
    // return it from.
    await waitFor(() => expect(trigger).not.toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("types a space into the search field after arrowing through the list", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ComposerProjectSelector
        entries={[...manyProjects(8), { kind: "add-folder" }]}
        onSelect={onSelect}
        onAddFolder={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project: Choose a Project" }));
    const search = screen.getByRole("combobox", { name: "Search Projects" });
    // Arrowing leaves an option active, and the space then goes to the menu
    // rather than the field it was typed into. Typing clears the active
    // option, so it is the space straight after an arrow key that is lost.
    await user.keyboard("{ArrowDown}");
    await user.keyboard(" ");

    expect(onSelect).not.toHaveBeenCalled();
    expect(search).toHaveValue(" ");
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
    expect(screen.queryByRole("listbox", { name: "Project options" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to Projects" }));
    expect(screen.getByRole("option", { name: "New Project from folder…" })).toBeVisible();
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

  it("offers a server Project with where it is and selects it like a saved one", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const serverEntry: ComposerProjectEntry = {
      kind: "server-project",
      projectId: "00000000-0000-0000-0000-000000000002" as ProjectId,
      displayName: "Service",
      location: "devbox:/home/build/service",
    };
    render(
      <ComposerProjectSelector
        entries={[serverEntry, { kind: "add-folder" }]}
        onAddFolder={() => {}}
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Project: Choose a Project" }));
    expect(screen.queryByText("No Projects yet")).toBeNull();
    const option = screen.getByRole("option", { name: /^Service/ });
    expect(option).toHaveTextContent("devbox:/home/build/service");
    await user.click(option);
    expect(onSelect).toHaveBeenCalledWith(serverEntry);
  });
});
