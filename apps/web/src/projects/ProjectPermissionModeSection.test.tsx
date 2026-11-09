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
    const auto = await screen.findByRole("option", { name: "Auto" });
    expect(screen.queryByRole("option", { name: "Plan" })).toBeNull();
    await userEvent.click(auto);

    expect(onChange).toHaveBeenCalledWith("auto");
  });

  it("shows the mode a Work Project already overrides", () => {
    render(
      <ProjectPermissionModeSection
        onChange={async () => true}
        project={project("work", { defaultPermissionMode: "accept-edits" })}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Default mode for this Project" }),
    ).toHaveTextContent("Accept edits");
  });

  it("sets the Project's sandbox at Full access apart from its mode, and returns it to Settings", async () => {
    const onChange = vi.fn(async () => true);
    const { rerender } = render(
      <ProjectPermissionModeSection
        onChange={onChange}
        project={project("code", { defaultPermissionMode: "full-access" })}
      />,
    );
    await userEvent.click(
      screen.getByRole("combobox", { name: "Sandbox at Full access for this Project" }),
    );
    await userEvent.click(await screen.findByRole("option", { name: "Keep the sandbox" }));
    expect(onChange).toHaveBeenLastCalledWith("full-access", true);

    rerender(
      <ProjectPermissionModeSection
        onChange={onChange}
        project={project("code", {
          defaultPermissionMode: "full-access",
          defaultFullAccessSandbox: true,
          version: 4,
        })}
      />,
    );
    await userEvent.click(
      screen.getByRole("combobox", { name: "Sandbox at Full access for this Project" }),
    );
    await userEvent.click(await screen.findByRole("option", { name: "Same as Settings" }));
    expect(onChange).toHaveBeenLastCalledWith("full-access", "settings");
  });

  it("keeps a Project's remembered Full access when only its sandbox changes", async () => {
    const onChange = vi.fn(async () => true);
    render(
      <ProjectPermissionModeSection
        onChange={onChange}
        project={project("code", { codeAccessPersistence: "project-default" })}
      />,
    );
    await userEvent.click(
      screen.getByRole("combobox", { name: "Sandbox at Full access for this Project" }),
    );
    await userEvent.click(await screen.findByRole("option", { name: "Keep the sandbox" }));
    // The Project remembered Full access before modes existed, so it has no mode
    // of its own; sending none would read as "follow Settings" and drop it.
    expect(onChange).toHaveBeenLastCalledWith("full-access", true);
  });

  it("changes only the mode when the mode is picked, so the Project keeps its sandbox choice", async () => {
    const onChange = vi.fn(async () => true);
    render(
      <ProjectPermissionModeSection
        onChange={onChange}
        project={project("work", { defaultFullAccessSandbox: true })}
      />,
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Default mode for this Project" }));
    await userEvent.click(await screen.findByRole("option", { name: "Auto" }));
    expect(onChange).toHaveBeenCalledWith("auto");
  });

  it("offers Plan for a Code Project", async () => {
    render(<ProjectPermissionModeSection onChange={async () => true} project={project("code")} />);
    await userEvent.click(screen.getByRole("combobox", { name: "Default mode for this Project" }));
    expect(await screen.findByRole("option", { name: "Plan" })).toBeVisible();
  });
});
