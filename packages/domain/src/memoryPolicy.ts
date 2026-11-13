import type { AggregateVersion, UtcTimestamp } from "@octant/contracts/events";
import type {
  ActiveMemoryEntry,
  AgentAuthoredMemoryProvenance,
  MemoryEntry,
  MemoryEntryId,
  MemoryKind,
  MemoryProvenance,
  ProjectActor,
  ProjectId,
  RetractedMemoryEntry,
  SupersededMemoryEntry,
  TransferredActiveMemoryEntry,
} from "@octant/contracts/projects";

export type MemoryPolicyRejectionCode =
  | "entry-not-active"
  | "invalid-actor"
  | "invalid-content"
  | "invalid-entry-id"
  | "invalid-kind"
  | "invalid-reason";

export class MemoryPolicyRejected extends Error {
  override readonly name = "MemoryPolicyRejected";

  constructor(
    readonly code: MemoryPolicyRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: MemoryPolicyRejectionCode, message: string): never {
  throw new MemoryPolicyRejected(code, message);
}

/** A copy that names the same actor: a device keeps its id, and nothing else rides along. */
function cloneActor(actor: ProjectActor): ProjectActor {
  return actor.kind === "remote-device"
    ? { kind: actor.kind, actorId: actor.actorId, deviceId: actor.deviceId }
    : { kind: actor.kind, actorId: actor.actorId };
}

/**
 * A memory change is a person's own act: at this host, or on a device they
 * paired, which the entry then names. The host never writes one by itself.
 */
function requireUserActor(actor: ProjectActor): ProjectActor {
  if (actor.kind === "system") {
    reject("invalid-actor", "Project memory changes require an explicit action by a person");
  }
  return cloneActor(actor);
}

function normalizeContent(content: string): string {
  const normalized = content.trim();
  if (normalized.length === 0) reject("invalid-content", "Memory content cannot be empty");
  return normalized;
}

function normalizeReason(reason: string): string {
  const normalized = reason.trim();
  if (normalized.length === 0) reject("invalid-reason", "Retraction reason cannot be empty");
  return normalized;
}

const memoryKinds = new Set<MemoryKind>(["decision", "fact", "preference", "summary", "outcome"]);

function requireKind(kind: MemoryKind): MemoryKind {
  if (!memoryKinds.has(kind)) reject("invalid-kind", "Memory kind is unsupported");
  return kind;
}

function requireActive(entry: MemoryEntry): ActiveMemoryEntry {
  if (entry.status !== "active") {
    reject("entry-not-active", "Only active Project memory can be changed or transferred");
  }
  return entry;
}

function nextVersion(version: AggregateVersion): AggregateVersion {
  return (version + 1) as AggregateVersion;
}

function cloneProvenance(provenance: MemoryProvenance): MemoryProvenance {
  if (provenance.kind === "user-authored") return { kind: "user-authored" };
  if (provenance.kind === "agent-authored") return agentProvenance(provenance);
  return {
    kind: "transferred",
    sourceProjectId: provenance.sourceProjectId,
    sourceEntryId: provenance.sourceEntryId,
    destinationProjectId: provenance.destinationProjectId,
    transferredBy: cloneActor(provenance.transferredBy),
    transferredAt: provenance.transferredAt,
    selectedContent: provenance.selectedContent,
  };
}

function agentProvenance(origin: AgentAuthoredMemoryProvenance): AgentAuthoredMemoryProvenance {
  return {
    kind: "agent-authored",
    mode: origin.mode,
    ...(origin.threadId === undefined ? {} : { threadId: origin.threadId }),
    ...(origin.unconfirmed === true ? { unconfirmed: true } : {}),
  };
}

/**
 * What becomes of a write a thread's agent asks Project memory for. Plan
 * refuses before anything else. Full access, or the Project's setting below
 * it, writes with nobody asked. Otherwise the person confirms a card, and a
 * turn with nobody at a window on the host has no one to show it to.
 */
export type AgentProjectMemoryWrite = "refuse-plan" | "write" | "ask" | "refuse-nobody-to-confirm";

export function agentProjectMemoryWrite(input: {
  readonly plan: boolean;
  readonly fullAccess: boolean;
  /** The Project's "Agents may write Project memory without asking" setting. */
  readonly projectAllows: boolean;
  readonly somebodyAtWindow: boolean;
}): AgentProjectMemoryWrite {
  if (input.plan) return "refuse-plan";
  if (input.fullAccess || input.projectAllows) return "write";
  return input.somebodyAtWindow ? "ask" : "refuse-nobody-to-confirm";
}

export interface CreateMemoryEntryInput {
  readonly id: MemoryEntryId;
  readonly projectId: ProjectId;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly actor: ProjectActor;
  readonly createdAt: UtcTimestamp;
  readonly expectedVersion: AggregateVersion;
  /**
   * The thread whose agent proposed the text. The approving person stays the
   * author; absent means the person wrote it.
   */
  readonly agentOrigin?: AgentAuthoredMemoryProvenance;
}

export function createMemoryEntry(input: CreateMemoryEntryInput): ActiveMemoryEntry {
  return {
    id: input.id,
    projectId: input.projectId,
    kind: requireKind(input.kind),
    content: normalizeContent(input.content),
    provenance:
      input.agentOrigin === undefined
        ? { kind: "user-authored" }
        : agentProvenance(input.agentOrigin),
    author: requireUserActor(input.actor),
    status: "active",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export interface SupersedeMemoryEntryInput {
  readonly successorEntryId: MemoryEntryId;
  readonly content: string;
  readonly actor: ProjectActor;
  readonly supersededAt: UtcTimestamp;
  readonly expectedVersion: AggregateVersion;
  /** As for a new entry: the thread whose agent proposed the replacement text. */
  readonly agentOrigin?: AgentAuthoredMemoryProvenance;
}

export interface SupersedeMemoryEntryResult {
  readonly previousEntry: SupersededMemoryEntry;
  readonly entry: ActiveMemoryEntry;
}

export function supersedeMemoryEntry(
  entry: MemoryEntry,
  input: SupersedeMemoryEntryInput,
): SupersedeMemoryEntryResult {
  const predecessor = requireActive(entry);
  if (input.successorEntryId === predecessor.id) {
    reject("invalid-entry-id", "A memory correction requires a distinct successor entry ID");
  }
  const version = nextVersion(input.expectedVersion);
  const changedBy = requireUserActor(input.actor);
  const previousEntry: SupersededMemoryEntry = {
    ...predecessor,
    provenance: cloneProvenance(predecessor.provenance),
    author: cloneActor(predecessor.author),
    status: "superseded",
    supersededBy: input.successorEntryId,
    version,
    updatedAt: input.supersededAt,
  };
  const successor: ActiveMemoryEntry = {
    id: input.successorEntryId,
    projectId: predecessor.projectId,
    kind: predecessor.kind,
    content: normalizeContent(input.content),
    provenance:
      input.agentOrigin === undefined
        ? cloneProvenance(predecessor.provenance)
        : agentProvenance(input.agentOrigin),
    author: changedBy,
    status: "active",
    version,
    createdAt: input.supersededAt,
    updatedAt: input.supersededAt,
  };
  return { previousEntry, entry: successor };
}

export interface RetractMemoryEntryInput {
  readonly reason: string;
  readonly actor: ProjectActor;
  readonly retractedAt: UtcTimestamp;
  readonly expectedVersion: AggregateVersion;
  /** The thread whose agent retracted it; absent when the person did. */
  readonly agentOrigin?: AgentAuthoredMemoryProvenance;
}

export function retractMemoryEntry(
  entry: MemoryEntry,
  input: RetractMemoryEntryInput,
): RetractedMemoryEntry {
  const active = requireActive(entry);
  const retractedBy = requireUserActor(input.actor);
  return {
    ...active,
    provenance: cloneProvenance(active.provenance),
    author: cloneActor(active.author),
    status: "retracted",
    retractionReason: normalizeReason(input.reason),
    retractedBy,
    retractedAt: input.retractedAt,
    ...(input.agentOrigin === undefined
      ? {}
      : { retractionOrigin: agentProvenance(input.agentOrigin) }),
    version: nextVersion(input.expectedVersion),
    updatedAt: input.retractedAt,
  };
}

export interface TransferMemoryEntryInput {
  readonly destinationProjectId: ProjectId;
  readonly destinationEntryId: MemoryEntryId;
  readonly actor: ProjectActor;
  readonly transferredAt: UtcTimestamp;
  readonly expectedVersion: AggregateVersion;
}

export function transferMemoryEntry(
  sourceEntry: MemoryEntry,
  input: TransferMemoryEntryInput,
): TransferredActiveMemoryEntry {
  const source = requireActive(sourceEntry);
  if (input.destinationEntryId === source.id) {
    reject("invalid-entry-id", "A memory transfer requires a distinct destination entry ID");
  }
  const transferredBy = requireUserActor(input.actor);
  return {
    id: input.destinationEntryId,
    projectId: input.destinationProjectId,
    kind: source.kind,
    content: source.content,
    provenance: {
      kind: "transferred",
      sourceProjectId: source.projectId,
      sourceEntryId: source.id,
      destinationProjectId: input.destinationProjectId,
      transferredBy: cloneActor(transferredBy),
      transferredAt: input.transferredAt,
      selectedContent: source.content,
    },
    author: transferredBy,
    status: "active",
    version: nextVersion(input.expectedVersion),
    createdAt: input.transferredAt,
    updatedAt: input.transferredAt,
  };
}
