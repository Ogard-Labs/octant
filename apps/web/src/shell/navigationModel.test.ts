import type { OctantMode } from "@octant/contracts/modes";
import { describe, expect, it } from "vitest";
import {
  buildChatThreadNavigation,
  buildSidebarAppMenu,
  buildSidebarNavigation,
  layoutSidebarDestinations,
  moveSidebarDestination,
  type NavigationAvailability,
  setSidebarDestinationVisibility,
  sidebarDestinationOrder,
  sidebarDestinationVisibility,
  type SidebarNavigationDescriptorId,
  type SidebarNavigationInput,
} from "./navigationModel";

const unavailableCapabilities = {
  createThread: "unavailable",
  inbox: "unavailable",
  projects: "unavailable",
  threadBoard: "unavailable",
  pullRequests: "unavailable",
  githubIssues: "unavailable",
  linearIssues: "unavailable",
  plugins: "unavailable",
  automationsEnabled: false,
  agentsCenterEnabled: false,
  artifactLibrary: "unavailable" as const,
} as const;

const availableBaseCapabilities = {
  ...unavailableCapabilities,
  createThread: "available",
  projects: "available",
} as const;

const codeCapabilities: SidebarNavigationInput = {
  activeMode: "code",
  createThread: "available",
  inbox: "available",
  projects: "available",
  threadBoard: "available",
  pullRequests: "available",
  githubIssues: "available",
  linearIssues: "available",
  plugins: "available",
  automationsEnabled: true,
  agentsCenterEnabled: true,
  artifactLibrary: "available",
  imageLibrary: "available",
};

const untouched = { order: [], visibility: [] } as const;

describe("layoutSidebarDestinations", () => {
  it("keeps the default rows and menu when nobody has customized the sidebar", () => {
    const layout = layoutSidebarDestinations({
      activeMode: "code",
      input: codeCapabilities,
      customization: untouched,
    });
    expect(layout.rows).toEqual([
      "new-code-thread",
      "inbox",
      "thread-board",
      "github-issues",
      "pull-requests",
      "linear-issues",
      "projects",
    ]);
    expect(layout.menu.map((descriptor) => descriptor.id)).toEqual([
      "agents",
      "automations",
      "artifact-library",
      "image-library",
      "plugins",
    ]);
  });

  it("removes a hidden primary destination from the rows", () => {
    const layout = layoutSidebarDestinations({
      activeMode: "code",
      input: codeCapabilities,
      customization: { order: [], visibility: [{ id: "inbox", visibility: "hidden" }] },
    });
    expect(layout.rows).toEqual([
      "new-code-thread",
      "thread-board",
      "github-issues",
      "pull-requests",
      "linear-issues",
      "projects",
    ]);
  });

  it("promotes a menu destination to a row and stops repeating it in the menu", () => {
    const layout = layoutSidebarDestinations({
      activeMode: "code",
      input: codeCapabilities,
      customization: { order: [], visibility: [{ id: "automations", visibility: "shown" }] },
    });
    expect(layout.rows).toContain("automations");
    expect(layout.menu.map((descriptor) => descriptor.id)).not.toContain("automations");
  });

  it("orders the rows by the customized order and appends unlisted rows in the default order", () => {
    const layout = layoutSidebarDestinations({
      activeMode: "code",
      input: codeCapabilities,
      customization: { order: ["board", "inbox"], visibility: [] },
    });
    expect(layout.rows.slice(0, 2)).toEqual(["thread-board", "inbox"]);
    expect(layout.rows.slice(2)).toEqual([
      "new-code-thread",
      "github-issues",
      "pull-requests",
      "linear-issues",
      "projects",
    ]);
  });

  it("keeps an unavailable destination out of the rows even when it is set to show", () => {
    const layout = layoutSidebarDestinations({
      activeMode: "code",
      input: { ...codeCapabilities, plugins: "unavailable", imageLibrary: "unavailable" },
      customization: {
        order: [],
        visibility: [
          { id: "plugins", visibility: "shown" },
          { id: "image-library", visibility: "shown" },
        ],
      },
    });
    expect(layout.rows).not.toContain("plugins");
    expect(layout.rows).not.toContain("image-library");
    expect(layout.menu.map((descriptor) => descriptor.id)).not.toContain("plugins");
  });

  it("hides a destination from the menu too, because Don't show means don't show", () => {
    const layout = layoutSidebarDestinations({
      activeMode: "code",
      input: codeCapabilities,
      customization: { order: [], visibility: [{ id: "plugins", visibility: "hidden" }] },
    });
    expect(layout.menu.map((descriptor) => descriptor.id)).not.toContain("plugins");
  });

  it("never promotes Automations into Chat, where the center has no authority", () => {
    const layout = layoutSidebarDestinations({
      activeMode: "chat",
      input: { ...codeCapabilities, activeMode: "chat", threadBoard: "unavailable" },
      customization: { order: [], visibility: [{ id: "automations", visibility: "shown" }] },
    });
    expect(layout.rows).not.toContain("automations");
  });

  it("resolves the mode's thread creator so one destination names every mode's row", () => {
    for (const [activeMode, descriptor] of [
      ["chat", "new-chat"],
      ["work", "new-work-thread"],
      ["code", "new-code-thread"],
    ] as const) {
      const layout = layoutSidebarDestinations({
        activeMode,
        input: { ...codeCapabilities, activeMode },
        customization: untouched,
      });
      expect(layout.rows[0]).toBe(descriptor);
    }
  });
});

describe("sidebar destination preference helpers", () => {
  it("records only deviations from the default visibility", () => {
    const hidden = setSidebarDestinationVisibility(untouched, "inbox", "hidden");
    expect(hidden.visibility).toEqual([{ id: "inbox", visibility: "hidden" }]);
    expect(setSidebarDestinationVisibility(hidden, "inbox", "shown").visibility).toEqual([]);

    const promoted = setSidebarDestinationVisibility(untouched, "plugins", "shown");
    expect(promoted.visibility).toEqual([{ id: "plugins", visibility: "shown" }]);
    expect(setSidebarDestinationVisibility(promoted, "plugins", "menu").visibility).toEqual([]);
  });

  it("reports the effective visibility a reader of the sidebar sees", () => {
    const customized = {
      order: [],
      visibility: [
        { id: "inbox", visibility: "hidden" },
        { id: "plugins", visibility: "shown" },
      ],
    } as const;
    expect(sidebarDestinationVisibility(customized, "inbox")).toBe("hidden");
    expect(sidebarDestinationVisibility(customized, "plugins")).toBe("shown");
    expect(sidebarDestinationVisibility(customized, "automations")).toBe("menu");
    expect(sidebarDestinationVisibility(untouched, "inbox")).toBe("shown");
  });

  it("swaps a destination with its neighbour and stores only the arrangement that differs", () => {
    const moved = moveSidebarDestination(untouched, "inbox", "down");
    expect(moved.order[0]).toBe("new-thread");
    expect(moved.order.slice(1, 3)).toEqual(["board", "inbox"]);
    const restored = moveSidebarDestination(moved, "inbox", "up");
    expect(
      sidebarDestinationOrder(restored)
        .map((destination) => destination.id)
        .slice(0, 3),
    ).toEqual(["new-thread", "inbox", "board"]);
    // Back at the untouched shell, nothing deviates from canonical order.
    expect(restored.order).toEqual([]);
  });
});

describe("buildSidebarNavigation", () => {
  it.each([
    ["chat", ["new-chat", "projects"]],
    ["work", ["new-work-thread", "projects"]],
    ["code", ["new-code-thread", "projects"]],
  ] as const)("returns the approved stable ordering for %s", (activeMode, expectedIds) => {
    expect(descriptorIds({ activeMode, ...availableBaseCapabilities })).toEqual(expectedIds);
  });

  it("keeps secondary destinations out of primary navigation", () => {
    const capabilities = {
      ...availableBaseCapabilities,
      threadBoard: "available" as const,
      pullRequests: "available" as const,
      githubIssues: "available" as const,
      linearIssues: "available" as const,
      plugins: "available" as const,
      automationsEnabled: true,
      artifactLibrary: "unavailable" as const,
    } as const;

    expect(descriptorIds({ activeMode: "chat", ...capabilities })).toEqual([
      "new-chat",
      "projects",
    ]);
    expect(descriptorIds({ activeMode: "work", ...capabilities })).toEqual([
      "new-work-thread",
      "thread-board",
      "projects",
    ]);
    expect(descriptorIds({ activeMode: "code", ...capabilities })).toEqual([
      "new-code-thread",
      "thread-board",
      "github-issues",
      "pull-requests",
      "linear-issues",
      "projects",
    ]);
  });

  it("groups capability-backed secondary destinations in the app menu", () => {
    expect(
      buildSidebarAppMenu({
        activeMode: "code",
        ...availableBaseCapabilities,
        agentsCenterEnabled: true,
        automationsEnabled: true,
        artifactLibrary: "available",
        plugins: "available",
      }).map((descriptor) => descriptor.id),
    ).toEqual(["agents", "automations", "artifact-library", "plugins"]);
  });

  it("offers the Image generator only when the host serves image generation", () => {
    const ids = (imageLibrary: "available" | "unavailable") =>
      buildSidebarAppMenu({
        ...availableBaseCapabilities,
        activeMode: "code",
        agentsCenterEnabled: false,
        automationsEnabled: false,
        artifactLibrary: "available",
        imageLibrary,
        plugins: "unavailable",
      }).map((descriptor) => descriptor.id);
    expect(ids("available")).toEqual(["artifact-library", "image-library"]);
    expect(ids("unavailable")).toEqual(["artifact-library"]);
  });

  it.each(["disabled", "unavailable", "unauthorized"] as const)(
    "omits %s capabilities rather than presenting false authority",
    (availability) => {
      expect(
        descriptorIds({
          activeMode: "code",
          createThread: availability,
          inbox: availability,
          projects: availability,
          threadBoard: availability,
          pullRequests: availability,
          githubIssues: availability,
          linearIssues: availability,
          plugins: availability,
          automationsEnabled: false,
          agentsCenterEnabled: false,
          artifactLibrary: "unavailable" as const,
        }),
      ).toEqual([]);
    },
  );

  it.each([
    ["chat", "createThread", "new-chat"],
    ["chat", "projects", "projects"],
    ["work", "createThread", "new-work-thread"],
    ["work", "projects", "projects"],
    ["code", "createThread", "new-code-thread"],
    ["code", "projects", "projects"],
    ["code", "githubIssues", "github-issues"],
  ] as const)("gates %s %s independently", (activeMode, capability, expectedId) => {
    expect(
      descriptorIds({
        activeMode,
        ...unavailableCapabilities,
        [capability]: "available",
      }),
    ).toEqual([expectedId]);
  });

  it("offers no flat thread destination, because Projects already nests every thread", () => {
    const ids = new Set<string>(
      (["chat", "work", "code"] as const).flatMap((activeMode) =>
        descriptorIds({ activeMode, ...availableBaseCapabilities, plugins: "available" }),
      ),
    );

    expect(ids.has("threads")).toBe(false);
    expect(ids.has("recent-chats")).toBe(false);
    // Search is a mode-switcher icon, not a navigation row.
    expect(ids.has("search")).toBe(false);
  });

  it("never exposes secondary destinations in primary navigation", () => {
    expect(
      descriptorIds({
        activeMode: "chat",
        ...availableBaseCapabilities,
        automationsEnabled: true,
        artifactLibrary: "unavailable" as const,
      }),
    ).toEqual(["new-chat", "projects"]);
  });

  it("returns Octant-owned labels without fabricating project or thread records", () => {
    expect(buildSidebarNavigation({ activeMode: "chat", ...availableBaseCapabilities })).toEqual([
      { id: "new-chat", label: "New chat" },
      { id: "projects", label: "Projects" },
    ]);
    expect(buildSidebarNavigation({ activeMode: "code", ...availableBaseCapabilities })).toEqual([
      { id: "new-code-thread", label: "New task" },
      { id: "projects", label: "Projects" },
    ]);
  });

  it("keeps session-local unread separate from durable follow-up on thread rows", () => {
    expect(
      buildChatThreadNavigation([
        {
          followUpOpen: true,
          lastSequence: 4,
          projectId: "00000000-0000-4000-8000-000000000201",
          readSequence: 4,
          threadId: "00000000-0000-4000-8000-000000000101",
          title: "Planning",
        },
        {
          followUpOpen: false,
          lastSequence: 3,
          readSequence: 1,
          threadId: "00000000-0000-4000-8000-000000000102",
          title: "Research",
        },
      ]),
    ).toEqual([
      {
        followUp: true,
        projectId: "00000000-0000-4000-8000-000000000201",
        threadId: "00000000-0000-4000-8000-000000000101",
        title: "Planning",
        unread: false,
      },
      {
        followUp: false,
        threadId: "00000000-0000-4000-8000-000000000102",
        title: "Research",
        unread: true,
      },
    ]);
  });

  it("marks a row working while the host projects the thread as executing", () => {
    expect(
      buildChatThreadNavigation([
        {
          executing: true,
          followUpOpen: true,
          lastSequence: 4,
          readSequence: 4,
          threadId: "00000000-0000-4000-8000-000000000101",
          title: "Planning",
        },
        {
          executing: false,
          followUpOpen: false,
          lastSequence: 3,
          readSequence: 1,
          threadId: "00000000-0000-4000-8000-000000000102",
          title: "Research",
        },
      ]),
    ).toEqual([
      {
        activity: "working",
        followUp: true,
        threadId: "00000000-0000-4000-8000-000000000101",
        title: "Planning",
        unread: false,
      },
      {
        followUp: false,
        threadId: "00000000-0000-4000-8000-000000000102",
        title: "Research",
        unread: true,
      },
    ]);
  });

  it("forwards last activity when the source includes updatedAt", () => {
    expect(
      buildChatThreadNavigation([
        {
          readSequence: 0,
          threadId: "00000000-0000-4000-8000-000000000101",
          title: "Planning",
          updatedAt: "2026-08-14T12:00:00.000Z",
        },
      ]),
    ).toEqual([
      {
        threadId: "00000000-0000-4000-8000-000000000101",
        title: "Planning",
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
    ]);
  });

  it("forwards the source provider instance so the shared row can resolve its mark", () => {
    expect(
      buildChatThreadNavigation([
        {
          providerInstanceId: "00000000-0000-4000-8000-000000000901",
          readSequence: 0,
          threadId: "00000000-0000-4000-8000-000000000101",
          title: "Provider thread",
        },
      ]),
    ).toEqual([
      {
        providerInstanceId: "00000000-0000-4000-8000-000000000901",
        threadId: "00000000-0000-4000-8000-000000000101",
        title: "Provider thread",
      },
    ]);
  });

  it("passes lineageParentThreadId through when the source carries it", () => {
    expect(
      buildChatThreadNavigation([
        {
          lineageParentThreadId: "00000000-0000-4000-8000-000000000100",
          readSequence: 0,
          threadId: "00000000-0000-4000-8000-000000000101",
          title: "Restored",
        },
      ]),
    ).toEqual([
      {
        lineageParentThreadId: "00000000-0000-4000-8000-000000000100",
        threadId: "00000000-0000-4000-8000-000000000101",
        title: "Restored",
      },
    ]);
  });

  it("omits lineageParentThreadId when the source does not carry it", () => {
    expect(
      buildChatThreadNavigation([
        {
          readSequence: 0,
          threadId: "00000000-0000-4000-8000-000000000101",
          title: "Planning",
        },
      ])[0],
    ).not.toHaveProperty("lineageParentThreadId");
  });

  it("omits unread when lastSequence is absent", () => {
    expect(
      buildChatThreadNavigation([
        {
          readSequence: 0,
          threadId: "00000000-0000-4000-8000-000000000101",
          title: "Planning",
        },
      ]),
    ).toEqual([
      {
        threadId: "00000000-0000-4000-8000-000000000101",
        title: "Planning",
      },
    ]);
  });

  it("never emits duplicate or cross-mode destinations for any supported input", () => {
    const modes: ReadonlyArray<OctantMode> = ["chat", "work", "code"];
    const availability: ReadonlyArray<NavigationAvailability> = [
      "available",
      "disabled",
      "unavailable",
      "unauthorized",
    ];
    const allowedByMode: Record<OctantMode, ReadonlySet<SidebarNavigationDescriptorId>> = {
      chat: new Set(["new-chat", "inbox", "agents", "artifact-library", "plugins", "projects"]),
      work: new Set([
        "new-work-thread",
        "inbox",
        "agents",
        "thread-board",
        "projects",
        "automations",
        "artifact-library",
        "plugins",
      ]),
      code: new Set([
        "new-code-thread",
        "inbox",
        "agents",
        "thread-board",
        "github-issues",
        "pull-requests",
        "linear-issues",
        "projects",
        "automations",
        "artifact-library",
        "plugins",
      ]),
    };

    for (const activeMode of modes) {
      for (const threadBoard of availability) {
        for (const pullRequests of availability) {
          for (const githubIssues of availability) {
            for (const plugins of availability) {
              for (const artifactLibrary of availability) {
                for (const automationsEnabled of [false, true]) {
                  for (const agentsCenterEnabled of [false, true]) {
                    const ids = descriptorIds({
                      activeMode,
                      createThread: "available",
                      inbox: threadBoard,
                      projects: "available",
                      threadBoard,
                      pullRequests,
                      githubIssues,
                      linearIssues: githubIssues,
                      plugins,
                      artifactLibrary,
                      automationsEnabled,
                      agentsCenterEnabled,
                    });
                    expect(new Set(ids).size).toBe(ids.length);
                    for (const id of ids) {
                      expect(allowedByMode[activeMode].has(id)).toBe(true);
                    }
                    expect(ids.includes("artifact-library")).toBe(false);
                    expect(ids.includes("agents")).toBe(false);
                  }
                }
              }
            }
          }
        }
      }
    }
  });
});

function descriptorIds(
  input: SidebarNavigationInput,
): ReadonlyArray<SidebarNavigationDescriptorId> {
  return buildSidebarNavigation(input).map((descriptor) => descriptor.id);
}
