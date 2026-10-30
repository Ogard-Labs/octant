// What this host does to read and change a Code Project's or thread's posture
// for an owner device. The owner routes decide whether the request may reach
// here (owner list, Owners item, unlock class); the host decides whether the
// change is allowed, by the same rules a local window meets: Full access on a
// thread needs the Project to remember it, a thread on an SSH target keeps the
// posture it was created under, and Plan stays read-only.

import type {
  CodeThread,
  OwnerPosture,
  OwnerPostureChangeRequest,
  OwnerPostureSubject,
  Project,
} from "@octant/contracts";

export type OwnerPostureRefusalKind =
  | "not-found"
  | "unsupported"
  | "project-default-not-enabled"
  | "stale"
  | "refused";

export type OwnerPostureRead =
  | { readonly status: "read"; readonly posture: OwnerPosture }
  | { readonly status: "refused"; readonly kind: OwnerPostureRefusalKind };

export type OwnerPostureChange =
  | { readonly status: "changed"; readonly posture: OwnerPosture }
  | { readonly status: "refused"; readonly kind: OwnerPostureRefusalKind };

export interface OwnerPostureHost {
  readonly read: (subject: OwnerPostureSubject) => Promise<OwnerPostureRead>;
  readonly change: (request: OwnerPostureChangeRequest) => Promise<OwnerPostureChange>;
}

/**
 * The host as it runs today: it reads postures from its own records and
 * refuses every change as `unsupported`. Changing a Code posture goes through
 * the Code service, whose Full access check is bound to a local window's
 * native confirmation, and a window-free path for an owner device is not built.
 * Reading is still useful, because an owner device sees what a change would
 * start from.
 */
export function createReadingPostureHost(options: {
  readonly readCodeThread: (
    threadId: CodeThread["id"],
  ) => Pick<CodeThread, "executionPolicy" | "permissionPersistence"> | undefined;
  readonly readProject: (projectId: Project["id"]) => Project | undefined;
}): OwnerPostureHost {
  return {
    read: async (subject) => {
      if (subject.kind === "code-thread") {
        const thread = options.readCodeThread(subject.threadId);
        return thread === undefined
          ? { status: "refused", kind: "not-found" }
          : {
              status: "read",
              posture: {
                subject,
                posture: thread.executionPolicy,
                persistence: thread.permissionPersistence,
              },
            };
      }
      const project = options.readProject(subject.projectId);
      if (project?.type !== "code") return { status: "refused", kind: "not-found" };
      // A Code Project's posture is whether it remembers Full access for its threads.
      return {
        status: "read",
        posture: {
          subject,
          posture:
            project.codeAccessPersistence === "project-default" ? "full-access" : "approval-gated",
          persistence: project.codeAccessPersistence,
        },
      };
    },
    change: async () => ({ status: "refused", kind: "unsupported" }),
  };
}
