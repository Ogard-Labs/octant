import type { OctantMode } from "@octant/contracts/modes";
import { describe, expect, it } from "vitest";
import {
  buildChatThreadNavigation,
  buildSidebarAppMenu,
  buildSidebarNavigation,
  type NavigationAvailability,
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
