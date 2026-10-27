import { GitHistoryPort } from "../code/gitHistoryPort";
import {
  MINIMUM_GIT_VERSION,
  type RepositoryIdentityObservation,
} from "../code/repositoryIdentity";
import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CodeCheckoutId,
  type CodeCheckoutIdentity,
  type CodeProjectPullRequestRow,
  type CodeRepositoryId,
  type CodeWorktreeRemoteFacts,
  decodeCodeCheckoutId,
  decodeCodeCheckoutIdentity,
  decodeCodeFileId,
  decodeCodeRelativePath,
  decodeCodeRepositoryId,
  decodeCodeThreadId,
  decodeWindowId,
  type ProjectId,
  type ProviderInstance,
  type ProviderModel,
  type WindowId,
} from "@octant/contracts";
import { Effect } from "effect";
import { WorkAttachmentStore } from "../work/workAttachmentStore";
import { resolveThreadWorkingDirectory } from "../threadWorkingDirectoryAuthority";
import { CodeContentStore } from "../code/codeContentStore";
import { CodeAttachmentStore } from "../code/codeAttachmentStore";
import { CodeFileService } from "../code/codeFileService";
import { CodeFileListingService } from "../code/codeFileListingService";
import { CodeFileWatchService } from "../code/codeFileWatchService";
import { CodeSearchService } from "../code/codeSearchService";
import { RepositoryTestDiscoveryService } from "../code/repositoryTestDiscoveryService";
import {
  type CodeCheckoutObservationPort,
  type CodeFileRootAuthorityPort,
  CodeService,
} from "../code/codeService";
import type { CompletedThreadArchiveInput } from "../completedThreadArchiveSweep";
import { pullRequestIdentitiesFromHistory } from "../code/codeThreadMetadataService";
import {
  type CodeProjectPullRequestDetailPort,
  type CodeProjectPullRequestListPort,
  type CodeProjectPullRequestMergePort,
  CodeProjectPullRequestService,
  journalPullRequestMerge,
} from "../code/codeProjectPullRequestService";
import { CodeProjectPullRequestCadence } from "../code/codeProjectPullRequestCadence";
import { CodeProjectPullRequestSnapshotStore } from "../code/codeProjectPullRequestSnapshotStore";
import { createGhCommandPort, GhPullRequestPort } from "../code/ghPullRequestPort";
import { createFileHelperProcessTransport } from "../code/fileHelperProcessTransport";
import { FileOperationPort } from "../code/fileOperationPort";
import { createManagedWorktreeNodePorts } from "../code/managedWorktreeNodePorts";
import type { ManagedWorktreeRepositoryPort } from "../code/managedWorktreeService";
import { ManagedWorktreeReceiptStore } from "../code/managedWorktreeReceiptStore";
import { CodeEnvironmentService } from "../codeEnvironmentService";
import { GitObservationPort } from "../code/gitObservationPort";
import type { PersistenceService } from "../persistence/persistenceService";
import { createProjectRouteHandler } from "../projectRoutes";
import { createAgentProfileRouteHandler } from "../agentProfileRoutes";
import { AgentProfileService } from "../agentProfileService";
import { createFolderBrowseRouteHandler } from "../folderBrowseRoutes";
import { FolderBrowseService } from "../folderBrowseService";
import { ProjectService } from "../projectService";
import { CodeProjectAccess } from "../codeProjectAccess";
import type { CodeOperationRuntime } from "../code/codeOperationRuntime";
import { MAX_JSON_REQUEST_BODY_SIZE, type ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { AgentRunsWiring } from "./agentRuns";
import type { IntegrationsWiring } from "./integrations";
import type { WorkspaceWiring } from "./workspace";
import type { ProvidersWiring } from "./providers";
import type { FoundationsWiring } from "./foundations";

export function createExistingWorktreeCodeFileRootAuthority(options: {
  readonly projects: Pick<ProjectService, "bootstrap">;
  readonly readProject: PersistenceService["readProject"];
  readonly repository: ManagedWorktreeRepositoryPort;
  readonly managedReceipts?: Pick<ManagedWorktreeReceiptStore, "load">;
  readonly statIdentity: (
    path: string,
  ) => Promise<{ readonly device: string; readonly inode: string }>;
}): CodeFileRootAuthorityPort {
  return {
    resolve: async (windowId, thread, checkout, relativePath) => {
      const bootstrap = await options.projects.bootstrap(windowId);
      const summary = bootstrap.active.find(
        (project) => project.id === thread.projectId && project.type === "code",
      );
      const project = options.readProject(thread.projectId);
      const revision = project?.type === "code" ? project.bindingHistory.at(-1) : undefined;
      if (
        summary?.type !== "code" ||
        project?.type !== "code" ||
        project.lifecycle !== "active" ||
        revision?.revisionId !== thread.bindingRevisionId ||
        summary.binding.canonicalRoot !== project.binding.canonicalRoot ||
        revision.currentBinding.canonicalRoot !== project.binding.canonicalRoot
      ) {
        return undefined;
      }
      const repositoryRoot = project.binding.canonicalRoot;
      let rootPath: string;
      if (checkout.kind === "plain-folder") {
        // No repository to observe: the folder is the checkout. Its identity
        // must still be the one this root derives, so a checkout journaled
        // for another folder cannot reach this one.
        const plain = plainFolderCheckoutIdentity({
          projectId: thread.projectId,
          bindingRevisionId: thread.bindingRevisionId,
          canonicalRoot: repositoryRoot,
        });
        if (
          checkout.id !== plain.checkoutId ||
          checkout.repositoryId !== plain.repositoryId ||
          thread.repositoryId !== plain.repositoryId
        ) {
          return undefined;
        }
        const rootIdentity = await options.statIdentity(repositoryRoot);
        return {
          fileId: stableCodeFileId(thread.id, checkout.id, relativePath),
          rootPath: repositoryRoot,
          rootIdentity,
        };
      }
      if (checkout.kind === "existing-worktree") {
        const expectedCheckoutId = deriveExistingWorktreeCheckoutId({
          projectId: thread.projectId,
          bindingRevisionId: thread.bindingRevisionId,
          repositoryId: thread.repositoryId,
          canonicalRoot: repositoryRoot,
        });
        if (checkout.id !== expectedCheckoutId) return undefined;
        rootPath = repositoryRoot;
      } else {
        if (options.managedReceipts === undefined) return undefined;
        const receipt = await options.managedReceipts.load(checkout.ownershipReceiptId);
        if (
          receipt === undefined ||
          receipt.state !== "ready" ||
          receipt.receiptId !== checkout.ownershipReceiptId ||
          receipt.threadId !== thread.id ||
          receipt.checkoutId !== checkout.id ||
          receipt.repositoryId !== thread.repositoryId ||
          receipt.repositoryId !== checkout.repositoryId ||
          receipt.canonicalRepositoryPath !== repositoryRoot
        ) {
          return undefined;
        }
        rootPath = receipt.canonicalWorktreePath;
      }
      const observation = await options.repository.observe(
        repositoryRoot,
        new AbortController().signal,
      );
      const observedCheckout =
        checkout.kind === "existing-worktree"
          ? observation.status === "available"
            ? observation.checkout
            : undefined
          : observation.status === "available"
            ? observation.worktrees.find(
                (candidate) =>
                  candidate.status === "present" && candidate.canonicalPath === rootPath,
              )
            : undefined;
      if (
        observation.status !== "available" ||
        observation.repositoryId !== thread.repositoryId ||
        observation.repositoryId !== checkout.repositoryId ||
        observation.repositoryRoot !== repositoryRoot ||
        observedCheckout === undefined ||
        observedCheckout.locked !== undefined ||
        observedCheckout.prunable !== undefined ||
        !observedCheckoutHeadMatches(observedCheckout, checkout.head)
      ) {
        return undefined;
      }
      const rootIdentity = await options.statIdentity(rootPath);
      return {
        fileId: stableCodeFileId(thread.id, checkout.id, relativePath),
        rootPath,
        rootIdentity,
      };
    },
  };
}

/**
 * What to tell the user about a checkout that could not be observed.
 *
 * `not-repository` is the only reason `git init` answers; naming the others
 * plainly stops the composer from prescribing it for a bare repository, a
 * submodule, or a folder that has simply moved.
 */
function unavailableCheckoutMessage(
  observation: Exclude<RepositoryIdentityObservation, { status: "available" }>,
): string {
  if (observation.status === "failed") {
    if (observation.git !== undefined) {
      if (observation.git.version !== undefined) {
        return `Git ${observation.git.version} found; Octant needs Git ${MINIMUM_GIT_VERSION} or newer on the host.`;
      }
      const detail = observation.git.stderr === "" ? "" : ` (${observation.git.stderr})`;
      return `Git could not inspect the bound Code folder: \`git ${observation.git.command}\` failed${detail}. Octant needs Git ${MINIMUM_GIT_VERSION} or newer on the host.`;
    }
    return "The bound Code folder could not be inspected. Check that Octant still has access to it.";
  }
  if (observation.status === "unavailable") {
    return observation.reason === "not-repository"
      ? "This folder is not a Git repository. Run git init in it, choose another Project, or turn off the Git requirement in Code settings."
      : "The bound Code folder is missing or has moved. Rebind the Project to its current location.";
  }
  switch (observation.reason) {
    case "bare":
      return "This folder is a bare Git repository, which has no working tree to edit.";
    case "submodule":
      return "This folder is a Git submodule. Bind the superproject instead.";
    default:
      return "This folder is inside a Git repository but is not one of its checkouts.";
  }
}

export function createExistingWorktreeCodeCheckoutObservation(options: {
  readonly projects: Pick<ProjectService, "bootstrap">;
  readonly readProject: PersistenceService["readProject"];
  readonly repository: ManagedWorktreeRepositoryPort;
  readonly clock: () => string;
  readonly gitObservationPort?: GitObservationPort;
  /**
   * Whether a thread may start in a folder that is not a Git repository.
   * Read per observation so the Code setting applies without a restart.
   * Absent means required, which is what Code always demanded.
   */
  readonly requireGitRepository?: () => boolean;
}): CodeCheckoutObservationPort {
  return {
    observe: async (windowId, projectId) => {
      const bootstrap = await options.projects.bootstrap(windowId);
      const summary = bootstrap.active.find(
        (project) => project.id === projectId && project.type === "code",
      );
      const project = options.readProject(projectId);
      const revision = project?.type === "code" ? project.bindingHistory.at(-1) : undefined;
      if (
        summary?.type !== "code" ||
        project?.type !== "code" ||
        project.lifecycle !== "active" ||
        revision === undefined ||
        summary.binding.canonicalRoot !== project.binding.canonicalRoot ||
        revision.currentBinding.canonicalRoot !== project.binding.canonicalRoot
      ) {
        throw new Error("Code Project binding is unavailable.");
      }

      const root = project.binding.canonicalRoot;
      const observation = await options.repository.observe(root, new AbortController().signal);
      if (
        observation.status === "unavailable" &&
        observation.reason === "not-repository" &&
        options.requireGitRepository?.() === false
      ) {
        // The folder is the checkout. Everything Git-backed reads the `none`
        // head and reports itself unavailable instead of pretending.
        const plain = plainFolderCheckoutIdentity({
          projectId,
          bindingRevisionId: revision.revisionId,
          canonicalRoot: root,
        });
        return {
          bindingRevisionId: revision.revisionId,
          checkout: decodeCodeCheckoutIdentity({
            id: plain.checkoutId,
            repositoryId: plain.repositoryId,
            kind: "plain-folder",
            availability: "available",
            head: { kind: "none" },
            observedAt: options.clock(),
          }),
        };
      }
      // Say which of these it is. Every one of them used to arrive at the
      // composer as "this folder has no Git checkout, run git init", which is
      // true of exactly one and misleading advice for the rest.
      if (observation.status !== "available") {
        throw new Error(unavailableCheckoutMessage(observation));
      }
      if (
        observation.repositoryRoot !== root ||
        observation.checkout.canonicalPath !== root ||
        observation.checkout.locked !== undefined ||
        observation.checkout.prunable !== undefined
      ) {
        throw new Error("Code Project checkout is unavailable.");
      }
      const head = observation.checkout.detached
        ? { kind: "detached" as const, oid: observation.checkout.head }
        : observation.checkout.branch?.startsWith("refs/heads/")
          ? {
              kind: "branch" as const,
              name: observation.checkout.branch.slice("refs/heads/".length),
              oid: observation.checkout.head,
            }
          : undefined;
      if (head === undefined) throw new Error("Code Project branch is unavailable.");

      const checkout = decodeCodeCheckoutIdentity({
        id: deriveExistingWorktreeCheckoutId({
          projectId,
          bindingRevisionId: revision.revisionId,
          repositoryId: observation.repositoryId,
          canonicalRoot: root,
        }),
        repositoryId: observation.repositoryId,
        kind: "existing-worktree",
        availability: "available",
        head,
        observedAt: options.clock(),
      });
      // D3: observe authoritative remote facts from the Git repository so the
      // composer can decide whether "Start from origin" is available. Fail
      // closed with no remotes when the observation is unavailable.
      let worktreeRemoteFacts: CodeWorktreeRemoteFacts | undefined;
      if (options.gitObservationPort !== undefined) {
        try {
          const gitObservation = await options.gitObservationPort.observe(root);
          if (gitObservation.status === "ready") {
            const remotes = gitObservation.remotes.map((remote) => remote.name);
            worktreeRemoteFacts = {
              remotes,
              ...(gitObservation.upstream === null
                ? {}
                : { upstreamRemote: gitObservation.upstream.remote }),
              ...(remotes.includes("origin")
                ? { defaultRemote: "origin" }
                : remotes.length === 1
                  ? { defaultRemote: remotes[0] }
                  : {}),
            };
          }
        } catch {
          // Fail closed; remote facts remain undefined so Start from origin is disabled.
        }
      }
      return {
        bindingRevisionId: revision.revisionId,
        checkout,
        ...(worktreeRemoteFacts === undefined ? {} : { worktreeRemoteFacts }),
      };
    },
  };
}

export function deriveExistingWorktreeCheckoutId(input: {
  readonly projectId: string;
  readonly bindingRevisionId: string;
  readonly repositoryId: string;
  readonly canonicalRoot: string;
}) {
  const digest = createHash("sha256")
    .update("octant.existing-worktree-checkout.v1\0")
    .update(input.projectId)
    .update("\0")
    .update(input.bindingRevisionId)
    .update("\0")
    .update(input.repositoryId)
    .update("\0")
    .update(input.canonicalRoot)
    .digest("hex")
    .slice(0, 32);
  return decodeCodeCheckoutId(
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`,
  );
}

/**
 * Identity of a folder that stands in for a repository. There is no Git
 * common directory to digest, so the repository id digests the canonical
 * root instead, and the checkout id follows the same derivation the existing
 * worktree uses so both are reproducible from the Project binding alone.
 */
export function plainFolderCheckoutIdentity(input: {
  readonly projectId: string;
  readonly bindingRevisionId: string;
  readonly canonicalRoot: string;
}): { readonly repositoryId: CodeRepositoryId; readonly checkoutId: CodeCheckoutId } {
  const repositoryId = decodeCodeRepositoryId(
    `repo_${createHash("sha256")
      .update("octant.plain-folder-repository.v1\0")
      .update(input.canonicalRoot)
      .digest("hex")}`,
  );
  return {
    repositoryId,
    checkoutId: deriveExistingWorktreeCheckoutId({ ...input, repositoryId }),
  };
}

/**
 * A branch checkout is identified by its branch; HEAD advancing through
 * ordinary commits keeps it the same checkout. A detached checkout has no
 * name, so its OID is its identity and must match exactly.
 */
function observedCheckoutHeadMatches(
  observed: { readonly detached: boolean; readonly head: string; readonly branch?: string },
  expected: CodeCheckoutIdentity["head"],
): boolean {
  if (expected.kind === "none") return false;
  return expected.kind === "detached"
    ? observed.detached && observed.head === expected.oid
    : !observed.detached && observed.branch === `refs/heads/${expected.name}`;
}

export function stableCodeFileId(threadId: string, checkoutId: string, relativePath: string) {
  const digest = createHash("sha256")
    .update("octant.code-file.v1\0")
    .update(threadId)
    .update("\0")
    .update(checkoutId)
    .update("\0")
    .update(relativePath)
    .digest("hex")
    .slice(0, 32);
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`;
  return decodeCodeFileId(uuid);
}

function createProjectPullRequestPorts(ghExecutable: string | undefined): {
  readonly list: CodeProjectPullRequestListPort;
  readonly detail: CodeProjectPullRequestDetailPort;
  readonly merge: CodeProjectPullRequestMergePort;
  /**
   * False when `gh` is missing or refused validation. The background refresh
   * cadence fails closed on this instead of polling ports that can only
   * answer `disconnected`.
   */
  readonly ghAvailable: boolean;
} {
  if (ghExecutable === undefined) {
    return {
      list: { listActive: async () => ({ status: "disconnected" }) },
      detail: { observeReviewByIdentity: async () => ({ status: "unavailable" }) },
      merge: { mergeByIdentity: async () => ({ status: "unavailable", reason: "unavailable" }) },
      ghAvailable: false,
    };
  }
  try {
    const port = new GhPullRequestPort({
      command: createGhCommandPort({ ghPath: ghExecutable }),
      resolveTarget: async () => undefined,
    });
    return {
      list: {
        listActive: (request, signal) => port.listActive(request, signal),
      },
      detail: {
        observeReviewByIdentity: (request, signal) => port.observeReviewByIdentity(request, signal),
      },
      merge: {
        mergeByIdentity: (request, signal) => port.mergeByIdentity(request, signal),
      },
      ghAvailable: true,
    };
  } catch {
    return {
      list: { listActive: async () => ({ status: "disconnected" }) },
      detail: { observeReviewByIdentity: async () => ({ status: "unavailable" }) },
      merge: { mergeByIdentity: async () => ({ status: "unavailable", reason: "unavailable" }) },
      ghAvailable: false,
    };
  }
}

export type CodeDependencies = Pick<ServerStart, "options" | "persistence"> &
  Pick<
    AuthorityWiring,
    | "bindingReceiptStore"
    | "codeApprovalStore"
    | "codeSessionAuthority"
    | "liveTurns"
    | "machineChangeFeed"
    | "onWindowRevoked"
    | "windowAuthorityStore"
  > &
  Pick<
    AgentRunsWiring,
    "externalContentIngestionStore" | "managedWorktreeReceipts" | "threadAwaitsHarnessApproval"
  > &
  Pick<
    IntegrationsWiring,
    | "cacheStats"
    | "githubIssueContextService"
    | "linearIssueContextService"
    | "onGithubPullRequestsUnreadable"
  > &
  Pick<
    WorkspaceWiring,
    "gitEnvironmentPort" | "gitObservationPort" | "projectRootPort" | "projectService"
  > &
  Pick<
    FoundationsWiring,
    | "codeBoardEventStore"
    | "codeEvidence"
    | "isProjectPolicyTargetAllowed"
    | "selectCodeConversation"
  > &
  Pick<
    ProvidersWiring,
    | "managedCodeThreadCreation"
    | "managedWorktreeRefsList"
    | "managedWorktreeSourcePreview"
    | "probeProviderForThreads"
    | "refreshStandaloneSkills"
  >;

export function wireCode(deps: CodeDependencies) {
  const {
    threadAwaitsHarnessApproval,
    bindingReceiptStore,
    cacheStats,
    codeApprovalStore,
    codeBoardEventStore,
    codeEvidence,
    codeSessionAuthority,
    externalContentIngestionStore,
    gitEnvironmentPort,
    githubIssueContextService,
    gitObservationPort,
    isProjectPolicyTargetAllowed,
    linearIssueContextService,
    liveTurns,
    machineChangeFeed,
    managedCodeThreadCreation,
    managedWorktreeReceipts,
    managedWorktreeRefsList,
    managedWorktreeSourcePreview,
    onGithubPullRequestsUnreadable,
    onWindowRevoked,
    options,
    persistence,
    probeProviderForThreads,
    projectRootPort,
    projectService,
    refreshStandaloneSkills,
    selectCodeConversation,
    windowAuthorityStore,
  } = deps;
  return Effect.gen(function* () {
    const codeContent = new CodeContentStore();
    const codeAttachments = new CodeAttachmentStore(persistence.dataDirectory);
    const workAttachments = new WorkAttachmentStore(persistence.dataDirectory);
    // Listing reads directory entries under the bound checkout and needs no
    // file helper, so it is available even when the helper transport is not.
    const codeFileListing = new CodeFileListingService();
    // Watching needs no file helper either: it reports which paths changed and
    // never reads one, so the explorer stays live even when mutations cannot.
    const codeFileWatch = new CodeFileWatchService();
    // Search reads directory entries and file bytes under the bound checkout
    // through the confined ports, so it needs no file helper either.
    const codeFileSearch = new CodeSearchService();
    // Discovery reads only the checkout's package.json and .octant/tests.json,
    // so it needs no file helper either. The same instance authorizes a run.
    const codeTestDiscovery = new RepositoryTestDiscoveryService();
    let codeFiles: Pick<CodeFileService, "open" | "save"> & Partial<Pick<CodeFileService, "list">> =
      {
        open: async () => ({
          status: "failed" as const,
          failure: { category: "unavailable" as const, code: "helper-unavailable" },
        }),
        save: async () => ({
          status: "failed" as const,
          failure: { category: "unavailable" as const, code: "helper-unavailable" },
        }),
        list: (request) => codeFileListing.list(request),
      };
    if (options.codeService === undefined && options.codeFileHelperPath !== undefined) {
      try {
        const transport = (
          options.createCodeFileHelperTransport ??
          ((path: string) => createFileHelperProcessTransport({ helperPath: path }))
        )(options.codeFileHelperPath);
        yield* Effect.addFinalizer(() => Effect.promise(() => transport.close()));
        codeFiles = new CodeFileService({
          port: new FileOperationPort(transport),
          content: codeContent,
          listing: codeFileListing,
        });
      } catch {
        // The server remains available while Code file mutations fail closed as unavailable.
      }
    }
    const repository = options.codeRepositoryPort ?? createManagedWorktreeNodePorts().repository;
    const checkouts = createExistingWorktreeCodeCheckoutObservation({
      projects: projectService,
      readProject: persistence.readProject,
      repository,
      clock: () => new Date().toISOString(),
      gitObservationPort,
      requireGitRepository: () =>
        persistence.readCodeSettings()?.settings.requireGitRepository ?? true,
    });
    const roots = createExistingWorktreeCodeFileRootAuthority({
      projects: projectService,
      readProject: persistence.readProject,
      repository,
      managedReceipts: managedWorktreeReceipts,
      statIdentity: async (path) => {
        const metadata = await lstat(path, { bigint: true });
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error("Code Project root is unavailable.");
        }
        return { device: metadata.dev.toString(10), inode: metadata.ino.toString(10) };
      },
    });
    const codeWorkingDirectoryProbePath = decodeCodeRelativePath("package.json");
    const environmentService = new CodeEnvironmentService({
      projects: projectService,
      git: gitEnvironmentPort,
      clock: () => new Date().toISOString(),
      code: {
        readThread: persistence.readCodeThread,
        readCheckout: persistence.readCodeCheckout,
        resolveCheckoutRoot: async (windowId, thread, checkout) => {
          const root = await roots.resolve(
            windowId,
            thread,
            checkout,
            codeWorkingDirectoryProbePath,
          );
          return root?.rootPath;
        },
      },
    });
    const projectRoutes = createProjectRouteHandler({
      service: projectService,
      environmentService,
      windowAuthorityStore,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const agentProfileService = new AgentProfileService({
      persistence,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    const agentProfileRoutes = createAgentProfileRouteHandler({
      service: agentProfileService,
      windowAuthorityStore,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const folderBrowseService = new FolderBrowseService({
      bindingReceiptStore,
      projectRootPort,
      homeDir: homedir(),
      clock: () => new Date().toISOString(),
    });
    const folderBrowseRoutes = createFolderBrowseRouteHandler({
      service: folderBrowseService,
      windowAuthorityStore,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const codeProjectAccess = new CodeProjectAccess({
      readWorkspace: (scopeId) => persistence.readWindowWorkspace(scopeId)?.workspace,
      hasActiveCodeProject: (id) => projectService.hasActiveProject(id, "code"),
      // A renderer reload keeps its registration; a crashed or closed primary
      // window that reopens registers the same window id again.
      isWindowLive: (scopeId) =>
        windowAuthorityStore.listWindowIds().some((id) => String(id) === String(scopeId)),
    });
    const canAccessCodeProject = (scopeId: WindowId, projectId: ProjectId) =>
      codeProjectAccess.canAccessProject(scopeId, projectId);
    const isCodeProviderModelAllowed = (input: {
      readonly projectId: ProjectId;
      readonly providerInstanceId: ProviderInstance["id"];
      readonly modelId: ProviderModel["id"];
    }): boolean => {
      const project = persistence.readProject(input.projectId);
      if (project?.type !== "code") return false;
      return isProjectPolicyTargetAllowed(project, input.providerInstanceId, input.modelId);
    };
    // The Code runtime is built from this area and answers a fork's point and
    // merge-back, so the runtime's area builds the service once the runtime
    // exists; everything else the service reads is this area's.
    const buildCodeService = (codeOperationRuntime: CodeOperationRuntime | undefined) => {
      const codeService =
        options.codeService ??
        new CodeService({
          liveTurns,
          awaitsHarnessApproval: threadAwaitsHarnessApproval,
          gitHistory: new GitHistoryPort(),
          persistence,
          access: {
            canBrowseProject: (projectId) => projectService.hasActiveProject(projectId, "code"),
            canAccessProject: canAccessCodeProject,
          },
          checkouts,
          roots,
          files: codeFiles,
          tests: codeTestDiscovery,
          watcher: codeFileWatch,
          searcher: codeFileSearch,
          content: codeContent,
          evidence: codeEvidence,
          attachments: codeAttachments,
          uuid: randomUUID,
          clock: () => new Date().toISOString(),
          approvals: codeApprovalStore,
          sessionAuthority: codeSessionAuthority,
          worktreeSourcePreview: {
            preview: (input, signal) => managedWorktreeSourcePreview(input, signal),
          },
          worktreeRefs: {
            list: (input, signal) => managedWorktreeRefsList(input, signal),
          },
          // The operation runtime reads a thread's turns and checkout.
          forkPoints: {
            resolve: async (windowId, source, throughOperationId) =>
              codeOperationRuntime === undefined
                ? { status: "refused", reason: "unavailable" }
                : codeOperationRuntime.forkPoint(windowId, source, throughOperationId),
          },
          // A fork is created only when the conversation it carries over can be
          // read now, through the same selector its first turn uses.
          forkConversation: ({ source, throughOperationId }) =>
            selectCodeConversation(source.id, { purpose: "fork", throughOperationId }),
          recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
          // The runtime owns the journal a merge is recorded in and the turns
          // that carry it.
          forkMergeBack: {
            merge: async (windowId, forkThreadId, throughOperationId) =>
              codeOperationRuntime?.mergeForkContext === undefined
                ? { status: "refused", reason: "unsupported" }
                : codeOperationRuntime.mergeForkContext(windowId, forkThreadId, throughOperationId),
          },
          managedThreadCreation: {
            prepare: (input, signal) => managedCodeThreadCreation.prepare(input, signal),
            commit: (input, preparation, signal) =>
              managedCodeThreadCreation.commit(input, preparation, signal),
            cleanup: (input, signal) => managedCodeThreadCreation.cleanup(input, signal),
          },
          workingDirectories: {
            resolve: async (windowId, thread, checkout, workingDirectory) => {
              const root = await roots.resolve(
                windowId,
                thread,
                checkout,
                codeWorkingDirectoryProbePath,
              );
              return root === undefined
                ? undefined
                : resolveThreadWorkingDirectory(root.rootPath, workingDirectory);
            },
          },
          onWorkingDirectoryChanged: async () => refreshStandaloneSkills(),
          waitForThreadChange: (signal) => machineChangeFeed.waitFor("code-navigation", signal),
          probeProvider: (providerInstanceId) => probeProviderForThreads(providerInstanceId),
          isProviderModelAllowed: isCodeProviderModelAllowed,
          issueContext: githubIssueContextService,
          linearIssueContext: linearIssueContextService,
          // Resolved lazily: the pull-request service is constructed after this
          // one, and a navigation read is the first thing that needs it.
          pullRequests: {
            snapshot: (windowId) => projectPullRequestService.navigationSnapshot(windowId),
          },
        });
      // Revocation is wired at construction, before any window can hold a watch.
      onWindowRevoked((windowId) => codeService.revokeWindow?.(windowId));
      // What the Code service lends the host's completed-thread timer. Only the
      // in-process service can archive on the host's behalf; an injected route
      // service is a test double and lends nothing.
      const codeCompletedThreadSource =
        codeService instanceof CodeService
          ? {
              mode: "code" as const,
              threads: () => persistence.readCodeThreads(),
              archive: (threadId: string, input: CompletedThreadArchiveInput) =>
                codeService.archiveCompletedThread(decodeCodeThreadId(threadId), input),
            }
          : undefined;
      return { codeCompletedThreadSource, codeService };
    };
    const projectPullRequestPorts = createProjectPullRequestPorts(options.ghExecutable);
    // Host-wide on purpose: the snapshot cache is shared across windows, so
    // linked-thread facts must come from every persisted Code thread, not from
    // any window's visible subset. Session-authority overlays only change
    // executionPolicy, which no fact here reads.
    const listProjectPullRequestThreadFacts = async () => {
      const facts: Array<{
        readonly threadId: string;
        readonly projectId: string;
        readonly title: string;
        readonly repository: { readonly owner: string; readonly name: string };
        readonly deliveryBranch: string;
        readonly pullRequestNumbers: ReadonlyArray<{
          readonly number: number;
          readonly observedAt: string;
        }>;
      }> = [];
      for (const thread of persistence.readCodeThreads()) {
        const repository = thread.deliveryTarget.proposedBaseRepository;
        const slash = repository.indexOf("/");
        if (slash <= 0 || repository.includes("/", slash + 1)) continue;
        const owner = repository.slice(0, slash);
        const name = repository.slice(slash + 1);
        if (owner === undefined || name === undefined) continue;
        facts.push({
          threadId: String(thread.id),
          projectId: String(thread.projectId),
          title: thread.title,
          repository: { owner, name },
          deliveryBranch: thread.deliveryTarget.branchIntent,
          pullRequestNumbers: pullRequestIdentitiesFromHistory(
            codeBoardEventStore.historyForThread(thread.id),
          ),
        });
      }
      return facts;
    };
    // The Code runtime is composed after this service and subscribes here.
    const pullRequestSnapshotListeners: Array<
      (rows: ReadonlyArray<CodeProjectPullRequestRow>) => void
    > = [];
    const onPullRequestSnapshotRefreshed = (
      listener: (rows: ReadonlyArray<CodeProjectPullRequestRow>) => void,
    ): void => {
      pullRequestSnapshotListeners.push(listener);
    };
    const projectPullRequestService = new CodeProjectPullRequestService({
      projects: projectService,
      // Only the remotes: the full observation also diffs the working tree
      // and hashes every changed file, which cost the two-second navigation
      // tick one to five seconds per memo miss on a large checkout.
      remotes: { remotes: (root) => gitObservationPort.observeRemotes(root) },
      list: projectPullRequestPorts.list,
      detail: projectPullRequestPorts.detail,
      merge: projectPullRequestPorts.merge,
      recordMerge: (record) =>
        journalPullRequestMerge(persistence.journal, record, {
          uuid: randomUUID,
          clock: () => new Date().toISOString(),
        }),
      cacheStats,
      snapshotStore: new CodeProjectPullRequestSnapshotStore(
        join(persistence.dataDirectory, "code", "pull-request-snapshot.json"),
      ),
      onSnapshotRefreshed: (rows) => {
        for (const listener of pullRequestSnapshotListeners) listener(rows);
      },
      threads: {
        list: () => listProjectPullRequestThreadFacts(),
      },
    });
    onGithubPullRequestsUnreadable(() => projectPullRequestService.revokeGithub());
    // The cadence acts as the host, not as any renderer window. The window
    // identity below exists only to satisfy window-shaped observe signatures;
    // on this host `projectService.bootstrap` and Code Project access checks
    // do not branch on it, so no renderer authority is borrowed or widened.
    // Thread facts for hasBoardRelevantIdentities are host-wide (above).
    const pullRequestCadenceWindowId = decodeWindowId(randomUUID());
    // Refreshed once per cadence pass by the projects callback below, so the
    // per-Project identity check is a set lookup instead of a journal replay
    // repeated for every Project on every wake.
    let pullRequestCadenceProjectsWithIdentities: ReadonlySet<string> = new Set();
    const projectPullRequestCadence = new CodeProjectPullRequestCadence({
      projects: async () => {
        const projects = persistence
          .readProjects({ lifecycle: "active" })
          .filter((project) => project.type === "code")
          .map((project) => ({
            projectId: project.id,
            enabled: project.pullRequestBackgroundRefresh === "enabled",
          }));
        // A fleet with nothing enabled must cost nothing per wake: skip the
        // thread-fact read entirely rather than replaying journals for a
        // feature that is off.
        pullRequestCadenceProjectsWithIdentities = projects.some((project) => project.enabled)
          ? new Set((await listProjectPullRequestThreadFacts()).map((fact) => fact.projectId))
          : new Set();
        return projects;
      },
      hasBoardRelevantIdentities: (projectId) =>
        pullRequestCadenceProjectsWithIdentities.has(String(projectId)),
      observe: (projectId, signal) =>
        projectPullRequestService.observeForCadence(pullRequestCadenceWindowId, projectId, signal),
      onState: (state) => projectPullRequestService.recordBackgroundRefreshState(state),
      ghAvailable: projectPullRequestPorts.ghAvailable,
    });
    projectPullRequestCadence.start();
    return {
      agentProfileRoutes,
      buildCodeService,
      canAccessCodeProject,
      codeAttachments,
      codeFileWatch,
      codeProjectAccess,
      codeTestDiscovery,
      codeWorkingDirectoryProbePath,
      environmentService,
      folderBrowseRoutes,
      folderBrowseService,
      isCodeProviderModelAllowed,
      onPullRequestSnapshotRefreshed,
      projectPullRequestCadence,
      projectPullRequestService,
      projectRoutes,
      roots,
      workAttachments,
    };
  });
}

export type CodeWiring = Effect.Effect.Success<ReturnType<typeof wireCode>>;
