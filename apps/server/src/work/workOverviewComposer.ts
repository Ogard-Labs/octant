import {
  type WorkRequest,
  type WorkThread,
  type Workflow,
  decodeWorkOverviewProjection,
  type WorkOverviewItem,
  type WorkOverviewProjection,
  type ProjectId,
} from "@octant/contracts";
import { baseWorkCapabilityReport } from "./workCapabilityCatalog";
import type {
  WorkArtifactEntry,
  WorkArtifactExportEntry,
  WorkArtifactProjection,
} from "./workArtifactProjection";

/**
 * Composes a Work Project Overview projection from the rebuildable artifact
 * projection and honest capability catalog. No analytics store, no invented
 * metrics, no Code/Git surfaces, and no host paths leave this boundary.
 */
export function composeWorkOverviewProjection(
  projection: WorkArtifactProjection,
  projectId: ProjectId,
  threads: ReadonlyArray<WorkThread> = [],
  workflows: ReadonlyArray<Workflow> = [],
  hasActiveWorkflowForThread?: (threadId: string) => boolean,
  pendingRequests: ReadonlyArray<WorkRequest> = [],
): WorkOverviewProjection {
  const entries = [...projection.snapshot().values()]
    .filter((entry) => entry.projectId === projectId && !entry.deleted)
    .sort((left, right) => right.sequence - left.sequence)
    .slice(0, 64);

  const filesAndArtifacts = entries.map(fileItem);
  const versions = entries.map(versionItem);
  const validation = validationItems(entries);
  const exports = projection.snapshotExports(projectId).map(exportItem).slice(0, 64);
  const workflowsAndThreads = workflowAndThreadItems(
    threads,
    workflows,
    projectId,
    hasActiveWorkflowForThread,
  );

  const approvals = pendingRequests
    .filter(
      (request) => request.status === "pending" && String(request.projectId) === String(projectId),
    )
    .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
    .slice(0, 64)
    .map(approvalItem);

  return decodeWorkOverviewProjection({
    projectId,
    filesAndArtifacts,
    workflowsAndThreads,
    approvals,
    versions,
    validation,
    exports,
  });
}

/**
 * Distinguishes an active workflow from an ordinary related thread using
 * only journaled facts: a thread whose id matches an `active` Work
 * workflow's `relatedThreadId` is labeled as a workflow; every other active
 * thread is labeled as a plain thread, exactly as before this projection
 * existed. A workflow that has completed or been cancelled stops appearing
 * here the moment its thread is no longer active, so this section never
 * lists stale or historical workflow state.
 */
function workflowAndThreadItems(
  threads: ReadonlyArray<WorkThread>,
  workflows: ReadonlyArray<Workflow>,
  projectId: ProjectId,
  hasActiveWorkflowForThread?: (threadId: string) => boolean,
): WorkOverviewItem[] {
  const activeWorkflowByThread = new Map<string, Workflow>();
  for (const workflow of workflows) {
    if (workflow.lifecycle !== "active") continue;
    if (String(workflow.projectId) !== String(projectId)) continue;
    activeWorkflowByThread.set(String(workflow.relatedThreadId), workflow);
  }

  return threads
    .filter((thread) => {
      if (String(thread.projectId) !== String(projectId)) return false;
      if (thread.completionConfirmed === true) return false;
      const hasWorkflow =
        activeWorkflowByThread.has(String(thread.id)) ||
        hasActiveWorkflowForThread?.(String(thread.id)) === true;
      return thread.lifecycle === "active" || (thread.lifecycle === "archived" && hasWorkflow);
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 64)
    .map((thread) => ({
      id: String(thread.id),
      label: thread.title,
      detail:
        activeWorkflowByThread.has(String(thread.id)) ||
        hasActiveWorkflowForThread?.(String(thread.id)) === true
          ? "Active workflow"
          : "Active thread",
    }));
}

function approvalItem(request: WorkRequest): WorkOverviewItem {
  return {
    id: String(request.requestId),
    label: request.detail.kind === "approval" ? request.detail.action : request.detail.prompt,
    detail: request.detail.kind === "approval" ? "Approval requested" : "Input requested",
  };
}

function fileItem(entry: WorkArtifactEntry): WorkOverviewItem {
  return {
    id: String(entry.artifactId),
    label: entry.displayName,
    detail: entry.format.toUpperCase(),
  };
}

function versionItem(entry: WorkArtifactEntry): WorkOverviewItem {
  return {
    id: `${String(entry.artifactId)}:v${entry.sequence}`,
    label: `v${entry.sequence} · ${entry.displayName}`,
    detail: entry.sequence === 1 ? "Created" : "Revised",
  };
}

function exportItem(entry: WorkArtifactExportEntry): WorkOverviewItem {
  return {
    id: entry.exportId,
    label: entry.displayName,
    detail: `${entry.exportFormat.toUpperCase()} · ${
      entry.handoffKind === "external-handoff" ? "External app handoff" : "In-app version"
    }`,
  };
}

function validationItems(entries: ReadonlyArray<WorkArtifactEntry>): WorkOverviewItem[] {
  const seen = new Set<string>();
  const items: WorkOverviewItem[] = [];
  for (const entry of entries) {
    if (seen.has(entry.format)) continue;
    seen.add(entry.format);
    const report = baseWorkCapabilityReport(entry.format);
    items.push({
      id: entry.format,
      label: `${entry.format.toUpperCase()} · ${fidelityLabel(report.fidelity.level)}`,
      detail: "Honest capability",
    });
    if (items.length >= 64) break;
  }
  return items;
}

function fidelityLabel(level: "full" | "limited"): string {
  return level === "full" ? "full fidelity" : "limited fidelity";
}

export { hydrateWorkArtifactProjectionFromJournal } from "./workArtifactProjection";
