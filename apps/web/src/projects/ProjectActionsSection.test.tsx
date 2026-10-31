import { decodeProjectSummary, type ProjectSummary } from "@octant/contracts/projects";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectActionsSection } from "./ProjectActionsSection";

type CodeProjectSummary = Extract<ProjectSummary, { readonly type: "code" }>;

const ACTION_ID = "81000000-0000-4000-8000-000000000001";

function project(actions?: ReadonlyArray<object>): CodeProjectSummary {
  const summary = decodeProjectSummary({
    id: "80000000-0000-4000-8000-000000000001",
    type: "code",
    name: "Web app",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 3,
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T10:00:00.000Z",
    binding: { canonicalRoot: "/repositories/web-app" },
    bindingRevisionId: "80000000-0000-4000-8000-000000000002",
    codeAccessPersistence: "current-session",
    ...(actions === undefined ? {} : { actions }),
  });
  if (summary.type !== "code") throw new Error("Expected a Code Project.");
  return summary;
}

function client() {
  return {
    execute: vi.fn(async () => ({
      kind: "project-action-suggestions" as const,
      projectId: project().id,
      suggestions: [
        {
          name: "Dev",
          command: "bun run dev",
          directory: ".",
          source: "package.json" as const,
        },
      ],
    })),
  };
}

afterEach(cleanup);

describe("Project actions editor", () => {
  it("saves a suggestion the person confirms, and stops offering it once added", async () => {
    const onChange = vi.fn(async () => true);
    render(<ProjectActionsSection client={client()} onChange={onChange} project={project()} />);

    await userEvent.click(await screen.findByRole("button", { name: /Dev.*bun run dev/ }));
    expect(screen.queryByRole("group", { name: "Suggested actions" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save actions" }));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ name: "Dev", command: "bun run dev", directory: "." }),
    ]);
  });

  it("will not save an action without a name and a command", async () => {
    const onChange = vi.fn(async () => true);
    render(<ProjectActionsSection client={client()} onChange={onChange} project={project()} />);

    await userEvent.click(screen.getByRole("button", { name: "Add action" }));

    expect(screen.getByRole("button", { name: "Save actions" })).toBeDisabled();
    expect(screen.getByText(/needs a unique name/)).toBeVisible();
  });

  it("removes a saved action and saves the shorter list", async () => {
    const onChange = vi.fn(async () => true);
    render(
      <ProjectActionsSection
        client={client()}
        onChange={onChange}
        project={project([
          { id: ACTION_ID, name: "Test", command: "bun run test", directory: "." },
        ])}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Remove Test" }));
    await userEvent.click(screen.getByRole("button", { name: "Save actions" }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith([]));
  });
});
