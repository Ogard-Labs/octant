/**
 * Pure authority and shaping for one thread export.
 *
 * The server assembles what the journal holds; this module decides who may
 * ask, whether that thread is readable, and how the portable cut is written
 * so a secret, a path, or a raw provider payload cannot appear.
 */

import type { CanvasBlock } from "@octant/contracts/canvas";
import type { UtcTimestamp } from "@octant/contracts/events";
import type { HostId } from "@octant/contracts/host";
import type { ProjectId } from "@octant/contracts/projects";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import {
  THREAD_EXPORT_FORMAT,
  type ThreadExportArtifact,
  type ThreadExportAttachment,
  type ThreadExportBundle,
  type ThreadExportCitation,
  type ThreadExportCompletion,
  type ThreadExportId,
  type ThreadExportOmission,
  type ThreadExportOmissionKind,
  type ThreadExportTranscript,
  type ThreadExportTranscriptEntry,
} from "@octant/contracts/thread-export";
import { artifactKindForBlocks } from "./artifactLibraryPolicy";

/**
 * Every kind of caller the thread export command could be reached by.
 * A local window and a paired device may export a thread they can already
 * Open. A provider, automation, or extension cannot.
 */
export type ThreadExportActorKind =
  | "local-window"
  | "remote-device"
  | "provider"
  | "automation"
  | "extension";

export type ThreadExportAuthorization =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly reason: "actor-not-reader" };

export function authorizeThreadExportActor(
  actorKind: ThreadExportActorKind,
): ThreadExportAuthorization {
  return actorKind === "local-window" || actorKind === "remote-device"
    ? { kind: "allowed" }
    : { kind: "denied", reason: "actor-not-reader" };
}

/**
 * Missing and unreadable collapse to the same refusal so the export does not
 * disclose that a hidden thread exists.
 */
export function decideThreadExportAccess(input: {
  readonly exists: boolean;
  readonly readable: boolean;
}): { readonly kind: "allow" } | { readonly kind: "refuse"; readonly reason: "not-found" } {
  if (!input.exists || !input.readable) return { kind: "refuse", reason: "not-found" };
  return { kind: "allow" };
}

export const THREAD_EXPORT_FORBIDDEN_KEYS = [
  "promptBody",
  "fileContents",
  "credentials",
  "providerHeaders",
  "accountId",
  "resumeCursor",
  "apiKey",
  "accessToken",
  "refreshToken",
  "password",
  "canonicalRoot",
  "providerPayload",
] as const;

/**
 * Walk a value for keys this export must never carry.
 *
 * Used as a last closed check after the bundle is shaped: if a new field
 * starts leaking a secret, the command refuses rather than handing the file
 * over.
 */
export function threadExportContainsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(threadExportContainsForbiddenKey);
  if (typeof value !== "object" || value === null) return false;
  for (const [key, child] of Object.entries(value)) {
    if ((THREAD_EXPORT_FORBIDDEN_KEYS as ReadonlyArray<string>).includes(key)) return true;
    if (threadExportContainsForbiddenKey(child)) return true;
  }
  return false;
}

export interface ThreadExportArtifactSource {
  readonly canvasId: string;
  readonly versionId: string;
  readonly sequence: number;
  readonly title: string;
  readonly updatedAt: UtcTimestamp;
  readonly definition: {
    readonly title: string;
    readonly blocks: ReadonlyArray<Pick<CanvasBlock, "kind">>;
  };
}

export interface ThreadExportSource {
  readonly threadId: ThreadExportId;
  readonly mode: "chat" | "work" | "code";
  readonly title: string;
  readonly hostId: HostId;
  readonly projectId?: ProjectId;
  readonly version: number;
  readonly sequence: number;
  readonly generatedAt: UtcTimestamp;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
  readonly branchedFrom?: {
    readonly threadId: string;
    readonly sourceVersion: number;
    readonly carriedTurnCount: number;
    readonly occurredAt: UtcTimestamp;
  };
  readonly transcript: ThreadExportTranscript;
  readonly artifacts: ReadonlyArray<ThreadExportArtifactSource>;
  readonly attachments: ReadonlyArray<ThreadExportAttachment>;
  readonly citations: ReadonlyArray<ThreadExportCitation>;
  readonly completion?: ThreadExportCompletion;
  readonly omissions: ReadonlyArray<ThreadExportOmission>;
}

/**
 * Shape the portable cut. Identity is written first, the way an artifact
 * bundle writes it, so a file that travels still says which thread, which
 * host, and when the cut was taken.
 */
export function buildThreadExportBundle(source: ThreadExportSource): ThreadExportBundle {
  const artifacts: ReadonlyArray<ThreadExportArtifact> = source.artifacts.map((artifact) => ({
    canvasId: artifact.canvasId,
    versionId: artifact.versionId,
    sequence: artifact.sequence,
    title: artifact.title,
    kind: artifactKindForBlocks(artifact.definition.blocks),
    updatedAt: artifact.updatedAt,
    definition: artifact.definition,
  }));
  const headerProject = source.projectId === undefined ? {} : { projectId: source.projectId };
  const provenanceProject = source.projectId === undefined ? {} : { projectId: source.projectId };
  const branched = source.branchedFrom === undefined ? {} : { branchedFrom: source.branchedFrom };
  const completion = source.completion === undefined ? {} : { completion: source.completion };
  return {
    octant: {
      format: THREAD_EXPORT_FORMAT,
      threadId: source.threadId,
      mode: source.mode,
      title: source.title,
      ...headerProject,
      hostId: source.hostId,
      version: source.version,
      sequence: source.sequence,
      generatedAt: source.generatedAt,
    },
    transcript: source.transcript,
    evidence: {
      artifacts,
      attachments: source.attachments,
      citations: source.citations,
      ...completion,
    },
    provenance: {
      mode: source.mode,
      threadId: source.threadId,
      hostId: source.hostId,
      ...provenanceProject,
      providerInstanceId: source.providerInstanceId,
      modelId: source.modelId,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      ...branched,
    },
    omissions: source.omissions,
  };
}

/**
 * Diff-friendly JSON, matching artifact bundles: fixed two-space indent and a
 * trailing newline so a later cut that changed one sentence shows one line.
 */
export function serializeThreadExportBundle(bundle: ThreadExportBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function countOmission(
  kind: ThreadExportOmissionKind,
  count: number,
): ThreadExportOmission | undefined {
  if (count <= 0) return undefined;
  return { kind, count };
}

export function collectOmissions(
  counts: Partial<Record<ThreadExportOmissionKind, number>>,
): ReadonlyArray<ThreadExportOmission> {
  const omissions: ThreadExportOmission[] = [];
  for (const kind of [
    "attachment-bytes",
    "superseded-turns",
    "in-progress",
    "unreadable-content",
    "truncated-conversation",
    "bulk-outside-journal",
  ] as const) {
    const omission = countOmission(kind, counts[kind] ?? 0);
    if (omission !== undefined) omissions.push(omission);
  }
  return omissions;
}

export function transcriptWithCounts(
  entries: ReadonlyArray<ThreadExportTranscriptEntry>,
  revisedCount: number,
): ThreadExportTranscript {
  return {
    entries,
    activeCount: entries.filter((entry) => entry.role === "user").length,
    revisedCount,
  };
}
