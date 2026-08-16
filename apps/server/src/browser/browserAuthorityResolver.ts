import { createHash } from "node:crypto";
import {
  ToolHostId,
  ToolRootId,
  ToolWorktreeId,
  type BrowserThreadId,
  type CodeThreadId,
  type WorkThreadId,
  type ToolActionAuthority,
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
  readonly persistence: Pick<
    PersistenceService,
    "readProject" | "readCodeThread" | "readProviderInstance"
  >;
  readonly workThreads: Pick<WorkThreadProjection, "read">;
}

export class ServerBrowserAuthorityResolver implements BrowserAuthorityResolver {
  readonly #options: BrowserAuthorityResolverOptions;

  constructor(options: BrowserAuthorityResolverOptions) {
    this.#options = options;
  }

  resolve(threadId: BrowserThreadId, mode: "work" | "code"): ToolActionAuthority | undefined {
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
      if (revision === undefined) return undefined;
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
}

export function deriveToolHostId(seed: string): typeof ToolHostId.Type {
  const digest = createHash("sha256").update("octant.tool-host.v1\0").update(seed).digest("hex");
  return decodeToolHostId(
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
  );
}
