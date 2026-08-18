import type { OctantMode } from "@octant/contracts/modes";
import { describe, expect, it } from "vitest";
import {
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

  it("adds only the destinations supported by each mode", () => {
    const capabilities = {
      ...availableBaseCapabilities,
      threadBoard: "available" as const,
      pullRequests: "available" as const,
      plugins: "available" as const,
      automationsEnabled: true,
      artifactLibrary: "unavailable" as const,
    } as const;

    // Plugins reach every mode; Automations and the work-mode boards do not.
    expect(descriptorIds({ activeMode: "chat", ...capabilities })).toEqual([
      "new-chat",
      "plugins",
      "projects",
    ]);
    expect(descriptorIds({ activeMode: "work", ...capabilities })).toEqual([
      "new-work-thread",
      "automations",
      "plugins",
      "thread-board",
      "projects",
    ]);
    expect(descriptorIds({ activeMode: "code", ...capabilities })).toEqual([
      "new-code-thread",
      "automations",
      "plugins",
      "thread-board",
      "pull-requests",
      "projects",
    ]);
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
          artifactLibrary: "unavailable" as const,
        }),
      ).toEqual([]);
    },
  );

  it.each([
    ["chat", "createThread", "new-chat"],
    ["chat", "plugins", "plugins"],
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
    expect(
      descriptorIds({
        activeMode: "chat",
        ...availableBaseCapabilities,
        automationsEnabled: true,
        artifactLibrary: "unavailable" as const,
      }),
    ).toEqual(["new-chat", "projects"]);
  });

  it.each(["work", "code"] as const)(
    "shows Automations in %s only when explicitly enabled",
    (activeMode) => {
      const expectedIds = {
        work: ["new-work-thread", "automations", "projects"],
        code: ["new-code-thread", "automations", "projects"],
      } as const;

      expect(
        descriptorIds({ activeMode, ...availableBaseCapabilities, automationsEnabled: true }),
      ).toEqual(expectedIds[activeMode]);
      expect(descriptorIds({ activeMode, ...availableBaseCapabilities })).not.toContain(
        "automations",
      );
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
      chat: new Set(["new-chat", "artifact-library", "plugins", "projects"]),
      work: new Set([
        "new-work-thread",
        "thread-board",
        "projects",
        "automations",
        "artifact-library",
        "plugins",
      ]),
      code: new Set([
        "new-code-thread",
        "thread-board",
        "pull-requests",
        "projects",
        "automations",
        "artifact-library",
        "plugins",
      ]),
    };

    for (const activeMode of modes) {
      for (const threadBoard of availability) {
        for (const pullRequests of availability) {
          for (const plugins of availability) {
            for (const artifactLibrary of availability) {
              for (const automationsEnabled of [false, true]) {
                const ids = descriptorIds({
                  activeMode,
                  createThread: "available",
                  projects: "available",
                  threadBoard,
                  pullRequests,
                  plugins,
                  artifactLibrary,
                  automationsEnabled,
                });
                expect(new Set(ids).size).toBe(ids.length);
                for (const id of ids) {
                  expect(allowedByMode[activeMode].has(id)).toBe(true);
                }
                expect(ids.includes("artifact-library")).toBe(artifactLibrary === "available");
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
