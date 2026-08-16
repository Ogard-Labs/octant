import type { AgentRunAuthority } from "@octant/contracts/agent-run";
import type { CanvasCreationContext } from "./CreateCanvasDraft";
import type { CanvasOriginThreadId, CanvasWorkspaceScope } from "@octant/contracts/canvas-cards";
import type { CanvasSourceManifest } from "@octant/contracts/canvas";
import type { HostId } from "@octant/contracts/host";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";

const defaultAuthority: AgentRunAuthority = {
  filesystem: false,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: false,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
};

export function buildCanvasCreationContext(input: {
  readonly hostId: HostId;
  readonly mode: OctantMode;
  readonly originThreadId: CanvasOriginThreadId;
  readonly projectId: ProjectId | null;
  readonly workspace?: CanvasWorkspaceScope;
  readonly requestedAuthority?: AgentRunAuthority;
  readonly sourceManifest?: CanvasSourceManifest;
}): CanvasCreationContext {
  return {
    hostId: input.hostId,
    mode: input.mode,
    workspace:
      input.workspace ??
      (input.mode === "chat"
        ? { kind: "chat-virtual", projectId: input.projectId }
        : input.mode === "work"
          ? {
              kind: "work-root",
              projectId: input.projectId as ProjectId,
              rootId: input.originThreadId as never,
            }
          : {
              kind: "code-worktree",
              projectId: input.projectId as ProjectId,
              repositoryId: `repo_${"0".repeat(64)}` as never,
              bindingRevisionId: input.originThreadId as never,
              checkoutId: input.originThreadId as never,
              verified: true,
            }),
    originThreadId: input.originThreadId,
    requestedAuthority: input.requestedAuthority ?? defaultAuthority,
    sourceManifest: input.sourceManifest ?? [],
  };
}
