import type {
  ChatThread,
  CodeCheckoutIdentity,
  CodeThread,
  WorkThread,
  HostId,
  ProductSurfaceSettings,
  ProjectBootstrap,
  ProjectSummary,
  ZenThreadCatalogEntry,
  ZenThreadCatalogRef,
  WindowId,
} from "@octant/contracts";
import { decodeZenThreadCatalogEntry, decodeZenThreadCatalogRef } from "@octant/contracts";

export interface ZenThreadCatalogDependencies {
  readonly localHostId: HostId;
  readonly readSettings: () => ProductSurfaceSettings;
  readonly readProjects: (windowId: WindowId) => Promise<ProjectBootstrap>;
  readonly readChatThreads: () => ReadonlyArray<ChatThread>;
  readonly readWorkThreads: () => ReadonlyArray<WorkThread>;
  readonly readCodeThreads: () => ReadonlyArray<CodeThread>;
  readonly readCodeCheckout: (
    checkoutId: CodeThread["checkoutId"],
  ) => CodeCheckoutIdentity | undefined;
}

export class ZenThreadCatalog {
  constructor(readonly dependencies: ZenThreadCatalogDependencies) {}

  async search(windowId: WindowId, query = ""): Promise<ReadonlyArray<ZenThreadCatalogEntry>> {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const settings = this.dependencies.readSettings();
    const projects = await this.dependencies.readProjects(windowId);
    const activeProjects = new Map(projects.active.map((project) => [String(project.id), project]));
    const availableBoundProjects = new Set(
      projects.availability.flatMap((availability) =>
        availability.status === "available" ? [String(availability.projectId)] : [],
      ),
    );

    const entries: ZenThreadCatalogEntry[] = [];
    if (settings.chatEnabled) {
      for (const thread of this.dependencies.readChatThreads()) {
        if (thread.lifecycle === "deleting" || thread.lifecycle === "deleted") continue;
        const project =
          thread.projectId === undefined ? undefined : activeProjects.get(String(thread.projectId));
        if (thread.projectId !== undefined && (project === undefined || project.type !== "chat")) {
          continue;
        }
        entries.push(
          this.entry({
            mode: "chat",
            project,
            thread,
            projectLabel: project?.name ?? "Unfiled Chat",
          }),
        );
      }
    }

    if (settings.workEnabled) {
      for (const thread of this.dependencies.readWorkThreads()) {
        if (thread.lifecycle === "deleting" || thread.lifecycle === "deleted") continue;
        const project = activeProjects.get(String(thread.projectId));
        if (
          project === undefined ||
          project.type !== "work" ||
          !availableBoundProjects.has(String(project.id))
        ) {
          continue;
        }
        entries.push(this.entry({ mode: "work", project, thread, projectLabel: project.name }));
      }
    }

    for (const thread of this.dependencies.readCodeThreads()) {
      const project = activeProjects.get(String(thread.projectId));
      const checkout = this.dependencies.readCodeCheckout(thread.checkoutId);
      if (
        project === undefined ||
        project.type !== "code" ||
        !availableBoundProjects.has(String(project.id)) ||
        checkout === undefined ||
        checkout.availability !== "available" ||
        String(checkout.repositoryId) !== String(thread.repositoryId)
      ) {
        continue;
      }
      entries.push(
        this.entry({
          mode: "code",
          project,
          thread,
          projectLabel: project.name,
          worktreeId: String(checkout.id),
        }),
      );
    }

    return entries
      .filter((entry) => matchesQuery(entry, normalizedQuery))
      .sort(
        (left, right) =>
          right.recentActivityAt.localeCompare(left.recentActivityAt) ||
          String(left.catalogRef).localeCompare(String(right.catalogRef)),
      );
  }

  async resolve(
    windowId: WindowId,
    catalogRef: ZenThreadCatalogRef,
  ): Promise<ZenThreadCatalogEntry | undefined> {
    const exact = decodeZenThreadCatalogRef(catalogRef);
    return (await this.search(windowId)).find((entry) => entry.catalogRef === exact);
  }

  private entry(input: {
    readonly mode: "chat" | "work" | "code";
    readonly project: ProjectSummary | undefined;
    readonly projectLabel: string;
    readonly thread: ChatThread | WorkThread | CodeThread;
    readonly worktreeId?: string;
  }): ZenThreadCatalogEntry {
    const sourceContext = {
      hostId: this.dependencies.localHostId,
      mode: input.mode,
      projectId: input.project?.id ?? null,
      threadKind: input.mode,
      threadId: input.thread.id,
      ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
    } as const;
    return decodeZenThreadCatalogEntry({
      catalogRef: `${input.mode}:${input.thread.id}`,
      hostId: this.dependencies.localHostId,
      hostLabel: "This Mac",
      mode: input.mode,
      projectId: input.project?.id ?? null,
      projectLabel: input.projectLabel,
      threadId: input.thread.id,
      title: input.thread.title,
      status: input.thread.lifecycle,
      recentActivityAt: input.thread.updatedAt,
      providerInstanceId: input.thread.providerInstanceId,
      modelId: input.thread.modelId,
      sourceContext,
    });
  }
}

function matchesQuery(entry: ZenThreadCatalogEntry, query: string): boolean {
  if (query.length === 0) return true;
  return [entry.title, entry.mode, entry.projectLabel, entry.status, entry.recentActivityAt].some(
    (value) => value.toLocaleLowerCase().includes(query),
  );
}
