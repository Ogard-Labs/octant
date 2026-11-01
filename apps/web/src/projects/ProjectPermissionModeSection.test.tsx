import { decodeProjectSummary, type ProjectSummary } from "@octant/contracts/projects";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPermissionModeSection } from "./ProjectPermissionModeSection";

type BoundSummary = Extract<ProjectSummary, { readonly type: "code" | "work" }>;

function project(type: "code" | "work", extra: object = {}): BoundSummary {
  const summary = decodeProjectSummary({
    id: "80000000-0000-4000-8000-000000000001",
    type,
    name: "Notes",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 3,
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T10:00:00.000Z",
    binding: { canonicalRoot: "/repositories/notes" },
    bindingRevisionId: "80000000-0000-4000-8000-000000000002",
    ...(type === "code" ? { codeAccessPersistence: "current-session" } : {}),
    ...extra,
  });
  if (summary.type === "chat") throw new Error("Expected a bound Project.");
  return summary;
}

afterEach(cleanup);

describe("Project default mode", () => {
  it("lets a Work Project override the mode new threads start in, without a Plan option", async () => {
    const onChange = vi.fn(async () => true);
    render(<ProjectPermissionModeSection onChange={onChange} project={project("work")} />);

    await userEvent.click(screen.getByRole("combobox", { name: "Default mode for this Project" }));
    expect(screen.queryByRole("option", { name: "Plan" })).toBeNull();
    await userEvent.click(screen.getByRole("option", { name: "Auto" }));

    expect(onChange).toHaveBeenCalledWith("auto");
  });

  it("shows the mode a Work Project already overrides, and offers Plan for a Code Project", async () => {
    render(
      <ProjectPermissionModeSection
        onChange={async () => true}
        project={project("work", { defaultPermissionMode: "accept-edits" })}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Default mode for this Project" }),
    ).toHaveTextContent("Accept edits");
    cleanup();

    render(<ProjectPermissionModeSection onChange={async () => true} project={project("code")} />);
    await userEvent.click(screen.getByRole("combobox", { name: "Default mode for this Project" }));
    expect(screen.getByRole("option", { name: "Plan" })).toBeVisible();
  });
});
