import { createHash } from "node:crypto";
import {
  ToolHostId,
  ToolRootId,
  ToolWorktreeId,
  type BrowserThreadId,
  type HostId,
  type ChatThreadId,
  type CodeThreadId,
  type WorkThreadId,
  type ToolActionAuthority,
  type WindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { WorkThreadProjection } from "../work/workThreadProjection";
import type { PersistenceService } from "../persistence/persistenceService";
import type { BrowserAuthorityResolver } from "./browserAutomationService";

const decodeToolHostId = Schema.decodeUnknownSync(ToolHostId);
const decodeToolRootId = Schema.decodeUnknownSync(ToolRootId);
const decodeToolWorktreeId = Schema.decodeUnknownSync(ToolWorktreeId);

export interface BrowserAuthorityResolverOptions {
  readonly hostId: typeof ToolHostId.Type;
  /** Workspace shell identity; distinct from the ToolHostId authority namespace. */
  readonly workspaceHostId: HostId;
  readonly persistence: Pick<
    PersistenceService,
    "readProject" | "readCodeThread" | "readChatThread" | "readProviderInstance"
  > &
    Partial<Pick<PersistenceService, "readWindowWorkspace">>;
  readonly workThreads: Pick<WorkThreadProjection, "read">;
}

export class ServerBrowserAuthorityResolver implements BrowserAuthorityResolver {
  readonly #options: BrowserAuthorityResolverOptions;

  constructor(options: BrowserAuthorityResolverOptions) {
    this.#options = options;
  }

  resolve(
    threadId: BrowserThreadId,
    mode: ToolActionAuthority["mode"],
  ): ToolActionAuthority | undefined {
    if (mode === "chat") {
      const thread = this.#options.persistence.readChatThread(threadId as unknown as ChatThreadId);
      if (thread === undefined || thread.lifecycle !== "active") return undefined;
      const provider = this.#options.persistence.readProviderInstance(thread.providerInstanceId);
      if (provider?.enabled !== true) return undefined;
      return {
        hostId: this.#options.hostId,
        mode,
        ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
        providerInstanceId: thread.providerInstanceId,
        extension: { kind: "core" },
      };
    }
    if (mode === "work") {
      const thread = this.#options.workThreads.read(threadId as unknown as WorkThreadId);
      if (thread === undefined || thread.lifecycle !== "active") return undefined;
      const project = this.#options.persistence.readProject(thread.projectId);
      const provider = this.#options.persistence.readProviderInstance(thread.providerInstanceId);
      if (
        project?.type !== "work" ||
        project.lifecycle !== "active" ||
        provider?.enabled !== true
      ) {
        return undefined;
      }
      const revision = project.bindingHistory.at(-1);
      // Work threads carry the binding they were created against. A missing or
      // stale revision cannot borrow the Project's current root.
      if (revision === undefined || revision.revisionId !== thread.bindingRevisionId) {
        return undefined;
      }
      return {
        hostId: this.#options.hostId,
        mode,
        projectId: thread.projectId,
        rootId: decodeToolRootId(revision.revisionId),
        providerInstanceId: thread.providerInstanceId,
        extension: { kind: "core" },
      };
    }

    const thread = this.#options.persistence.readCodeThread(threadId as unknown as CodeThreadId);
    if (thread === undefined || thread.lifecycle !== "active") return undefined;
    const project = this.#options.persistence.readProject(thread.projectId);
    const provider = this.#options.persistence.readProviderInstance(thread.providerInstanceId);
    if (project?.type !== "code" || project.lifecycle !== "active" || provider?.enabled !== true) {
      return undefined;
    }
    const revision = project.bindingHistory.at(-1);
    if (revision?.revisionId !== thread.bindingRevisionId) return undefined;
    return {
      hostId: this.#options.hostId,
      mode,
      projectId: thread.projectId,
      rootId: decodeToolRootId(thread.bindingRevisionId),
      worktreeId: decodeToolWorktreeId(thread.checkoutId),
      providerInstanceId: thread.providerInstanceId,
      extension: { kind: "core" },
    };
  }

  canAccessWindow(
    windowId: WindowId,
    threadId: BrowserThreadId,
    mode: ToolActionAuthority["mode"],
  ): boolean {
    const authority = this.resolve(threadId, mode);
    const readWindowWorkspace = this.#options.persistence.readWindowWorkspace;
    if (authority === undefined || readWindowWorkspace === undefined) return false;
    const projected = readWindowWorkspace(windowId);
    if (projected === undefined) return false;
    const workspace = projected.workspace;
    const context = workspace.contextByMode[mode];
    if (context.mode !== mode || String(context.host) !== String(this.#options.workspaceHostId)) {
      return false;
    }
    // The persisted mode Project is the window boundary. A thread may keep
    // running after the user selects another thread in the same Project; pane
    // selection is presentation state, not a new authority grant.
    return String(context.projectId) === String(authority.projectId ?? null);
  }
}

export function deriveToolHostId(seed: string): typeof ToolHostId.Type {
  const digest = createHash("sha256").update("octant.tool-host.v1\0").update(seed).digest("hex");
  return decodeToolHostId(
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
  );
}
