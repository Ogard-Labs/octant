import { Schema } from "effect";
import { ProjectId } from "@octant/contracts/projects";
import {
  SshRemoteWorktreeId,
  type SshRemoteDirectoryListing,
  type SshRemoteDirectoryRequest,
  type SshRemoteFileContent,
  type SshRemoteFileRequest,
  type SshRemoteGitDiff,
  type SshRemoteGitDiffRequest,
  type SshRemoteGitStatus,
  type SshRemoteGitStatusRequest,
  type SshRemoteProject,
  type SshRemoteProjectBindRequest,
  type SshRemoteProjectRefusal,
  type SshRemoteWorktree,
  type SshRemoteWorktreeCreateRequest,
  type SshRemoteWorktreeId as SshRemoteWorktreeIdType,
  type SshRemoteWorktreeRequest,
} from "@octant/contracts/ssh-remote-project";
import type {
  SshExecutorReadReply,
  SshExecutorReadRequest,
} from "@octant/contracts/ssh-executor-protocol";
import { UtcTimestamp } from "@octant/contracts";
import type { SshRemotePath, SshTargetId } from "@octant/contracts/ssh-target";
import type {
  SshTargetAdmissionRequest,
  SshTargetConnectionService,
} from "./sshTargetConnectionService";
import type { SshTargetStore } from "./sshTargetStore";

/**
 * Code Projects bound to a folder on an SSH target, their managed worktrees,
 * and the Files, Git status, and diff reads of either. Canonical:
 * docs/design/remote-ssh-environments.md § Remote-bound Projects and reads
 * and § Terminals and managed worktrees.
 *
 * Binding and every read ask the admission policy first, on the connection
 * that will carry the request, and refuse before any frame reaches the target
 * when it does not admit. Reads outside a turn run in Plan, the read-only
 * posture, so they need that posture's passing attestation on the current
 * connection; binding resolves the folder through the executor and needs the
 * same. A Project on a target that was never attested, whose session was
 * lost, or that was removed reads nothing.
 *
 * A managed worktree is created and removed by Git on the target, one of
 * Octant's own launches that writes, so it is admitted in the approval-gated
 * posture: the person asking from a local window is the approval, as for a
 * Project terminal. The journal records the folder the executor reported,
 * and a worktree's reads name that folder as their root.
 */

const decodeProjectId = Schema.decodeUnknownSync(ProjectId);
const decodeWorktreeId = Schema.decodeUnknownSync(SshRemoteWorktreeId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const FILE_READ: SshTargetAdmissionRequest = {
  posture: "plan",
  permissionPersistence: "current-session",
  subject: { kind: "file-operation" },
};
const GIT_READ: SshTargetAdmissionRequest = {
  posture: "plan",
  permissionPersistence: "current-session",
  subject: { kind: "octant-launch" },
};
const WORKTREE_CHANGE: SshTargetAdmissionRequest = {
  posture: "approval-gated",
  permissionPersistence: "current-session",
  subject: { kind: "octant-launch" },
};

export type SshRemoteProjectResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | SshRemoteProjectRefusal;

/** The folder a request acts in: the Project's remote root, or one of its worktrees. */
export interface SshRemoteFolder {
  readonly project: SshRemoteProject;
  readonly root: SshRemotePath;
  readonly worktree?: SshRemoteWorktree;
}

export interface SshRemoteProjectServiceOptions {
  readonly store: SshTargetStore;
  readonly connections: Pick<SshTargetConnectionService, "read" | "worktree">;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export class SshRemoteProjectService {
  readonly #store: SshTargetStore;
  readonly #connections: Pick<SshTargetConnectionService, "read" | "worktree">;
  readonly #uuid: () => string;
  readonly #clock: () => string;

  constructor(options: SshRemoteProjectServiceOptions) {
    this.#store = options.store;
    this.#connections = options.connections;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
  }

  list(): ReadonlyArray<SshRemoteProject> {
    return this.#store.listProjects();
  }

  listWorktrees(): ReadonlyArray<SshRemoteWorktree> {
    return this.#store.listWorktrees();
  }

  /**
   * The folder a request on `projectId` acts in. A worktree must be one of
   * that Project's own, so no request reaches another Project's folder by
   * naming its worktree.
   */
  folder(
    projectId: ProjectId,
    worktreeId: SshRemoteWorktreeIdType | undefined,
  ): SshRemoteProjectResult<SshRemoteFolder> {
    const project = this.#store.getProject(String(projectId));
    if (project === undefined) return refusedFor("unknown-project");
    if (worktreeId === undefined) {
      return { status: "ok", value: { project, root: project.remoteRoot } };
    }
    const worktree = this.#store.getWorktree(worktreeId);
    if (worktree === undefined || String(worktree.projectId) !== String(project.id)) {
      return refusedFor("unknown-worktree");
    }
    return { status: "ok", value: { project, root: worktree.path, worktree } };
  }

  /**
   * Binds a new Code Project to the folder the executor resolves `remoteRoot`
   * to. The canonical path is what the journal records, so a later read can
   * tell a moved or replaced folder from the one the person bound.
   */
  async bind(
    request: SshRemoteProjectBindRequest,
  ): Promise<SshRemoteProjectResult<SshRemoteProject>> {
    const resolved = await this.#read(request.targetId, FILE_READ, {
      kind: "resolve-root",
      root: request.remoteRoot,
    });
    if (resolved.status !== "replied") return resolved;
    if (resolved.reply.kind !== "root-resolved") return unexpected(resolved.reply);
    const project: SshRemoteProject = {
      id: decodeProjectId(this.#uuid()),
      name: request.name,
      targetId: request.targetId,
      remoteRoot: resolved.reply.root,
      boundAt: decodeTimestamp(this.#clock()),
    };
    if (this.#store.bindProject(project) !== "recorded") {
      throw new Error("The SSH target journal refused a decoded binding.");
    }
    return { status: "ok", value: project };
  }

  async listDirectory(
    request: SshRemoteDirectoryRequest,
  ): Promise<SshRemoteProjectResult<SshRemoteDirectoryListing>> {
    const folder = this.folder(request.projectId, request.worktreeId);
    if (folder.status !== "ok") return folder;
    const read = await this.#read(folder.value.project.targetId, FILE_READ, {
      kind: "list-directory",
      root: folder.value.root,
      ...(request.directory === undefined ? {} : { directory: request.directory }),
    });
    if (read.status !== "replied") return read;
    return read.reply.kind === "directory-listed"
      ? { status: "ok", value: read.reply.listing }
      : unexpected(read.reply);
  }

  async readFile(
    request: SshRemoteFileRequest,
  ): Promise<SshRemoteProjectResult<SshRemoteFileContent>> {
    const folder = this.folder(request.projectId, request.worktreeId);
    if (folder.status !== "ok") return folder;
    const read = await this.#read(folder.value.project.targetId, FILE_READ, {
      kind: "read-file",
      root: folder.value.root,
      path: request.path,
    });
    if (read.status !== "replied") return read;
    // The executor answers for the path it was asked about, or not at all.
    return read.reply.kind === "file-read" && read.reply.file.path === request.path
      ? { status: "ok", value: read.reply.file }
      : unexpected(read.reply);
  }

  async gitStatus(
    request: SshRemoteGitStatusRequest,
  ): Promise<SshRemoteProjectResult<SshRemoteGitStatus>> {
    const folder = this.folder(request.projectId, request.worktreeId);
    if (folder.status !== "ok") return folder;
    const read = await this.#read(folder.value.project.targetId, GIT_READ, {
      kind: "git-status",
      root: folder.value.root,
    });
    if (read.status !== "replied") return read;
    return read.reply.kind === "git-status"
      ? { status: "ok", value: read.reply.status }
      : unexpected(read.reply);
  }

  async gitDiff(
    request: SshRemoteGitDiffRequest,
  ): Promise<SshRemoteProjectResult<SshRemoteGitDiff>> {
    const folder = this.folder(request.projectId, request.worktreeId);
    if (folder.status !== "ok") return folder;
    const read = await this.#read(folder.value.project.targetId, GIT_READ, {
      kind: "git-diff",
      root: folder.value.root,
      ...(request.path === undefined ? {} : { path: request.path }),
    });
    if (read.status !== "replied") return read;
    return read.reply.kind === "git-diff"
      ? { status: "ok", value: read.reply.diff }
      : unexpected(read.reply);
  }

  /** Creates a managed worktree of the Project's remote root and journals the folder Git made. */
  async createWorktree(
    request: SshRemoteWorktreeCreateRequest,
  ): Promise<SshRemoteProjectResult<SshRemoteWorktree>> {
    const project = this.#store.getProject(String(request.projectId));
    if (project === undefined) return refusedFor("unknown-project");
    if (this.#store.listWorktrees(project.id).some((worktree) => worktree.name === request.name)) {
      return refusedFor("worktree-exists");
    }
    const outcome = await this.#connections.worktree(project.targetId, WORKTREE_CHANGE, {
      kind: "create-worktree",
      root: project.remoteRoot,
      project: String(project.id),
      name: request.name,
    });
    if (outcome.status === "refused") {
      return { status: "refused", reason: "not-admitted", decision: outcome.decision };
    }
    if (outcome.status === "unavailable") return refusedFor("executor-unavailable");
    const { reply } = outcome;
    if (reply.kind === "refused") return { status: "refused", reason: reply.reason };
    if (reply.kind !== "worktree-created") return refusedFor("executor-unavailable");
    const worktree: SshRemoteWorktree = {
      id: decodeWorktreeId(this.#uuid()),
      projectId: project.id,
      name: request.name,
      branch: reply.branch,
      path: reply.path,
      createdAt: decodeTimestamp(this.#clock()),
    };
    if (this.#store.recordWorktreeCreated(worktree, outcome.connectionId) !== "recorded") {
      throw new Error("The SSH target journal refused a decoded worktree.");
    }
    return { status: "ok", value: worktree };
  }

  /** Removes a managed worktree Git finds no change in, and journals that it is gone. */
  async removeWorktree(request: SshRemoteWorktreeRequest): Promise<SshRemoteProjectResult<null>> {
    const worktree = this.#store.getWorktree(request.worktreeId);
    if (worktree === undefined) return refusedFor("unknown-worktree");
    const project = this.#store.getProject(String(worktree.projectId));
    if (project === undefined) return refusedFor("unknown-project");
    const outcome = await this.#connections.worktree(project.targetId, WORKTREE_CHANGE, {
      kind: "remove-worktree",
      root: project.remoteRoot,
      project: String(project.id),
      name: worktree.name,
    });
    if (outcome.status === "refused") {
      return { status: "refused", reason: "not-admitted", decision: outcome.decision };
    }
    if (outcome.status === "unavailable") return refusedFor("executor-unavailable");
    const { reply } = outcome;
    if (reply.kind === "refused") return { status: "refused", reason: reply.reason };
    if (reply.kind !== "worktree-removed") return refusedFor("executor-unavailable");
    if (this.#store.recordWorktreeRemoved(worktree.id, outcome.connectionId) !== "recorded") {
      throw new Error("The SSH target journal refused a decoded worktree removal.");
    }
    return { status: "ok", value: null };
  }

  async #read(
    targetId: SshTargetId,
    admission: SshTargetAdmissionRequest,
    request: SshExecutorReadRequest,
  ): Promise<
    { readonly status: "replied"; readonly reply: SshExecutorReadReply } | SshRemoteProjectRefusal
  > {
    const outcome = await this.#connections.read(targetId, admission, request);
    if (outcome.status === "refused") {
      return { status: "refused", reason: "not-admitted", decision: outcome.decision };
    }
    if (outcome.status === "unavailable") {
      return { status: "refused", reason: "executor-unavailable" };
    }
    return outcome;
  }
}

function refusedFor(
  reason: "unknown-project" | "unknown-worktree" | "worktree-exists" | "executor-unavailable",
): SshRemoteProjectRefusal {
  return { status: "refused", reason };
}

/**
 * A refusal the executor reasoned about, or the executor answering a request
 * other than the one asked, which this host treats as an unusable session.
 */
function unexpected(reply: SshExecutorReadReply): SshRemoteProjectRefusal {
  return reply.kind === "refused"
    ? { status: "refused", reason: reply.reason }
    : { status: "refused", reason: "executor-unavailable" };
}
