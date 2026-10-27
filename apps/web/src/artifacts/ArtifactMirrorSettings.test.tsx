import type {
  ArtifactMirrorProjectStatus,
  ArtifactMirrorSettings as MirrorSettings,
} from "@octant/contracts/artifact-mirror";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ArtifactMirrorSettings } from "./ArtifactMirrorSettings";

function settings(overrides: Partial<MirrorSettings> = {}): MirrorSettings {
  return {
    kind: "artifact-mirror-settings",
    fallback: { kind: "internal-only" },
    overrides: [],
    autoCommit: false,
    version: 1,
    updatedAt: "2026-08-18T10:00:00.000Z",
    ...overrides,
  } as MirrorSettings;
}

describe("choosing whether artifacts become files", () => {
  it("keeps mirroring secondary until the user opens it", async () => {
    const user = userEvent.setup();
    render(
      <ArtifactMirrorSettings
        busy={false}
        onChangeAutoCommit={vi.fn()}
        onChangeDestination={vi.fn()}
        onChooseFolderAgain={vi.fn()}
        projects={[]}
        settings={settings()}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Configure file mirroring" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/deleting one does not delete the artifact/i)).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/deleting one does not delete the artifact/i)).toBeVisible();
  });

  it("says the folder is a copy rather than the artifact", () => {
    render(
      <ArtifactMirrorSettings
        busy={false}
        defaultOpen
        onChangeAutoCommit={vi.fn()}
        onChangeDestination={vi.fn()}
        onChooseFolderAgain={vi.fn()}
        projects={[]}
        settings={settings()}
      />,
    );

    expect(screen.getByText(/deleting one does not delete the artifact/i)).toBeTruthy();
  });

  it("offers auto-commit only where there is a repository to commit in", () => {
    const { rerender } = render(
      <ArtifactMirrorSettings
        busy={false}
        defaultOpen
        onChangeAutoCommit={vi.fn()}
        onChangeDestination={vi.fn()}
        onChooseFolderAgain={vi.fn()}
        projects={[]}
        settings={settings()}
      />,
    );

    expect(screen.getByRole("checkbox")).toHaveProperty("disabled", true);

    rerender(
      <ArtifactMirrorSettings
        busy={false}
        defaultOpen
        onChangeAutoCommit={vi.fn()}
        onChangeDestination={vi.fn()}
        onChooseFolderAgain={vi.fn()}
        projects={[]}
        settings={settings({
          fallback: { kind: "project-repository", relativeDirectory: "docs/artifacts" as never },
        })}
      />,
    );

    expect(screen.getByRole("checkbox")).toHaveProperty("disabled", false);
  });

  it("asks for auto-commit without claiming anything is pushed", async () => {
    const onChangeAutoCommit = vi.fn();
    render(
      <ArtifactMirrorSettings
        busy={false}
        defaultOpen
        onChangeAutoCommit={onChangeAutoCommit}
        onChangeDestination={vi.fn()}
        onChooseFolderAgain={vi.fn()}
        projects={[]}
        settings={settings({
          fallback: { kind: "project-repository", relativeDirectory: "docs/artifacts" as never },
        })}
      />,
    );

    await userEvent.click(screen.getByRole("checkbox"));

    expect(onChangeAutoCommit).toHaveBeenCalledWith(true);
    expect(screen.getByText(/never\s+pushes/i)).toBeTruthy();
  });

  it("shows which Project stopped mirroring and why, and asks for the folder again", async () => {
    const user = userEvent.setup();
    const onChooseFolderAgain = vi.fn();
    const refused = {
      projectId: "20000000-0000-4000-8000-000000000001",
      projectName: "Storefront",
      source: "project",
      destination: { kind: "global-folder", canonicalRoot: "/Users/ada/Artifacts" },
      outcome: "refused",
      reason: "destination-unavailable",
      detail: "The folder this Project mirrors to could not be read.",
      observedAt: "2026-08-18T10:00:00.000Z",
    } as ArtifactMirrorProjectStatus;
    const written = {
      ...refused,
      projectId: "20000000-0000-4000-8000-000000000002",
      projectName: "Docs site",
      outcome: "written",
    } as ArtifactMirrorProjectStatus;
    render(
      <ArtifactMirrorSettings
        busy={false}
        onChangeAutoCommit={vi.fn()}
        onChangeDestination={vi.fn()}
        onChooseFolderAgain={onChooseFolderAgain}
        projects={[refused, written]}
        settings={settings()}
      />,
    );

    // Visible without opening the collapsed settings.
    const list = screen.getByRole("list", { name: "Projects not being mirrored" });
    expect(list).toHaveTextContent("Storefront");
    expect(list).toHaveTextContent("The folder this Project mirrors to could not be read.");
    expect(list).toHaveTextContent("/Users/ada/Artifacts");
    expect(list).not.toHaveTextContent("Docs site");

    await user.click(screen.getByRole("button", { name: "Choose the folder again" }));
    await user.type(screen.getByLabelText("Folder for Storefront"), "/Users/ada/Mirror");
    await user.click(screen.getByRole("button", { name: "Use this folder" }));

    expect(onChooseFolderAgain).toHaveBeenCalledWith(refused, "/Users/ada/Mirror");
  });
});
