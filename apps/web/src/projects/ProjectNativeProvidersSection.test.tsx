import type { ProjectSummary } from "@octant/contracts/projects";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectNativeProvidersSection } from "./ProjectNativeProvidersSection";

type BoundProjectSummary = Extract<ProjectSummary, { readonly type: "work" | "code" }>;

function project(nativeProviders?: BoundProjectSummary["nativeProviders"]): BoundProjectSummary {
  return {
    id: "80000000-0000-4000-8000-000000000921",
    name: "Workspace",
    type: "work",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 2,
    createdAt: "2026-10-31T10:00:00.000Z",
    updatedAt: "2026-10-31T10:00:00.000Z",
    binding: { canonicalRoot: "/Users/example/Workspace" },
    bindingRevisionId: "80000000-0000-4000-8000-000000000922",
    ...(nativeProviders === undefined ? {} : { nativeProviders }),
  } as BoundProjectSummary;
}

describe("Trusted providers in a Project", () => {
  it("trusts none by default and sends the whole list in a fixed order when one is checked", async () => {
    const onChange = vi.fn(async () => true);
    render(<ProjectNativeProvidersSection onChange={onChange} project={project(["opencode"])} />);
    expect(screen.getByRole("checkbox", { name: "OpenCode" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).not.toBeChecked();
    await userEvent.click(screen.getByRole("checkbox", { name: "Claude Code" }));
    expect(onChange).toHaveBeenCalledWith(["claude", "opencode"]);
  });

  it("untrusts a provider by sending the list without it", async () => {
    const onChange = vi.fn(async () => true);
    render(<ProjectNativeProvidersSection onChange={onChange} project={project(["codex"])} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Codex" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
