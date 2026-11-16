import type { OctantMode } from "@octant/contracts/modes";
import { MAX_CONTEXT_SIDEBAR_WIDTH, MIN_CONTEXT_SIDEBAR_WIDTH } from "@octant/contracts/shell";
import { describe, expect, it } from "vitest";
import {
  RIGHT_UTILITY_DOCK_SURFACES,
  dockTotalWidth,
  dockWidthCeiling,
  COMPACT_DOCK_WIDTH,
  dockColumnIsFixed,
  ENVIRONMENT_STRIP_WIDTH,
  FLEXIBLE_DOCK_MIN_WIDTH,
  flexibleDockMinimum,
  resolveDockPresentationWidth,
  resolveRightUtilityDockSurface,
  TILED_DOCK_WIDTH,
  WIDE_PRIMARY_MIN,
  resolveTwoColumnDockWidth,
  threadBoxMinimum,
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

  it("holds the workbench width for any open flexible tool, whichever tab is in front", () => {
    for (const tool of [
      "review",
      "canvas",
      "files",
      "terminal",
      "browser",
      "document",
      "ios-simulator",
      "android-emulator",
      "desktop",
    ]) {
      expect(resolveDockPresentationWidth({ ...narrow, tabSurfaces: ["environment", tool] })).toBe(
        WORKBENCH_DOCK_WIDTH,
      );
    }
  });

  it("opens a column of panel tools at 360 and never moves it, however wide the dock was dragged", () => {
    for (const tool of ["vitals", "plan", "agents", "delivery", "side-chat", "pull-requests"]) {
      const tabSurfaces = ["environment", tool];
      expect(resolveDockPresentationWidth({ ...narrow, tabSurfaces })).toBe(COMPACT_DOCK_WIDTH);
      expect(
        resolveDockPresentationWidth({ storedWidth: 700, widthChosen: true, tabSurfaces }),
      ).toBe(COMPACT_DOCK_WIDTH);
      expect(dockColumnIsFixed(tabSurfaces)).toBe(true);
    }
    expect(COMPACT_DOCK_WIDTH).toBe(360);
  });

  it("gives a flexible tool beside a fixed one the flexible width and a handle", () => {
    const tabSurfaces = ["environment", "vitals", "browser"];
    expect(resolveDockPresentationWidth({ ...narrow, tabSurfaces })).toBe(WORKBENCH_DOCK_WIDTH);
    expect(dockColumnIsFixed(tabSurfaces)).toBe(false);
    expect(dockColumnIsFixed(["environment"])).toBe(false);
  });

  it("holds a flexible column to a 480px minimum and the dock's ceiling as its maximum", () => {
    expect(
      resolveDockPresentationWidth({ storedWidth: 300, widthChosen: true, tabSurfaces: ["files"] }),
    ).toBe(FLEXIBLE_DOCK_MIN_WIDTH);
    expect(FLEXIBLE_DOCK_MIN_WIDTH).toBe(480);
    expect(flexibleDockMinimum(1000)).toBe(480);
    expect(flexibleDockMinimum(400)).toBe(400);
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
    ).toBe(FLEXIBLE_DOCK_MIN_WIDTH);
  });

  it("keeps one width for the tool columns however many tools stack in them", () => {
    const stacked = { ...narrow, tabSurfaces: ["ios-simulator", "canvas", "files"] };
    expect(resolveDockPresentationWidth(stacked)).toBe(WORKBENCH_DOCK_WIDTH);
    expect(resolveDockPresentationWidth({ ...narrow, tabSurfaces: ["canvas"] })).toBe(
      WORKBENCH_DOCK_WIDTH,
    );
  });

  it("asks for two usable columns side by side, or the wider width a person dragged to", () => {
    expect(TILED_DOCK_WIDTH).toBe(2 * FLEXIBLE_DOCK_MIN_WIDTH);
    expect(resolveTwoColumnDockWidth({ storedWidth: 420, widthChosen: false })).toBe(
      TILED_DOCK_WIDTH,
    );
    expect(resolveTwoColumnDockWidth({ storedWidth: 700, widthChosen: true })).toBe(
      TILED_DOCK_WIDTH,
    );
    expect(resolveTwoColumnDockWidth({ storedWidth: 1100, widthChosen: true })).toBe(1100);
  });
});

describe("how wide the whole dock is around the Environment strip", () => {
  it("is exactly the strip while only Environment is open", () => {
    expect(dockTotalWidth({ toolsWidth: 640, environmentOpen: true, toolsShown: false })).toBe(
      ENVIRONMENT_STRIP_WIDTH,
    );
  });

  it("adds the tool columns to the strip without changing the strip", () => {
    expect(dockTotalWidth({ toolsWidth: 640, environmentOpen: true, toolsShown: true })).toBe(
      ENVIRONMENT_STRIP_WIDTH + 640,
    );
  });

  it("is only the tool columns while Environment is closed", () => {
    expect(dockTotalWidth({ toolsWidth: 640, environmentOpen: false, toolsShown: true })).toBe(640);
  });

  it("keeps the strip at 300px", () => {
    expect(ENVIRONMENT_STRIP_WIDTH).toBe(300);
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

  it("leaves the thread's minimum and Environment out of what the tool columns may take", () => {
    const options = { tileColumns: 2, viewportWidth: 1400 };
    // With Environment closed the thread box still keeps its own minimum.
    expect(dockWidthCeiling(1268, options)).toBe(1268 - threadBoxMinimum(1268, 1400));
    expect(dockWidthCeiling(1268, { ...options, reservedWidth: ENVIRONMENT_STRIP_WIDTH })).toBe(
      1268 - ENVIRONMENT_STRIP_WIDTH - WIDE_PRIMARY_MIN,
    );
    // One column beside Environment: the same room, and never past half.
    expect(
      dockWidthCeiling(1268, { viewportWidth: 1600, reservedWidth: ENVIRONMENT_STRIP_WIDTH }),
    ).toBe(408);
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
  it("keeps half of the workspace for one column where the thread's minimum leaves it", () => {
    expect(dockWidthCeiling(840, { tileColumns: 1, viewportWidth: 1100 })).toBe(280);
    expect(dockWidthCeiling(1180, { tileColumns: 1, viewportWidth: 1440 })).toBe(590);
    // From here up the thread box's minimum, not half the workspace, is the stop.
    expect(dockWidthCeiling(1468, { tileColumns: 1, viewportWidth: 1728 })).toBe(640);
    expect(dockWidthCeiling(2068, { tileColumns: 1, viewportWidth: 2400 })).toBe(
      Math.min(MAX_CONTEXT_SIDEBAR_WIDTH, 1034),
    );
    expect(dockWidthCeiling(1180, { viewportWidth: 1440 })).toBe(590);
  });

  it("keeps the thread's 560px beside two columns too, from 1100px up", () => {
    // A second column never asks the thread for less than one column does.
    expect(dockWidthCeiling(840, { tileColumns: 2, viewportWidth: 1100 })).toBe(280);
    expect(dockWidthCeiling(1180, { tileColumns: 2, viewportWidth: 1440 })).toBe(620);
    expect(dockWidthCeiling(1468, { tileColumns: 2, viewportWidth: 1728 })).toBe(640);
    expect(dockWidthCeiling(2068, { tileColumns: 2, viewportWidth: 2400 })).toBe(
      Math.min(MAX_CONTEXT_SIDEBAR_WIDTH, 2068 - WIDE_PRIMARY_MIN - ENVIRONMENT_STRIP_WIDTH),
    );
  });

  it("uses the smaller thread minimum below 1100px, as the stylesheet does", () => {
    expect(dockWidthCeiling(900, { tileColumns: 2, viewportWidth: 1000 })).toBe(540);
  });
});

describe("the narrowest the thread box gets", () => {
  // The thread header's tool row ends on this line, so it is the one number
  // every dock state has to respect for the row to stay where it is.
  it("is the thread's minimum and the Environment section where a 640px tool region fits beside them", () => {
    expect(threadBoxMinimum(1500, 1836)).toBe(WIDE_PRIMARY_MIN + ENVIRONMENT_STRIP_WIDTH);
    expect(threadBoxMinimum(2068, 2400)).toBe(860);
  });

  it("is what a 640px tool region leaves in a workspace between 1200px and 1500px", () => {
    expect(threadBoxMinimum(1464, 1800)).toBe(824);
    expect(threadBoxMinimum(1200, 1536)).toBe(WIDE_PRIMARY_MIN);
  });

  it("is the thread's own minimum under that, less only where a 280px tool column would not fit", () => {
    expect(threadBoxMinimum(1064, 1400)).toBe(WIDE_PRIMARY_MIN);
    expect(threadBoxMinimum(764, 1100)).toBe(484);
    expect(threadBoxMinimum(600, 1100)).toBe(360);
    // Under 1100px the thread's minimum is the smaller one.
    expect(threadBoxMinimum(900, 1000)).toBe(360);
  });

  it("leaves the tool region the same room whether Environment is open or closed where the window holds both", () => {
    for (const [workspace, viewport] of [
      [1464, 1800],
      [2068, 2400],
    ] as const) {
      for (const tileColumns of [1, 2]) {
        const closed = dockWidthCeiling(workspace, { tileColumns, viewportWidth: viewport });
        const open = dockWidthCeiling(workspace, {
          tileColumns,
          viewportWidth: viewport,
          reservedWidth: ENVIRONMENT_STRIP_WIDTH,
        });
        // The thread box (thread plus section) never goes under its minimum.
        expect(workspace - closed).toBeGreaterThanOrEqual(threadBoxMinimum(workspace, viewport));
        expect(workspace - open).toBeGreaterThanOrEqual(threadBoxMinimum(workspace, viewport));
      }
    }
  });
});
