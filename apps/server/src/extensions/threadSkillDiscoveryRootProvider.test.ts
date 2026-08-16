import {
  decodeBindingRevisionId,
  decodeCodeThreadId,
  decodeWorkThreadId,
  decodeProjectId,
  decodeThreadWorkingDirectory,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createThreadSkillDiscoveryRootProvider } from "./threadSkillDiscoveryRootProvider";

describe("thread skill-discovery root provider", () => {
  it("returns one shared Project root plus exact active nested thread scopes", async () => {
    const projectId = decodeProjectId("11111111-1111-4111-8111-111111111111");
    const revisionId = decodeBindingRevisionId("22222222-2222-4222-8222-222222222222");
    const codeThreadId = decodeCodeThreadId("33333333-3333-4333-8333-333333333333");
    const workThreadId = decodeWorkThreadId("44444444-4444-4444-8444-444444444444");
    const resolveWorkingDirectory = vi.fn(async (root: string, relativeDirectory: string) =>
      relativeDirectory === "." ? root : `${root}/${relativeDirectory}`,
    );
    const provider = createThreadSkillDiscoveryRootProvider({
      readProjects: () => [
        {
          id: projectId,
          mode: "code",
          root: "/repo",
          bindingRevisionId: revisionId,
        },
      ],
      readThreads: () => [
        {
          id: codeThreadId,
          projectId,
          mode: "code",
          lifecycle: "active",
          bindingRevisionId: revisionId,
          workingDirectory: decodeThreadWorkingDirectory("packages/app"),
        },
        {
          id: workThreadId,
          projectId,
          mode: "work",
          lifecycle: "active",
          bindingRevisionId: decodeBindingRevisionId("55555555-5555-4555-8555-555555555555"),
          workingDirectory: decodeThreadWorkingDirectory("stale"),
        },
      ],
      resolveWorkingDirectory,
      userGlobalSkillsRoot: "/home/user/.agents/skills",
    });

    await expect(provider.resolve()).resolves.toEqual([
      {
        workingDirectory: "/repo/packages/app",
        projectRoot: "/repo",
        projectRef: String(projectId),
        userGlobalSkillsRoot: "/home/user/.agents/skills",
        scope: { mode: "code", projectId, threadRef: String(codeThreadId) },
      },
      {
        workingDirectory: "/repo",
        projectRoot: "/repo",
        projectRef: String(projectId),
        userGlobalSkillsRoot: "/home/user/.agents/skills",
      },
    ]);
    expect(resolveWorkingDirectory).toHaveBeenCalledOnce();
  });
});
