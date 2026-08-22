import type { OctantMode } from "@octant/contracts/modes";
import { describe, expect, it } from "vitest";
import {
  buildAppMenuNavigation,
  buildChatThreadNavigation,
  buildSidebarNavigation,
  type NavigationAvailability,
  type SidebarNavigationDescriptorId,
  type SidebarNavigationInput,
} from "./navigationModel";

const unavailableCapabilities = {
  createThread: "unavailable",
  projects: "unavailable",
  threadBoard: "unavailable",
  pullRequests: "unavailable",
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

describe("buildSidebarNavigation", () => {
  it.each([
    ["chat", ["new-chat", "projects"]],
    ["work", ["new-work-thread", "projects"]],
    ["code", ["new-code-thread", "projects"]],
  ] as const)("returns the approved stable ordering for %s", (activeMode, expectedIds) => {
    expect(descriptorIds({ activeMode, ...availableBaseCapabilities })).toEqual(expectedIds);
  });

  it("keeps Agents, Automations, Artifacts, and Plugins off the permanent sidebar", () => {
    const capabilities = {
      ...availableBaseCapabilities,
      threadBoard: "available" as const,
      pullRequests: "available" as const,
      plugins: "available" as const,
      automationsEnabled: true,
      agentsCenterEnabled: true,
      artifactLibrary: "available" as const,
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
      "pull-requests",
      "projects",
    ]);
  });

  it("places secondary destinations in the app menu with truthful availability", () => {
    const capabilities = {
      ...availableBaseCapabilities,
      threadBoard: "available" as const,
      pullRequests: "available" as const,
      plugins: "available" as const,
      automationsEnabled: true,
      agentsCenterEnabled: true,
      artifactLibrary: "available" as const,
    } as const;

    expect(appMenuIds({ activeMode: "chat", ...capabilities })).toEqual([
      "agents",
      "artifact-library",
      "plugins",
    ]);
    expect(appMenuIds({ activeMode: "work", ...capabilities })).toEqual([
      "agents",
      "automations",
      "artifact-library",
      "plugins",
    ]);
    expect(appMenuIds({ activeMode: "code", ...capabilities })).toEqual([
      "agents",
      "automations",
      "artifact-library",
      "plugins",
    ]);
  });

  it("adds only the destinations supported by each mode", () => {
    const capabilities = {
      ...availableBaseCapabilities,
      threadBoard: "available" as const,
      pullRequests: "available" as const,
      plugins: "available" as const,
      automationsEnabled: true,
      artifactLibrary: "unavailable" as const,
    } as const;

    // Plugins reach every mode via the app menu; Automations and the work-mode
    // boards do not belong in Chat.
    expect(descriptorIds({ activeMode: "chat", ...capabilities })).toEqual([
      "new-chat",
      "projects",
    ]);
    expect(appMenuIds({ activeMode: "chat", ...capabilities })).toEqual(["plugins"]);
    expect(descriptorIds({ activeMode: "work", ...capabilities })).toEqual([
      "new-work-thread",
      "thread-board",
      "projects",
    ]);
    expect(appMenuIds({ activeMode: "work", ...capabilities })).toEqual(["automations", "plugins"]);
    expect(descriptorIds({ activeMode: "code", ...capabilities })).toEqual([
      "new-code-thread",
      "thread-board",
      "pull-requests",
      "projects",
    ]);
    expect(appMenuIds({ activeMode: "code", ...capabilities })).toEqual(["automations", "plugins"]);
  });

  it.each(["disabled", "unavailable", "unauthorized"] as const)(
    "omits %s capabilities rather than presenting false authority",
    (availability) => {
      expect(
        descriptorIds({
          activeMode: "code",
          createThread: availability,
          projects: availability,
          threadBoard: availability,
          pullRequests: availability,
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

  it("never exposes Automations in Chat before a separate Chat automation design", () => {
    const input = {
      activeMode: "chat" as const,
      ...availableBaseCapabilities,
      automationsEnabled: true,
      artifactLibrary: "unavailable" as const,
    };
    expect(descriptorIds(input)).toEqual(["new-chat", "projects"]);
    expect(appMenuIds(input)).not.toContain("automations");
  });

  it.each(["work", "code"] as const)(
    "shows Automations in the %s app menu only when explicitly enabled",
    (activeMode) => {
      expect(
        appMenuIds({ activeMode, ...availableBaseCapabilities, automationsEnabled: true }),
      ).toEqual(["automations"]);
      expect(
        descriptorIds({ activeMode, ...availableBaseCapabilities, automationsEnabled: true }),
      ).not.toContain("automations");
      expect(appMenuIds({ activeMode, ...availableBaseCapabilities })).not.toContain("automations");
    },
  );

  it("returns Octant-owned labels without fabricating project or thread records", () => {
    expect(buildSidebarNavigation({ activeMode: "chat", ...availableBaseCapabilities })).toEqual([
      { id: "new-chat", label: "New chat" },
      { id: "projects", label: "Projects" },
    ]);
    expect(buildSidebarNavigation({ activeMode: "code", ...availableBaseCapabilities })).toEqual([
      { id: "new-code-thread", label: "New thread" },
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
      chat: new Set(["new-chat", "projects"]),
      work: new Set(["new-work-thread", "thread-board", "projects"]),
      code: new Set(["new-code-thread", "thread-board", "pull-requests", "projects"]),
    };
    const allowedAppMenuByMode: Record<OctantMode, ReadonlySet<SidebarNavigationDescriptorId>> = {
      chat: new Set(["agents", "artifact-library", "plugins"]),
      work: new Set(["agents", "automations", "artifact-library", "plugins"]),
      code: new Set(["agents", "automations", "artifact-library", "plugins"]),
    };

    for (const activeMode of modes) {
      for (const threadBoard of availability) {
        for (const pullRequests of availability) {
          for (const plugins of availability) {
            for (const artifactLibrary of availability) {
              for (const automationsEnabled of [false, true]) {
                for (const agentsCenterEnabled of [false, true]) {
                  const input = {
                    activeMode,
                    createThread: "available" as const,
                    projects: "available" as const,
                    threadBoard,
                    pullRequests,
                    plugins,
                    artifactLibrary,
                    automationsEnabled,
                    agentsCenterEnabled,
                  };
                  const ids = descriptorIds(input);
                  const menuIds = appMenuIds(input);
                  expect(new Set(ids).size).toBe(ids.length);
                  expect(new Set(menuIds).size).toBe(menuIds.length);
                  for (const id of ids) {
                    expect(allowedByMode[activeMode].has(id)).toBe(true);
                  }
                  for (const id of menuIds) {
                    expect(allowedAppMenuByMode[activeMode].has(id)).toBe(true);
                  }
                  expect(ids.includes("artifact-library")).toBe(false);
                  expect(menuIds.includes("artifact-library")).toBe(
                    artifactLibrary === "available",
                  );
                  expect(ids.includes("agents")).toBe(false);
                  expect(menuIds.includes("agents")).toBe(agentsCenterEnabled);
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

function appMenuIds(input: SidebarNavigationInput): ReadonlyArray<SidebarNavigationDescriptorId> {
  return buildAppMenuNavigation(input).map((descriptor) => descriptor.id);
}
