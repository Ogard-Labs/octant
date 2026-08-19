import { decodeProjectId } from "@octant/contracts/projects";
import type { OctantMode } from "@octant/contracts/modes";
import { describe, expect, it } from "vitest";
import {
  RIGHT_UTILITY_DOCK_SURFACES,
  resolveRightUtilityDockSurface,
  type RightUtilityDockProject,
  type RightUtilityDockResolutionInput,
  type RightUtilityDockSurfaceAvailability,
} from "./rightUtilityDockModel";

const projectIds = {
  current: decodeProjectId("10000000-0000-4000-8000-000000000001"),
  replaced: decodeProjectId("10000000-0000-4000-8000-000000000002"),
} as const;

const projects = {
  chat: project("chat"),
  work: project("work"),
  code: project("code"),
} as const;

const validInput = {
  activeMode: "code",
  activeProject: projects.code,
  connectionState: "connected",
  presentationAvailability: "available",
  savedSurface: "code-environment",
  surfaceProjectId: projectIds.current,
} as const satisfies RightUtilityDockResolutionInput;

describe("Right Utility Dock surface model", () => {
  it("publishes only the real surfaces in stable order", () => {
    expect(RIGHT_UTILITY_DOCK_SURFACES).toEqual([
      {
        id: "context",
        label: "Context",
        modes: ["chat", "work", "code"],
        projectRequired: true,
      },
      {
        id: "project-memory",
        label: "Project memory",
        modes: ["chat", "work", "code"],
        projectRequired: true,
      },
      {
        id: "code-environment",
        label: "Code environment",
        modes: ["code"],
        projectRequired: true,
      },
      {
        id: "navigator",
        label: "Navigator",
        modes: ["chat", "work", "code"],
        projectRequired: false,
      },
      {
        id: "plan",
        label: "Plan",
        modes: ["code"],
        projectRequired: true,
      },
    ]);
  });

  it.each(["chat", "work", "code"] as const)(
    "opens the host-owned Navigator in %s with no active Project",
    (activeMode) => {
      expect(
        resolveRightUtilityDockSurface({
          activeMode,
          connectionState: "connected",
          presentationAvailability: "available",
          savedSurface: "navigator",
        }),
      ).toEqual({ kind: "surface", surface: RIGHT_UTILITY_DOCK_SURFACES[3] });
    },
  );

  it("carries no Project identity on a host-owned surface even when one is active", () => {
    expect(resolveRightUtilityDockSurface({ ...validInput, savedSurface: "navigator" })).toEqual({
      kind: "surface",
      surface: RIGHT_UTILITY_DOCK_SURFACES[3],
    });
  });

  it("still fails a host-owned surface closed for reasons that are not about a Project", () => {
    expect(
      resolveRightUtilityDockSurface({
        activeMode: "chat",
        connectionState: "disconnected",
        presentationAvailability: "available",
        savedSurface: "navigator",
      }),
    ).toEqual({ kind: "closed", reason: "disconnected" });
  });

  it.each(["context", "project-memory", "code-environment", "plan"] as const)(
    "keeps Project-required surface %s closed with no active Project",
    (savedSurface) => {
      expect(
        resolveRightUtilityDockSurface({
          activeMode: "code",
          connectionState: "connected",
          presentationAvailability: "available",
          savedSurface,
        }),
      ).toEqual({ kind: "closed", reason: "project-required" });
    },
  );

  it.each([
    ["chat", projects.chat],
    ["work", projects.work],
    ["code", projects.code],
  ] as const)(
    "restores legacy project memory for a compatible active %s Project",
    (mode, activeProject) => {
      expect(
        resolveRightUtilityDockSurface({
          ...validInput,
          activeMode: mode,
          activeProject,
          savedSurface: "project-memory",
        }),
      ).toEqual({
        kind: "surface",
        projectId: projectIds.current,
        surface: RIGHT_UTILITY_DOCK_SURFACES[1],
      });
    },
  );

  it.each([
    ["chat", projects.chat],
    ["work", projects.work],
    ["code", projects.code],
  ] as const)("exposes Context for the active %s Project", (activeMode, activeProject) => {
    expect(
      resolveRightUtilityDockSurface({
        ...validInput,
        activeMode,
        activeProject,
        savedSurface: "context",
      }),
    ).toMatchObject({ kind: "surface", surface: { id: "context" } });
  });

  it.each([
    ["chat", "mode-invalid"],
    ["work", "mode-invalid"],
    ["code", "surface"],
  ] as const)("gates Code environment in %s", (activeMode, expectedKind) => {
    const resolution = resolveRightUtilityDockSurface({ ...validInput, activeMode });

    if (expectedKind === "surface") {
      expect(resolution.kind).toBe("surface");
    } else {
      expect(resolution).toEqual({ kind: "closed", reason: expectedKind });
    }
  });

  it.each([
    ["unknown", "unknown"],
    ["unavailable", "unavailable"],
    ["unauthorized", "unauthorized"],
  ] as const satisfies ReadonlyArray<readonly [RightUtilityDockSurfaceAvailability, string]>)(
    "fails closed when presentation availability is %s",
    (presentationAvailability, reason) => {
      expect(resolveRightUtilityDockSurface({ ...validInput, presentationAvailability })).toEqual({
        kind: "closed",
        reason,
      });
    },
  );

  it("fails closed while disconnected even when the saved surface was previously valid", () => {
    expect(
      resolveRightUtilityDockSurface({ ...validInput, connectionState: "disconnected" }),
    ).toEqual({ kind: "closed", reason: "disconnected" });
  });

  it.each([
    [null, "no-surface"],
    [undefined, "no-surface"],
    ["", "unknown-surface"],
    ["browser", "unknown-surface"],
    ["terminal", "unknown-surface"],
    [{ id: "project-memory" }, "unknown-surface"],
    [1, "unknown-surface"],
  ] as const)("fails closed for malformed persisted surface %j", (savedSurface, reason) => {
    expect(resolveRightUtilityDockSurface({ ...validInput, savedSurface })).toEqual({
      kind: "closed",
      reason,
    });
  });

  it.each([
    [undefined, projectIds.current, "project-required"],
    [projects.code, undefined, "project-stale"],
    [projects.code, projectIds.replaced, "project-stale"],
    [{ ...projects.code, lifecycle: "archived" }, projectIds.current, "project-incompatible"],
    [projects.chat, projectIds.current, "project-incompatible"],
  ] as const)(
    "fails closed for absent, archived, incompatible, or replaced Project identity %#",
    (activeProject, surfaceProjectId, reason) => {
      expect(
        resolveRightUtilityDockSurface({
          activeMode: validInput.activeMode,
          connectionState: validInput.connectionState,
          presentationAvailability: validInput.presentationAvailability,
          savedSurface: validInput.savedSurface,
          ...(activeProject === undefined ? {} : { activeProject }),
          ...(surfaceProjectId === undefined ? {} : { surfaceProjectId }),
        }),
      ).toEqual({ kind: "closed", reason });
    },
  );

  it("requires Code environment to have a truthful bound Code Project", () => {
    const { binding: _binding, ...unboundCodeProject } = projects.code;

    expect(
      resolveRightUtilityDockSurface({
        ...validInput,
        activeProject: unboundCodeProject,
      }),
    ).toEqual({ kind: "closed", reason: "project-incompatible" });
  });

  it.each(["work", "code"] as const)(
    "requires project memory to have a truthful bound %s Project",
    (activeMode) => {
      const { binding: _binding, ...unboundProject } = projects[activeMode];

      expect(
        resolveRightUtilityDockSurface({
          ...validInput,
          activeMode,
          activeProject: unboundProject,
          savedSurface: "project-memory",
        }),
      ).toEqual({ kind: "closed", reason: "project-incompatible" });
    },
  );

  it("does not let a compatible Project make a surface available", () => {
    expect(
      resolveRightUtilityDockSurface({
        ...validInput,
        savedSurface: "project-memory",
        presentationAvailability: "unauthorized",
      }),
    ).toEqual({ kind: "closed", reason: "unauthorized" });
  });
});

function project(type: OctantMode): RightUtilityDockProject {
  return {
    id: projectIds.current,
    type,
    lifecycle: "active",
    ...(type === "chat" ? {} : { binding: { canonicalRoot: `/workspace/${type}` } }),
  };
}
