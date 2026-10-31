import {
  decodeCodeTerminalId,
  type CodeThread,
  type CodeThreadId,
  type CodeTerminalId,
} from "@octant/contracts/code";
import type { ProjectId, ProjectSummary } from "@octant/contracts/projects";
import type { WindowWorkspace } from "@octant/contracts";
import type { ZenSourceContext } from "@octant/contracts/zen";

export interface ZenTerminalPinTarget {
  readonly checkoutId: CodeThread["checkoutId"];
  readonly terminalId: CodeTerminalId;
  readonly threadId: CodeThreadId;
  readonly title: string;
}

/**
 * Resolve the default terminal a Code thread owns. Zen can pin that existing
 * process, but it must not start or restart one from the focus-zone surface.
 */
export function resolveZenTerminalPinTarget(
  sourceContext: ZenSourceContext,
  threads: ReadonlyArray<CodeThread>,
): ZenTerminalPinTarget | undefined {
  if (sourceContext.threadKind !== "code") return undefined;
  const thread = threads.find(
    (candidate) => String(candidate.id) === String(sourceContext.threadId),
  );
  if (thread === undefined || thread.executionPolicy === "plan") return undefined;
  return {
    checkoutId: thread.checkoutId,
    // Code's original terminal uses the thread identity as its terminal
    // identity. The server still verifies that the process exists and belongs
    // to this thread before it writes the Zen card.
    terminalId: decodeCodeTerminalId(String(thread.id)),
    threadId: thread.id,
    title: thread.title,
  };
}

/**
 * The Project whose terminal Zen's "This Project" opens: the window's Project
 * in the mode it is showing first, then its Project in the other mode. A Work
 * Project counts only once the person turned on its Developer tools, which is
 * what shows a Work Project's terminal.
 */
export function resolveZenProjectTerminalTarget(
  workspace: Pick<WindowWorkspace, "activeMode" | "contextByMode">,
  projects: ReadonlyArray<ProjectSummary>,
): { readonly projectId: ProjectId; readonly name: string } | undefined {
  const modes: ReadonlyArray<"work" | "code"> =
    workspace.activeMode === "work" ? ["work", "code"] : ["code", "work"];
  for (const mode of modes) {
    const projectId = workspace.contextByMode[mode].projectId ?? undefined;
    if (projectId === undefined) continue;
    const project = projects.find(
      (candidate) =>
        String(candidate.id) === String(projectId) &&
        candidate.lifecycle === "active" &&
        (candidate.type === "code" ||
          (candidate.type === "work" && candidate.developerTools?.enabled === true)) &&
        candidate.type === mode,
    );
    if (project !== undefined) return { projectId: project.id, name: project.name };
  }
  return undefined;
}
