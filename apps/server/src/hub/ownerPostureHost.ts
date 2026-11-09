import { createHash } from "node:crypto";
import { Schema } from "effect";
import { WorkAccess, ProviderExecutionPolicy } from "@octant/contracts";
import type {
  CodeThread,
  CodeCheckoutIdentity,
  OwnerPosture,
  OwnerPostureChangeRequest,
  OwnerPostureSubject,
  OwnerPostureTarget,
  Project,
  WorkThread,
} from "@octant/contracts";
import type { CodeService } from "../code/codeService";
import type { ProjectService } from "../projectService";
import type { WorkThreadService } from "../work/workThreadService";

export type OwnerPostureRefusalKind =
  | "not-found"
  | "unsupported"
  | "project-default-not-enabled"
  | "posture-stale"
  | "refused";
export type OwnerPostureRead =
  | { readonly status: "read"; readonly posture: OwnerPosture }
  | { readonly status: "refused"; readonly kind: OwnerPostureRefusalKind };
export type OwnerPostureChange =
  | { readonly status: "changed"; readonly posture: OwnerPosture }
  | { readonly status: "refused"; readonly kind: OwnerPostureRefusalKind };
/** Host facts from the authenticated owner route, never decoded from the request body. */
export interface OwnerPostureAuthority {
  readonly ownerMemberId: string;
  readonly freshFull: boolean;
}
export interface OwnerPostureHost {
  readonly list?: () => Promise<ReadonlyArray<OwnerPostureTarget>>;
  readonly read: (subject: OwnerPostureSubject) => Promise<OwnerPostureRead>;
  readonly change: (
    request: OwnerPostureChangeRequest,
    authority: OwnerPostureAuthority,
  ) => Promise<OwnerPostureChange>;
}

export function createOwnerPostureHost(options: {
  readonly readCodeThreads: () => ReadonlyArray<CodeThread>;
  readonly readProjects: () => ReadonlyArray<Project>;
  readonly readCodeThread: (threadId: CodeThread["id"]) => CodeThread | undefined;
  readonly readProject: (projectId: Project["id"]) => Project | undefined;
  readonly readCheckout: (checkoutId: CodeThread["checkoutId"]) => CodeCheckoutIdentity | undefined;
  readonly code: Pick<CodeService, "changeOwnerPosture"> | undefined;
  readonly projects: Pick<ProjectService, "changeOwnerPosture">;
  readonly work?: {
    readonly readThreads: () => ReadonlyArray<WorkThread>;
    readonly readThread: (threadId: WorkThread["id"]) => WorkThread | undefined;
    readonly changeAccess: WorkThreadService["changeOwnerAccess"];
  };
}): OwnerPostureHost {
  const snapshot = (subject: OwnerPostureSubject): OwnerPostureRead => {
    if (subject.kind === "work-thread") {
      if (options.work === undefined) return { status: "refused", kind: "unsupported" };
      const thread = options.work.readThread(subject.threadId);
      const project = thread === undefined ? undefined : options.readProject(thread.projectId);
      if (
        thread?.lifecycle !== "active" ||
        project?.type !== "work" ||
        project.lifecycle !== "active"
      )
        return { status: "refused", kind: "not-found" };
      if (
        thread.bindingRevisionId !== undefined &&
        String(thread.bindingRevisionId) !== String(project.bindingHistory.at(-1)?.revisionId)
      )
        return { status: "refused", kind: "posture-stale" };
      return {
        status: "read",
        posture: {
          subject,
          posture: thread.access,
          version: createHash("sha256")
            .update(JSON.stringify({ subject, thread, project }))
            .digest("hex"),
        },
      };
    }
    const thread =
      subject.kind === "code-thread" ? options.readCodeThread(subject.threadId) : undefined;
    if (subject.kind === "code-thread" && thread === undefined)
      return { status: "refused", kind: "not-found" };
    const projectId =
      thread?.projectId ?? (subject.kind === "project" ? subject.projectId : undefined);
    if (projectId === undefined) return { status: "refused", kind: "not-found" };
    const project = options.readProject(projectId);
    if (
      project?.type !== "code" ||
      project.lifecycle !== "active" ||
      (thread !== undefined && thread.lifecycle !== "active")
    )
      return { status: "refused", kind: "not-found" };
    const checkout = thread === undefined ? undefined : options.readCheckout(thread.checkoutId);
    if (
      thread !== undefined &&
      (checkout === undefined ||
        checkout.availability !== "available" ||
        String(checkout.repositoryId) !== String(thread.repositoryId) ||
        String(project.bindingHistory.at(-1)?.revisionId) !== String(thread.bindingRevisionId))
    )
      return { status: "refused", kind: "posture-stale" };
    // The signed request binds both aggregate heads and the exact checkout and
    // Project binding. A changed target cannot reuse an earlier reading.
    const version = createHash("sha256")
      .update(JSON.stringify({ subject, thread, project, checkout }))
      .digest("hex");
    return {
      status: "read",
      posture: {
        subject,
        version,
        ...(thread?.autoApprove === true ? { autoApprove: true } : {}),
        posture:
          thread?.executionPolicy ??
          (project.codeAccessPersistence === "project-default" ? "full-access" : "approval-gated"),
        persistence: thread?.permissionPersistence ?? project.codeAccessPersistence,
      },
    };
  };
  return {
    list: async () => {
      const targets: Array<OwnerPostureTarget> = [];
      for (const project of options.readProjects()) {
        if (project.type !== "code") continue;
        const result = snapshot({ kind: "project", projectId: project.id });
        if (result.status === "read")
          targets.push({ title: project.name, posture: result.posture });
      }
      for (const thread of options.readCodeThreads()) {
        const result = snapshot({ kind: "code-thread", threadId: thread.id });
        if (result.status === "read")
          targets.push({ title: thread.title, posture: result.posture });
      }
      for (const thread of options.work?.readThreads() ?? []) {
        const result = snapshot({ kind: "work-thread", threadId: thread.id });
        if (result.status === "read")
          targets.push({ title: thread.title, posture: result.posture });
      }
      return targets;
    },
    read: async (subject) => snapshot(subject),
    change: async (request, authority) => {
      const before = snapshot(request.subject);
      if (before.status === "refused") return before;
      if (before.posture.version !== request.expectedVersion)
        return { status: "refused", kind: "posture-stale" };
      if (request.posture === "full-access" && !authority.freshFull)
        return { status: "refused", kind: "refused" };
      try {
        // No await between the authoritative snapshot and the synchronous
        // service transaction: another command cannot change the target here.
        if (request.subject.kind === "work-thread") {
          if (options.work === undefined) return { status: "refused", kind: "unsupported" };
          const current = options.work.readThread(request.subject.threadId);
          if (current === undefined) return { status: "refused", kind: "not-found" };
          options.work.changeAccess({
            threadId: current.id,
            expectedVersion: current.version,
            access: Schema.decodeUnknownSync(WorkAccess)(request.posture),
            ...authority,
          });
        } else if (!("persistence" in request)) {
          return { status: "refused", kind: "unsupported" };
        } else if (request.subject.kind === "code-thread") {
          if (options.code === undefined) return { status: "refused", kind: "unsupported" };
          const current = options.readCodeThread(request.subject.threadId);
          if (current === undefined) return { status: "refused", kind: "not-found" };
          options.code.changeOwnerPosture({
            threadId: current.id,
            expectedVersion: current.version,
            executionPolicy: Schema.decodeUnknownSync(ProviderExecutionPolicy)(request.posture),
            permissionPersistence: request.persistence,
            ...authority,
          });
        } else {
          if (request.posture !== "full-access" && request.posture !== "approval-gated")
            return { status: "refused", kind: "unsupported" };
          const current = options.readProject(request.subject.projectId);
          if (current === undefined) return { status: "refused", kind: "not-found" };
          options.projects.changeOwnerPosture({
            projectId: current.id,
            expectedVersion: current.version,
            persistence: request.posture === "full-access" ? "project-default" : "current-session",
            ...authority,
          });
        }
        const after = snapshot(request.subject);
        return after.status === "read" ? { status: "changed", posture: after.posture } : after;
      } catch {
        return { status: "refused", kind: "refused" };
      }
    },
  };
}
