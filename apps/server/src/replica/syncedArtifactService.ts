/**
 * What a person does with an artifact synced from another of their
 * computers: see which computer wrote each version, open it in a thread here,
 * resolve two versions into one, and undo a deletion.
 *
 * Opening binds it to a compatible thread (0040). The thread's mode, Project,
 * and authority decide; the artifact brings none of its origin's. Its content
 * enters the thread through thread external-content ingestion first, so the
 * thread is tainted before the Canvas can be read, and its sources keep the
 * origin's host identity, so a refresh here fails closed rather than resolving
 * another computer's references against this computer's files.
 *
 * Keep and Restore publish a version whose parents are every version it
 * resolves (0163: the person picks one, which is a new version). Merge makes
 * a new version from both through the Canvas revise path, so it needs a
 * thread. Nothing here overwrites a version or drops a tombstone.
 */

import type {
  ArtifactLibraryEntry,
  ArtifactSyncedCommand,
  ArtifactSyncedResult,
  ArtifactSyncedThread,
  ArtifactSyncedVersion,
} from "@octant/contracts/artifact-library";
import { MAX_ARTIFACT_SYNCED_THREADS } from "@octant/contracts/artifact-library";
import type { ArtifactBundle } from "@octant/contracts/artifact-bundle";
import type {
  CanvasBlock,
  CanvasDefinition,
  CanvasId,
  CanvasVersion,
  CanvasVersionId,
} from "@octant/contracts/canvas";
import type { HostId } from "@octant/contracts/host";
import type { UtcTimestamp } from "@octant/contracts";
import {
  decideReplicaArtifactBinding,
  mergeReplicaArtifactBlocks,
  replicaArtifactStanding,
  type ReplicaArtifactStanding,
  type ReplicaBindingRefusal,
  type ReplicaBindingThread,
} from "@octant/domain/replica-entry-policy";
import { renderArtifactThumbnail } from "../canvas/artifactRender";
import type { ReplicaArtifactState, ReplicaSyncedArtifact } from "./replicaArtifactProjection";
import {
  replicaArtifactsWithQueued,
  replicaDeletionShown,
  type ReplicaArtifactSyncService,
} from "./replicaArtifactSyncService";
import type { ReplicaMembershipState } from "./replicaMembershipProjection";

/** A thread here, with the facts that decide whether it can take an artifact. */
export interface SyncedArtifactThread {
  readonly threadId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly projectId: string | undefined;
  readonly projectName: string | undefined;
  readonly facts: ReplicaBindingThread;
}

/** A Canvas this host holds, as the sync view needs it. */
export interface SyncedArtifactLocalCanvas {
  readonly currentVersion: CanvasVersion;
  readonly versions: ReadonlyArray<CanvasVersion>;
  readonly projectName: string;
}

export type SyncedArtifactCommit =
  | { readonly kind: "committed"; readonly version: CanvasVersion }
  | { readonly kind: "denied"; readonly message: string };

export interface SyncedArtifactPorts {
  readonly artifacts: () => ReplicaArtifactState;
  readonly membership: () => ReplicaMembershipState;
  readonly sync: Pick<
    ReplicaArtifactSyncService,
    "resolveNext" | "publishVersion" | "publishes" | "drain"
  >;
  readonly localCanvas: (canvasId: CanvasId) => SyncedArtifactLocalCanvas | undefined;
  /** Every thread on this host, active or not; the policy decides which may take it. */
  readonly threads: () => ReadonlyArray<SyncedArtifactThread>;
  /**
   * Record content from another computer entering a thread, through thread
   * external-content ingestion. False when the host refused to record it.
   */
  readonly ingest: (input: {
    readonly threadId: string;
    readonly contentReference: string;
    readonly sourceLabel: string;
  }) => boolean;
  /**
   * Record a version as this Canvas's next one, or as its first one on
   * `threadId` when it is not open here yet. Goes through the Canvas
   * authority, which refuses what a revise would.
   */
  readonly adopt: (input: {
    readonly canvasId: CanvasId;
    readonly versionId: CanvasVersionId;
    readonly content: CanvasDefinition;
    readonly createdAt: UtcTimestamp;
    readonly threadId?: string;
  }) => SyncedArtifactCommit;
  /** Revise an open Canvas with the blocks given, through the Canvas revise path. */
  readonly revise: (input: {
    readonly canvasId: CanvasId;
    readonly blocks: ReadonlyArray<CanvasBlock>;
    readonly prompt: string;
  }) => SyncedArtifactCommit;
  /** The artifact as the library lists it on this host. */
  readonly entry: (canvasId: CanvasId) => ArtifactLibraryEntry | undefined;
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
}

type Refused = Extract<ArtifactSyncedResult, { kind: "artifact-synced-refused" }>;

function refused(reason: Refused["reason"], message: string): Refused {
  return { kind: "artifact-synced-refused", reason, message };
}

const BINDING_REFUSAL: Record<ReplicaBindingRefusal, string> = {
  "mode-mismatch": "That thread is in a different mode from this artifact.",
  "thread-inactive": "That thread is not active.",
  "project-unavailable": "That thread's Project is not available.",
  "read-only": "That thread is in Plan mode, so nothing in it can change.",
  "workspace-unavailable": "That thread's folder or checkout is not available right now.",
};

const NO_COMPATIBLE_THREAD =
  "No thread on this computer can take it. Start a thread in the same mode, or keep it in the library.";

function same(left: unknown, right: unknown): boolean {
  return String(left) === String(right);
}

/** What the person is shown and chooses between for one artifact. */
interface Standing {
  readonly artifact: ReplicaSyncedArtifact;
  readonly local: SyncedArtifactLocalCanvas | undefined;
  readonly standing: ReplicaArtifactStanding;
}

/** A version that stands, with its content and who wrote it. */
interface Candidate {
  readonly versionId: string;
  readonly definition: CanvasDefinition;
  readonly computerName: string;
  /** Written here: the version standing in the thread it is open in. */
  readonly thisComputer: boolean;
}

export class SyncedArtifactService {
  readonly #ports: SyncedArtifactPorts;

  constructor(ports: SyncedArtifactPorts) {
    this.#ports = ports;
  }

  async execute(command: ArtifactSyncedCommand): Promise<ArtifactSyncedResult> {
    switch (command.kind) {
      case "detail":
        return this.#detail(command.canvasId);
      case "open":
        return this.#open(command.canvasId, command.threadId);
      case "keep":
        return this.#keep(command.canvasId, command.versionId);
      case "merge":
        return this.#merge(command.canvasId, command.threadId);
      case "restore":
        return this.#restore(command.canvasId);
      default: {
        const unexpected: never = command;
        throw new Error(`Unexpected synced artifact command: ${JSON.stringify(unexpected)}`);
      }
    }
  }

  /**
   * Append to each artifact open here the one version another computer wrote
   * on top of the version standing here (0040: a later import of the same
   * origin appends a version). It enters the thread as external content
   * first, keeps its id so it is not published again, and is refused like
   * any version if the thread can no longer take it. Two versions are never
   * resolved here; the person chooses.
   */
  catchUp(): number {
    let appended = 0;
    const local = this.#ports.membership().local;
    for (const artifact of replicaArtifactsWithQueued(this.#ports.artifacts(), local)) {
      const state = this.#standing(artifact.canvasId);
      if (state?.local === undefined || state.standing.ahead === undefined) continue;
      const ahead = state.standing.ahead;
      const synced = state.artifact.versions.find((version) => same(version.versionId, ahead));
      if (synced === undefined) continue;
      const threadId = String(state.local.currentVersion.definition.provenance.threadId);
      const candidate: Candidate = {
        versionId: ahead,
        definition: synced.bundle.definition,
        computerName: synced.writtenBy.displayName,
        thisComputer: synced.local,
      };
      if (!this.#ingested(state.artifact, threadId, candidate)) continue;
      const committed = this.#ports.adopt({
        canvasId: artifact.canvasId,
        versionId: ahead as CanvasVersionId,
        content: this.#withOriginSources(state.artifact, synced.bundle.definition),
        createdAt: synced.bundle.octant.createdAt,
      });
      if (committed.kind === "committed") appended += 1;
    }
    return appended;
  }

  /** The name this computer goes by in its replica, or plainly "This computer". */
  #localName(): string {
    return this.#ports.membership().local?.displayName ?? "This computer";
  }

  #standing(canvasId: CanvasId): Standing | undefined {
    const local = this.#ports.membership().local;
    const artifact = replicaArtifactsWithQueued(
      this.#ports.artifacts(),
      local === undefined ? undefined : local,
    ).find((candidate) => same(candidate.canvasId, canvasId));
    if (artifact === undefined) return undefined;
    const canvas = this.#ports.localCanvas(canvasId);
    return {
      artifact,
      local: canvas,
      standing: replicaArtifactStanding(
        artifact,
        canvas === undefined
          ? undefined
          : {
              currentVersionId: String(canvas.currentVersion.versionId),
              versionIds: canvas.versions.map((version) => String(version.versionId)),
            },
      ),
    };
  }

  #candidates(state: Standing): ReadonlyArray<Candidate> {
    return state.standing.candidates.flatMap((versionId): Candidate[] => {
      const current = state.local?.currentVersion;
      if (current !== undefined && same(current.versionId, versionId)) {
        const synced = state.artifact.versions.find((version) =>
          same(version.versionId, versionId),
        );
        return [
          {
            versionId,
            definition: current.definition,
            computerName:
              synced === undefined || synced.local
                ? this.#localName()
                : synced.writtenBy.displayName,
            thisComputer: synced === undefined || synced.local,
          },
        ];
      }
      const synced = state.artifact.versions.find((version) => same(version.versionId, versionId));
      return synced === undefined
        ? []
        : [
            {
              versionId,
              definition: synced.bundle.definition,
              computerName: synced.writtenBy.displayName,
              thisComputer: synced.local,
            },
          ];
    });
  }

  /** Threads here this artifact may be opened in, most recently active first. */
  #compatibleThreads(mode: ReplicaBindingThread["mode"]): ReadonlyArray<SyncedArtifactThread> {
    return this.#ports
      .threads()
      .filter(
        (thread) =>
          thread.projectId !== undefined &&
          thread.projectName !== undefined &&
          decideReplicaArtifactBinding(mode, thread.facts).kind === "compatible",
      )
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /** The thread named, if it may take this artifact; otherwise why not. */
  #bindingThread(
    mode: ReplicaBindingThread["mode"],
    threadId: string | undefined,
  ): SyncedArtifactThread | Refused {
    const compatible = this.#compatibleThreads(mode);
    if (compatible.length === 0) return refused("no-compatible-thread", NO_COMPATIBLE_THREAD);
    if (threadId === undefined) {
      return refused("thread-required", "Choose the thread to open it in.");
    }
    const thread = this.#ports.threads().find((candidate) => same(candidate.threadId, threadId));
    if (thread === undefined) {
      return refused("incompatible-thread", "That thread is not on this computer.");
    }
    const decision = decideReplicaArtifactBinding(mode, thread.facts);
    if (decision.kind === "incompatible") {
      return refused("incompatible-thread", BINDING_REFUSAL[decision.reason]);
    }
    return thread;
  }

  #detail(canvasId: CanvasId): ArtifactSyncedResult {
    const state = this.#standing(canvasId);
    if (state === undefined) {
      return refused("not-found", "Nothing synced is known for this artifact here.");
    }
    const candidates = this.#candidates(state);
    const deletion =
      state.standing.status === "deleted"
        ? replicaDeletionShown(state.artifact, state.standing.deletions)
        : undefined;
    const shown =
      state.local?.currentVersion.definition ??
      candidates[0]?.definition ??
      deletion?.bundle.definition;
    if (shown === undefined) {
      return refused("not-found", "Nothing synced is known for this artifact here.");
    }
    const versions: ArtifactSyncedVersion[] = [];
    const seen = new Set<string>();
    const add = (version: Omit<ArtifactSyncedVersion, "candidate" | "preview">) => {
      if (seen.has(String(version.versionId))) return;
      seen.add(String(version.versionId));
      const candidate = candidates.find((item) => same(item.versionId, version.versionId));
      const markup = candidate === undefined ? "" : renderArtifactThumbnail(candidate.definition);
      versions.push({
        ...version,
        candidate: candidate !== undefined,
        ...(markup === "" ? {} : { preview: { format: "svg" as const, markup } }),
      });
    };
    for (const version of state.local?.versions ?? []) {
      const synced = state.artifact.versions.find((held) =>
        same(held.versionId, version.versionId),
      );
      add({
        versionId: version.versionId,
        title: version.definition.title,
        computerName:
          synced === undefined || synced.local ? this.#localName() : synced.writtenBy.displayName,
        thisComputer: synced === undefined || synced.local,
        createdAt: version.createdAt,
      });
    }
    for (const version of state.artifact.versions) {
      add({
        versionId: version.versionId,
        title: version.bundle.definition.title,
        computerName: version.local ? this.#localName() : version.writtenBy.displayName,
        thisComputer: version.local,
        createdAt: version.bundle.octant.createdAt,
      });
    }
    const mode = shown.provenance.mode;
    const threads: ArtifactSyncedThread[] =
      state.local === undefined
        ? this.#compatibleThreads(mode)
            .slice(0, MAX_ARTIFACT_SYNCED_THREADS)
            .map((thread) => ({
              threadId: thread.threadId,
              mode: thread.facts.mode,
              projectId: thread.projectId as ArtifactSyncedThread["projectId"],
              projectName: thread.projectName ?? "Project",
              title: thread.title,
            }))
        : [];
    return {
      kind: "artifact-synced-detail",
      canvasId,
      title: shown.title,
      projectName: state.local?.projectName ?? state.artifact.projectName,
      mode,
      status: state.standing.status,
      ...(deletion === undefined ? {} : { deletedOn: deletion.writtenBy.displayName }),
      openHere: state.local !== undefined,
      versions: versions
        .toSorted((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
        .slice(0, 200),
      threads,
    };
  }

  /**
   * Bind a version another computer wrote to a thread here: record it as
   * external content on that thread, then as the Canvas's first version
   * there, under the id it has everywhere so it is never published again.
   */
  #bind(
    state: Standing,
    candidate: Candidate,
    thread: SyncedArtifactThread,
  ): SyncedArtifactCommit | Refused {
    if (!this.#ingested(state.artifact, thread.threadId, candidate)) {
      return refused("refused", "This computer could not record where the artifact came from.");
    }
    const synced = state.artifact.versions.find((version) =>
      same(version.versionId, candidate.versionId),
    );
    return this.#ports.adopt({
      canvasId: state.artifact.canvasId,
      versionId: candidate.versionId as CanvasVersionId,
      content: this.#withOriginSources(state.artifact, candidate.definition),
      createdAt: synced?.bundle.octant.createdAt ?? this.#ports.clock(),
      threadId: thread.threadId,
    });
  }

  /**
   * A source names a file, thread, or artifact on the computer that wrote it.
   * Its host identity stays that computer's, so a refresh or an Open here is
   * refused rather than resolving the reference against this computer.
   */
  #withOriginSources(artifact: ReplicaSyncedArtifact, definition: CanvasDefinition) {
    return {
      ...definition,
      sourceManifest: definition.sourceManifest.map((source) => ({
        ...source,
        hostId: artifact.originHostId as HostId,
      })),
    };
  }

  #ingested(artifact: ReplicaSyncedArtifact, threadId: string, candidate: Candidate): boolean {
    if (candidate.thisComputer) return true;
    // Opaque and path-free: the label names the computer, the reference names
    // the version, and neither carries the content.
    const label = `Synced from ${candidate.computerName}`
      .replaceAll("/", " ")
      .replaceAll("\\", " ")
      .replaceAll("\u0000", " ")
      .slice(0, 128);
    return this.#ports.ingest({
      threadId,
      contentReference: `replica-artifact:${String(artifact.canvasId)}:${candidate.versionId}`,
      sourceLabel: label,
    });
  }

  async #opened(canvasId: CanvasId, omitted = 0): Promise<ArtifactSyncedResult> {
    await this.#ports.sync.drain().catch(() => undefined);
    const entry = this.#ports.entry(canvasId);
    if (entry === undefined) {
      return refused("refused", "It was opened here, but the library cannot show it yet.");
    }
    return {
      kind: "artifact-synced-opened",
      entry,
      ...(omitted > 0 ? { omittedBlocks: omitted } : {}),
    };
  }

  async #open(canvasId: CanvasId, threadId: string): Promise<ArtifactSyncedResult> {
    const state = this.#standing(canvasId);
    if (state === undefined) {
      return refused("not-found", "Nothing synced is known for this artifact here.");
    }
    if (state.local !== undefined) {
      return refused("already-open-here", "It is already open in a thread on this computer.");
    }
    if (state.standing.status === "deleted") {
      return refused("refused", "It was deleted on another computer. Restore it to open it.");
    }
    const candidate = this.#newest(state);
    if (candidate === undefined) {
      return refused("not-found", "Nothing synced is known for this artifact here.");
    }
    const thread = this.#bindingThread(candidate.definition.provenance.mode, threadId);
    if ("kind" in thread) return thread;
    const bound = this.#bind(state, candidate, thread);
    if (bound.kind === "artifact-synced-refused") return bound;
    if (bound.kind === "denied") return refused("refused", bound.message);
    return this.#opened(canvasId);
  }

  #newest(state: Standing): Candidate | undefined {
    const candidates = this.#candidates(state);
    const createdAt = (candidate: Candidate) =>
      String(
        state.artifact.versions.find((version) => same(version.versionId, candidate.versionId))
          ?.bundle.octant.createdAt ?? "",
      );
    return candidates.toSorted((left, right) => createdAt(right).localeCompare(createdAt(left)))[0];
  }

  async #keep(canvasId: CanvasId, versionId: CanvasVersionId): Promise<ArtifactSyncedResult> {
    const state = this.#standing(canvasId);
    if (state === undefined) {
      return refused("not-found", "Nothing synced is known for this artifact here.");
    }
    if (state.standing.status !== "two-versions") {
      return refused("not-two-versions", "There is only one version standing.");
    }
    const chosen = this.#candidates(state).find((candidate) =>
      same(candidate.versionId, versionId),
    );
    if (chosen === undefined) {
      return refused("unknown-version", "That is not one of the two versions.");
    }
    return this.#resolve(state, chosen, state.standing.candidates);
  }

  async #restore(canvasId: CanvasId): Promise<ArtifactSyncedResult> {
    const state = this.#standing(canvasId);
    if (state === undefined) {
      return refused("not-found", "Nothing synced is known for this artifact here.");
    }
    if (state.standing.status !== "deleted") {
      return refused("not-deleted", "It has not been deleted.");
    }
    const parents = state.standing.deletions.flatMap((deletion) =>
      deletion.parentVersionIds.map(String),
    );
    const current = state.local?.currentVersion;
    if (current !== undefined) {
      return this.#resolve(
        state,
        {
          versionId: String(current.versionId),
          definition: current.definition,
          computerName: this.#localName(),
          thisComputer: true,
        },
        [...parents, String(current.versionId)],
      );
    }
    const deletion = replicaDeletionShown(state.artifact, state.standing.deletions);
    if (deletion === undefined) {
      return refused("not-found", "Nothing synced is known for this artifact here.");
    }
    return this.#resolve(
      state,
      {
        versionId: String(deletion.bundle.octant.versionId),
        definition: deletion.bundle.definition,
        computerName: deletion.writtenBy.displayName,
        thisComputer: false,
      },
      parents,
    );
  }

  /**
   * Publish `chosen`'s content as a new version whose parents are `parents`.
   * Open here, it is the thread's next version, committed through the Canvas
   * authority; not open here, it goes straight to the store.
   */
  async #resolve(
    state: Standing,
    chosen: Candidate,
    parents: ReadonlyArray<string>,
  ): Promise<ArtifactSyncedResult> {
    const canvasId = state.artifact.canvasId;
    const versionId = this.#ports.uuid() as CanvasVersionId;
    const now = this.#ports.clock();
    if (state.local !== undefined) {
      const threadId = String(state.local.currentVersion.definition.provenance.threadId);
      if (!this.#ingested(state.artifact, threadId, chosen)) {
        return refused("refused", "This computer could not record where the version came from.");
      }
      const release = this.#ports.sync.resolveNext(canvasId, parents);
      let committed: SyncedArtifactCommit;
      try {
        committed = this.#ports.adopt({
          canvasId,
          versionId,
          content: chosen.thisComputer
            ? chosen.definition
            : this.#withOriginSources(state.artifact, chosen.definition),
          createdAt: now,
        });
      } finally {
        release();
      }
      if (committed.kind === "denied") return refused("refused", committed.message);
      return this.#published(canvasId, committed.version.versionId);
    }
    if (!this.#ports.sync.publishes()) {
      return refused("sync-off", "Turn sync on to send this choice to your other computers.");
    }
    const sequence = Math.max(
      0,
      ...state.artifact.versions.map((version) => version.bundle.octant.sequence),
    );
    const source = state.artifact.versions.find((version) =>
      same(version.versionId, chosen.versionId),
    )?.bundle;
    const header =
      source?.octant ??
      replicaDeletionShown(state.artifact, state.standing.deletions)?.bundle.octant;
    if (header === undefined) {
      return refused("not-found", "Nothing synced is known for this artifact here.");
    }
    const bundle: ArtifactBundle = {
      octant: { ...header, versionId, sequence: sequence + 1, createdAt: now },
      definition: chosen.definition,
    };
    const outcome = await this.#ports.sync.publishVersion({ canvasId, bundle, parents });
    if (outcome.status === "refused") {
      return outcome.reason === "sync-off"
        ? refused("sync-off", "Turn sync on to send this choice to your other computers.")
        : refused("refused", "This version cannot leave this computer.");
    }
    return {
      kind: "artifact-synced-published",
      canvasId,
      versionId,
      published: outcome.published,
    };
  }

  async #published(canvasId: CanvasId, versionId: CanvasVersionId): Promise<ArtifactSyncedResult> {
    await this.#ports.sync.drain().catch(() => undefined);
    const waiting = this.#ports
      .artifacts()
      .outbox.some((entry) => same(entry.bundle.octant.versionId, versionId));
    return {
      kind: "artifact-synced-published",
      canvasId,
      versionId,
      published: this.#ports.sync.publishes() && !waiting,
    };
  }

  async #merge(canvasId: CanvasId, threadId: string | undefined): Promise<ArtifactSyncedResult> {
    let state = this.#standing(canvasId);
    if (state === undefined) {
      return refused("not-found", "Nothing synced is known for this artifact here.");
    }
    if (state.standing.status !== "two-versions") {
      return refused("not-two-versions", "There is only one version standing.");
    }
    const parents = state.standing.candidates;
    const candidates = this.#candidates(state);
    if (state.local === undefined) {
      const base = this.#newest(state);
      if (base === undefined) {
        return refused("not-found", "Nothing synced is known for this artifact here.");
      }
      const thread = this.#bindingThread(base.definition.provenance.mode, threadId);
      if ("kind" in thread) return thread;
      const bound = this.#bind(state, base, thread);
      if (bound.kind === "artifact-synced-refused") return bound;
      if (bound.kind === "denied") return refused("refused", bound.message);
      state = this.#standing(canvasId);
      if (state?.local === undefined) {
        return refused("refused", "It was opened here, but could not be merged.");
      }
    }
    const local = state.local;
    const threadOfLocal = String(local.currentVersion.definition.provenance.threadId);
    // The version standing here goes first when it is one of them, so its
    // blocks keep their ids and the others' join after it.
    const ordered = candidates.toSorted(
      (left, right) =>
        Number(same(right.versionId, local.currentVersion.versionId)) -
        Number(same(left.versionId, local.currentVersion.versionId)),
    );
    let merged: { blocks: ReadonlyArray<CanvasBlock>; omitted: number } = {
      blocks: [],
      omitted: 0,
    };
    for (const candidate of ordered) {
      // The version standing here is already in the thread.
      const inThread = same(candidate.versionId, local.currentVersion.versionId);
      if (!inThread && !this.#ingested(state.artifact, threadOfLocal, candidate)) {
        return refused("refused", "This computer could not record where a version came from.");
      }
      const next = mergeReplicaArtifactBlocks(
        { blocks: merged.blocks, sourceManifest: local.currentVersion.definition.sourceManifest },
        candidate.definition,
      );
      merged = { blocks: next.blocks, omitted: merged.omitted + next.omitted };
    }
    const names = [...new Set(candidates.map((candidate) => candidate.computerName))];
    const release = this.#ports.sync.resolveNext(canvasId, parents);
    let revised: SyncedArtifactCommit;
    try {
      revised = this.#ports.revise({
        canvasId,
        blocks: merged.blocks,
        prompt: `Merged the versions from ${names.join(" and ")}.`,
      });
    } finally {
      release();
    }
    if (revised.kind === "denied") return refused("refused", revised.message);
    return this.#opened(canvasId, merged.omitted);
  }
}

/**
 * What the library says about a Canvas held here: the computer that wrote
 * the version shown, and anything sync has left to resolve. Nothing when this
 * computer is in no replica and the version was written here.
 */
export function localArtifactSyncFacts(
  state: ReplicaArtifactState,
  membership: ReplicaMembershipState,
  canvas: Pick<SyncedArtifactLocalCanvas, "currentVersion" | "versions">,
): Pick<ArtifactLibraryEntry, "writtenOn" | "syncStatus" | "deletedOn"> {
  const local = membership.local;
  const artifact = replicaArtifactsWithQueued(state, local).find((candidate) =>
    same(candidate.canvasId, canvas.currentVersion.canvasId),
  );
  const current = canvas.currentVersion.versionId;
  const synced = artifact?.versions.find((version) => same(version.versionId, current));
  const writtenOn =
    synced !== undefined && !synced.local ? synced.writtenBy.displayName : local?.displayName;
  if (artifact === undefined) return writtenOn === undefined ? {} : { writtenOn };
  const standing = replicaArtifactStanding(artifact, {
    currentVersionId: String(current),
    versionIds: canvas.versions.map((version) => String(version.versionId)),
  });
  const deletion =
    standing.status === "deleted" ? replicaDeletionShown(artifact, standing.deletions) : undefined;
  return {
    ...(writtenOn === undefined ? {} : { writtenOn }),
    ...(standing.status === "current" ? {} : { syncStatus: standing.status }),
    ...(deletion === undefined ? {} : { deletedOn: deletion.writtenBy.displayName }),
  };
}
