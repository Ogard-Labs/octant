import { Schema } from "effect";
import { ProjectId } from "@octant/contracts/projects";
import type {
  SshRemoteDirectoryListing,
  SshRemoteDirectoryRequest,
  SshRemoteFileContent,
  SshRemoteFileRequest,
  SshRemoteGitDiff,
  SshRemoteGitDiffRequest,
  SshRemoteGitStatus,
  SshRemoteGitStatusRequest,
  SshRemoteProject,
  SshRemoteProjectBindRequest,
  SshRemoteProjectRefusal,
} from "@octant/contracts/ssh-remote-project";
import type {
  SshExecutorReadReply,
  SshExecutorReadRequest,
} from "@octant/contracts/ssh-executor-protocol";
import { UtcTimestamp } from "@octant/contracts";
import type { SshTargetId } from "@octant/contracts/ssh-target";
import type {
  SshTargetAdmissionRequest,
  SshTargetConnectionService,
} from "./sshTargetConnectionService";
import type { SshTargetStore } from "./sshTargetStore";

/**
 * Code Projects bound to a folder on an SSH target, and the Files, Git status,
 * and diff reads of that folder. Canonical:
 * docs/design/remote-ssh-environments.md § Remote-bound Projects and reads.
 *
 * Binding and every read ask the admission policy first, on the connection
 * that will carry the request, and refuse before any frame reaches the target
 * when it does not admit. Reads outside a turn run in Plan, the read-only
 * posture, so they need that posture's passing attestation on the current
 * connection; binding resolves the folder through the executor and needs the
 * same. A Project on a target that was never attested, whose session was
 * lost, or that was removed reads nothing.
 */

const decodeProjectId = Schema.decodeUnknownSync(ProjectId);
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

export type SshRemoteProjectResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | SshRemoteProjectRefusal;

export interface SshRemoteProjectServiceOptions {
  readonly store: SshTargetStore;
  readonly connections: Pick<SshTargetConnectionService, "read">;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export class SshRemoteProjectService {
  readonly #store: SshTargetStore;
  readonly #connections: Pick<SshTargetConnectionService, "read">;
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
    const project = this.#store.getProject(String(request.projectId));
    if (project === undefined) return unknownProject();
    const read = await this.#read(project.targetId, FILE_READ, {
      kind: "list-directory",
      root: project.remoteRoot,
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
    const project = this.#store.getProject(String(request.projectId));
    if (project === undefined) return unknownProject();
    const read = await this.#read(project.targetId, FILE_READ, {
      kind: "read-file",
      root: project.remoteRoot,
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
    const project = this.#store.getProject(String(request.projectId));
    if (project === undefined) return unknownProject();
    const read = await this.#read(project.targetId, GIT_READ, {
      kind: "git-status",
      root: project.remoteRoot,
    });
    if (read.status !== "replied") return read;
    return read.reply.kind === "git-status"
      ? { status: "ok", value: read.reply.status }
      : unexpected(read.reply);
  }

  async gitDiff(
    request: SshRemoteGitDiffRequest,
  ): Promise<SshRemoteProjectResult<SshRemoteGitDiff>> {
    const project = this.#store.getProject(String(request.projectId));
    if (project === undefined) return unknownProject();
    const read = await this.#read(project.targetId, GIT_READ, {
      kind: "git-diff",
      root: project.remoteRoot,
      ...(request.path === undefined ? {} : { path: request.path }),
    });
    if (read.status !== "replied") return read;
    return read.reply.kind === "git-diff"
      ? { status: "ok", value: read.reply.diff }
      : unexpected(read.reply);
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

function unknownProject(): SshRemoteProjectRefusal {
  return { status: "refused", reason: "unknown-project" };
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
