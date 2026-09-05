import type { OctantMode } from "@octant/contracts/modes";
import { describe, expect, it } from "vitest";
import {
  RIGHT_UTILITY_DOCK_SURFACES,
  resolveRightUtilityDockSurface,
  type RightUtilityDockResolutionInput,
  type RightUtilityDockSurfaceAvailability,
  MULTI_INSTANCE_DOCK_SURFACES,
} from "./rightUtilityDockModel";

const validInput = {
  activeMode: "code",
  activeThreadId: "30000000-0000-4000-8000-000000000003",
  connectionState: "connected",
  presentationAvailability: "available",
  savedSurface: "browser",
} as const satisfies RightUtilityDockResolutionInput;

function surface(id: (typeof RIGHT_UTILITY_DOCK_SURFACES)[number]["id"]) {
  const found = RIGHT_UTILITY_DOCK_SURFACES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing ${id} dock surface.`);
  return found;
}

describe("resolving what the right utility dock shows", () => {
  it("publishes only the live thread-owned surfaces in stable order", () => {
    expect(RIGHT_UTILITY_DOCK_SURFACES).toEqual([
      {
        id: "environment",
        label: "Environment",
        modes: ["chat", "work", "code"],
        scope: "thread",
      },
      {
        id: "side-chat",
        label: "Side Chat",
        modes: ["chat", "work", "code"],
        scope: "thread",
      },
      {
        id: "browser",
        label: "Browser",
        modes: ["work", "code"],
        scope: "thread",
      },
      {
        id: "files",
        label: "Files",
        modes: ["work", "code"],
        scope: "thread",
      },
      {
        id: "document",
        label: "Document",
        modes: ["code"],
        scope: "thread",
      },
      {
        id: "canvas",
        label: "Canvas",
        modes: ["chat", "work", "code"],
        scope: "thread",
      },
      {
        id: "plan",
        label: "Plan",
        modes: ["chat", "work", "code"],
        scope: "thread",
      },
      {
        id: "delivery",
        label: "Delivery",
        modes: ["code"],
        scope: "thread",
      },
      {
        id: "agents",
        label: "Agents",
        modes: ["chat", "work", "code"],
        scope: "thread",
      },
      {
        id: "review",
        label: "Review",
        modes: ["code"],
        scope: "thread",
      },
      {
        id: "terminal",
        label: "Terminal",
        modes: ["code"],
        scope: "thread",
      },
      {
        id: "tests",
        label: "Tests",
        modes: ["code"],
        scope: "thread",
      },
      {
        id: "ios-simulator",
        label: "iOS Simulator",
        modes: ["code"],
        scope: "thread",
      },
    ]);
  });

  it("opens a utility for the thread the active pane holds", () => {
    expect(resolveRightUtilityDockSurface(validInput)).toEqual({
      kind: "surface",
      surface: surface("browser"),
    });
  });

  it("keeps a thread utility selected but empty-handed when the active pane holds no thread", () => {
    expect(
      resolveRightUtilityDockSurface({
        activeMode: "code",
        connectionState: "connected",
        presentationAvailability: "available",
        savedSurface: "terminal",
      }),
    ).toMatchObject({
      kind: "unavailable",
      reason: "thread-required",
      surface: { id: "terminal" },
    });
  });

  it("opens Review without a thread when a Project pull request is selected in the central list", () => {
    expect(
      resolveRightUtilityDockSurface({
        activeMode: "code",
        connectionState: "connected",
        presentationAvailability: "available",
        savedSurface: "review",
        projectPullRequestReviewOpen: true,
      }),
    ).toEqual({
      kind: "surface",
      surface: surface("review"),
    });
  });

  it("does not offer a mode-incompatible utility", () => {
    expect(
      resolveRightUtilityDockSurface({
        activeMode: "chat",
        activeThreadId: "30000000-0000-4000-8000-000000000003",
        connectionState: "connected",
        presentationAvailability: "available",
        savedSurface: "browser",
      }),
    ).toEqual({ kind: "closed", reason: "mode-invalid" });
  });

  it("opens Review for a dock that still names the retired Changes id", () => {
    expect(
      resolveRightUtilityDockSurface({
        ...validInput,
        savedSurface: "changes",
      }),
    ).toEqual({
      kind: "surface",
      surface: surface("review"),
    });
  });

  it.each(["context", "project-memory", "navigator", "code-environment", "thread"] as const)(
    "refuses a restored %s tab and opens nothing",
    (savedSurface) => {
      expect(
        resolveRightUtilityDockSurface({
          ...validInput,
          savedSurface,
        }),
      ).toEqual({ kind: "closed", reason: "unknown-surface" });
    },
  );

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
    [{ id: "browser" }, "unknown-surface"],
    [1, "unknown-surface"],
  ] as const)("fails closed for malformed persisted surface %j", (savedSurface, reason) => {
    expect(resolveRightUtilityDockSurface({ ...validInput, savedSurface })).toEqual({
      kind: "closed",
      reason,
    });
  });

  it.each(["chat", "work", "code"] as const)(
    "does not let a %s Project keep a retired category tab open",
    (activeMode: OctantMode) => {
      expect(
        resolveRightUtilityDockSurface({
          activeMode,
          activeThreadId: "30000000-0000-4000-8000-000000000003",
          connectionState: "connected",
          presentationAvailability: "available",
          savedSurface: "project-memory",
        }),
      ).toEqual({ kind: "closed", reason: "unknown-surface" });
    },
  );
});

describe("multi-instance dock surfaces", () => {
  it("lets a reader keep several terminals and browsers open at once", () => {
    expect(MULTI_INSTANCE_DOCK_SURFACES.has("terminal")).toBe(true);
    expect(MULTI_INSTANCE_DOCK_SURFACES.has("browser")).toBe(true);
  });

  it("keeps a thread's single views single", () => {
    for (const surface of ["environment", "plan", "review", "files", "tests"]) {
      expect(MULTI_INSTANCE_DOCK_SURFACES.has(surface)).toBe(false);
    }
  });
});
