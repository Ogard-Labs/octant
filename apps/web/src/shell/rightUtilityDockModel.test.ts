import type { OctantMode } from "@octant/contracts/modes";
import { MAX_CONTEXT_SIDEBAR_WIDTH, MIN_CONTEXT_SIDEBAR_WIDTH } from "@octant/contracts/shell";
import { describe, expect, it } from "vitest";
import {
  RIGHT_UTILITY_DOCK_SURFACES,
  dockWidthCeiling,
  resolveDockPresentationWidth,
  resolveRightUtilityDockSurface,
  TILED_DOCK_WIDTH,
  WORKBENCH_DOCK_WIDTH,
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

describe("how wide the right utility dock is", () => {
  const narrow = { storedWidth: 360, widthChosen: false };

  it("stays one width from the empty launcher to any tool, so a click moves nothing", () => {
    expect(resolveDockPresentationWidth({ ...narrow, tabSurfaces: [] })).toBe(360);
    expect(resolveDockPresentationWidth({ ...narrow, tabSurfaces: ["environment"] })).toBe(360);
  });

  it("holds the Browser's width while its tab is open, whichever tab is in front", () => {
    expect(
      resolveDockPresentationWidth({ ...narrow, tabSurfaces: ["environment", "browser"] }),
    ).toBe(WORKBENCH_DOCK_WIDTH);
  });

  it("returns to the saved width once the Browser closes", () => {
    expect(resolveDockPresentationWidth({ ...narrow, tabSurfaces: ["environment"] })).toBe(360);
  });

  it("leaves a wider saved dock alone", () => {
    expect(
      resolveDockPresentationWidth({
        storedWidth: 800,
        widthChosen: false,
        tabSurfaces: ["terminal"],
      }),
    ).toBe(800);
  });

  it("keeps a width the person dragged to, even narrower than a Browser asks for", () => {
    expect(
      resolveDockPresentationWidth({
        storedWidth: 420,
        widthChosen: true,
        tabSurfaces: ["browser"],
      }),
    ).toBe(420);
  });

  it("widens the dock to fit two columns of tools until the person sizes it", () => {
    const tiled = { ...narrow, tabSurfaces: ["ios-simulator", "canvas"], tileColumns: 2 };
    expect(resolveDockPresentationWidth(tiled)).toBe(TILED_DOCK_WIDTH);
    expect(resolveDockPresentationWidth({ ...tiled, widthChosen: true })).toBe(360);
    expect(resolveDockPresentationWidth({ ...tiled, storedWidth: 900 })).toBe(900);
  });

  it("asks for no extra width for one column of tiles", () => {
    expect(
      resolveDockPresentationWidth({ ...narrow, tabSurfaces: ["canvas"], tileColumns: 1 }),
    ).toBe(360);
  });
});

describe("how wide the right utility dock may get", () => {
  it("takes at most half the workspace, so a stored 960px cannot squeeze the thread", () => {
    expect(dockWidthCeiling(1268)).toBe(634);
    expect(dockWidthCeiling(2600)).toBe(MAX_CONTEXT_SIDEBAR_WIDTH);
  });

  it("keeps the minimum in a window too narrow for half to fit a tool", () => {
    expect(dockWidthCeiling(400)).toBe(MIN_CONTEXT_SIDEBAR_WIDTH);
  });

  it("does not guess before the workspace has been measured", () => {
    expect(dockWidthCeiling(undefined)).toBe(MAX_CONTEXT_SIDEBAR_WIDTH);
  });
});

describe("resolving what the right utility dock shows", () => {
  it("publishes only the live thread-owned surfaces in stable order", () => {
    expect(RIGHT_UTILITY_DOCK_SURFACES).toEqual([
      {
        id: "environment",
        label: "Environment",
        modes: ["work", "code"],
        scope: "thread",
      },
      {
        id: "side-chat",
        label: "Side Chat",
        modes: ["work", "code"],
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
        modes: ["work", "code"],
        scope: "thread",
      },
      {
        id: "plan",
        label: "Plan",
        modes: ["work", "code"],
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
        id: "pull-requests",
        label: "Pull requests",
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
      {
        id: "android-emulator",
        label: "Android emulator",
        modes: ["code"],
        scope: "thread",
      },
      {
        id: "desktop",
        label: "Desktop",
        modes: ["code"],
        scope: "thread",
      },
      {
        id: "debug",
        label: "Run and debug",
        modes: ["code"],
        scope: "thread",
      },
      {
        id: "vitals",
        label: "Vitals",
        modes: ["work", "code"],
        scope: "thread",
      },
      {
        id: "artifacts",
        label: "Artifacts",
        modes: ["work", "code"],
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

  it("offers only Agents for a Chat thread", () => {
    for (const { id } of RIGHT_UTILITY_DOCK_SURFACES) {
      expect(
        resolveRightUtilityDockSurface({
          activeMode: "chat",
          activeThreadId: "30000000-0000-4000-8000-000000000003",
          connectionState: "connected",
          presentationAvailability: "available",
          savedSurface: id,
        }),
      ).toEqual(
        id === "agents"
          ? { kind: "surface", surface: surface("agents") }
          : { kind: "closed", reason: "mode-invalid" },
      );
    }
  });

  it("closes a restored pull-request list on a Work thread instead of promising a list", () => {
    // A Work Project has no authorized pull-request source, so the tool would
    // only ever render the dock's "no pull-request source" state there.
    expect(
      resolveRightUtilityDockSurface({
        activeMode: "work",
        activeThreadId: "30000000-0000-4000-8000-000000000003",
        connectionState: "connected",
        presentationAvailability: "available",
        savedSurface: "pull-requests",
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

describe("how wide the dock may get with two columns of tools", () => {
  // Workspace widths are the window less a 260px sidebar.
  it("keeps half of the workspace for one column", () => {
    expect(dockWidthCeiling(840, { tileColumns: 1, viewportWidth: 1100 })).toBe(420);
    expect(dockWidthCeiling(1180, { tileColumns: 1, viewportWidth: 1440 })).toBe(590);
    expect(dockWidthCeiling(1468, { tileColumns: 1, viewportWidth: 1728 })).toBe(
      Math.min(MAX_CONTEXT_SIDEBAR_WIDTH, 734),
    );
    expect(dockWidthCeiling(1180, { viewportWidth: 1440 })).toBe(590);
  });

  it("leaves a thread 440px beside two columns from 1100px up", () => {
    // At 560px two tools could never stand side by side in a 1440px window.
    expect(dockWidthCeiling(840, { tileColumns: 2, viewportWidth: 1100 })).toBe(400);
    expect(dockWidthCeiling(1180, { tileColumns: 2, viewportWidth: 1440 })).toBe(740);
    expect(dockWidthCeiling(1468, { tileColumns: 2, viewportWidth: 1728 })).toBe(
      Math.min(MAX_CONTEXT_SIDEBAR_WIDTH, 1028),
    );
  });

  it("uses the smaller thread minimum below 1100px, as the stylesheet does", () => {
    expect(dockWidthCeiling(900, { tileColumns: 2, viewportWidth: 1000 })).toBe(540);
  });
});
