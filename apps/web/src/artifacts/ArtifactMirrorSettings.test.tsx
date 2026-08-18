import type { ArtifactMirrorSettings as MirrorSettings } from "@octant/contracts/artifact-mirror";
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
  it("says the folder is a copy rather than the artifact", () => {
    render(
      <ArtifactMirrorSettings
        busy={false}
        onChangeAutoCommit={vi.fn()}
        onChangeDestination={vi.fn()}
        settings={settings()}
      />,
    );

    expect(screen.getByText(/deleting one does not delete the artifact/i)).toBeTruthy();
  });

  it("offers auto-commit only where there is a repository to commit in", () => {
    const { rerender } = render(
      <ArtifactMirrorSettings
        busy={false}
        onChangeAutoCommit={vi.fn()}
        onChangeDestination={vi.fn()}
        settings={settings()}
      />,
    );

    expect(screen.getByRole("checkbox")).toHaveProperty("disabled", true);

    rerender(
      <ArtifactMirrorSettings
        busy={false}
        onChangeAutoCommit={vi.fn()}
        onChangeDestination={vi.fn()}
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
        onChangeAutoCommit={onChangeAutoCommit}
        onChangeDestination={vi.fn()}
        settings={settings({
          fallback: { kind: "project-repository", relativeDirectory: "docs/artifacts" as never },
        })}
      />,
    );

    await userEvent.click(screen.getByRole("checkbox"));

    expect(onChangeAutoCommit).toHaveBeenCalledWith(true);
    expect(screen.getByText(/never\s+pushes/i)).toBeTruthy();
  });
});
