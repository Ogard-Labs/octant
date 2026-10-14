import type { ProjectId } from "@octant/contracts";

/**
 * Whether a window can open a Project, judged by the rule that decides which
 * of the Project's threads it can open, so the two never disagree. A Chat
 * Project is the window's own Chat context; a Work Project is any active one,
 * since every window lists every active Work Project's threads; a Code Project
 * is what the Code Project access rule admits. A paired device is judged under
 * its own scope: it holds no Chat context, and the Code rule gives it the
 * active Code Projects its overview reads cover.
 */
export function windowCanOpenProject(input: {
  readonly project:
    | {
        readonly id: ProjectId;
        readonly type: "chat" | "work" | "code";
        readonly lifecycle: string;
      }
    | undefined;
  readonly chatContext: { readonly mode: string; readonly projectId: string | null } | undefined;
  readonly canAccessCodeProject: (projectId: ProjectId) => boolean;
}): boolean {
  const { project, chatContext } = input;
  if (project === undefined) return false;
  switch (project.type) {
    case "chat":
      return (
        chatContext !== undefined &&
        chatContext.mode === "chat" &&
        String(chatContext.projectId) === String(project.id)
      );
    case "work":
      return project.lifecycle === "active";
    case "code":
      return input.canAccessCodeProject(project.id);
  }
}
