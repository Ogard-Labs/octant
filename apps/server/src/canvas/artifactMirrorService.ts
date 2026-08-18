import {
  ARTIFACT_MIRROR_AGGREGATE_TYPE,
  ARTIFACT_MIRROR_EVENT_NAMES,
  decodeArtifactMirrorCommand,
  decodeArtifactMirrorReceipt,
  decodeArtifactMirrorResult,
  decodeArtifactMirrorSettings,
  type ArtifactMirrorDestination,
  type ArtifactMirrorReceipt,
  type ArtifactMirrorResult,
  type ArtifactMirrorSettings,
} from "@octant/contracts/artifact-mirror";
import type { CanvasId, CanvasVersion, ProjectId, UtcTimestamp } from "@octant/contracts";
import {
  artifactBundlePaths,
  decideArtifactReimport,
  decideMirrorWrite,
  mirrorRefusalText,
  reimportRefusalText,
  resolveArtifactDestination,
} from "@octant/domain";
import { buildArtifactBundle, readArtifactBundle } from "./artifactBundle";

/**
 * Writing artifacts out, and taking an edited one back in.
 *
 * The journal is what an artifact is; this service keeps a copy of it on disk
 * for the tools that cannot read a journal. Everything it writes is derived,
 * and the single path back — re-import — appends a version rather than
 * replacing one, which is why nothing here can express "overwrite".
 */

export interface ArtifactMirrorFilePort {
  /** Write one file, creating parent directories. Absolute path. */
  readonly write: (absolutePath: string, contents: string) => Promise<void>;
  readonly read: (absolutePath: string) => Promise<string | undefined>;
  /** Remove a file the mirror previously wrote and no longer produces. */
  readonly remove: (absolutePath: string) => Promise<void>;
  /** Canonicalize a root, or report that it cannot be reached. */
  readonly resolveRoot: (absolutePath: string) => Promise<string | undefined>;
}

export interface ArtifactMirrorProjectPort {
  readonly read: (
    projectId: string,
  ) => { readonly name: string; readonly checkoutRoot?: string } | undefined;
}

export interface ArtifactMirrorServiceDependencies {
  readonly files: ArtifactMirrorFilePort;
  /** The artifact as the journal has it right now, for the staleness check. */
  readonly currentVersion: (canvasId: CanvasId) => CanvasVersion | undefined;
  readonly projects: ArtifactMirrorProjectPort;
  /** Whether reaching outside a bound root is approved right now. */
  readonly outsideRootApproved: (destination: ArtifactMirrorDestination) => boolean;
  /** Whether the thread that owns this artifact is read-only. */
  readonly planMode: (version: CanvasVersion) => boolean;
  /** Appends a version, through the same path any other revision takes. */
  readonly appendVersionFromBundle: (input: {
    readonly canvasId: CanvasId;
    readonly definition: unknown;
  }) =>
    | { readonly kind: "accepted"; readonly versionId: string }
    | { readonly kind: "denied"; readonly message: string };
  readonly journal: {
    readonly append: (input: {
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly eventName: string;
      readonly payload: unknown;
    }) => void;
  };
  readonly clock: () => UtcTimestamp;
}

const INITIAL_SETTINGS = {
  kind: "artifact-mirror-settings" as const,
  fallback: { kind: "internal-only" as const },
  overrides: [],
  autoCommit: false,
  version: 0,
};

export class ArtifactMirrorService {
  readonly #dependencies: ArtifactMirrorServiceDependencies;
  #settings: ArtifactMirrorSettings;
  /**
   * What was last written for each artifact: the root it went under and the
   * paths relative to it. Both halves are kept because the receipt names
   * relative paths while cleanup and re-import have to open real ones.
   */
  readonly #lastWrite = new Map<
    string,
    { readonly root: string; readonly paths: ReadonlyArray<string> }
  >();

  constructor(dependencies: ArtifactMirrorServiceDependencies) {
    this.#dependencies = dependencies;
    this.#settings = decodeArtifactMirrorSettings({
      ...INITIAL_SETTINGS,
      updatedAt: dependencies.clock(),
    });
  }

  settings(): ArtifactMirrorSettings {
    return this.#settings;
  }

  async execute(commandInput: unknown): Promise<ArtifactMirrorResult> {
    const command = decodeArtifactMirrorCommand(commandInput);
    if (command.kind === "reimport-artifact-from-file") return this.#reimport(command);

    if (command.expectedVersion !== this.#settings.version) {
      return this.#refused("stale-version", "The mirror settings changed since you read them.");
    }
    const next = decodeArtifactMirrorSettings({
      kind: "artifact-mirror-settings",
      fallback:
        command.kind === "set-artifact-mirror-fallback"
          ? command.destination
          : this.#settings.fallback,
      overrides: this.#nextOverrides(command),
      autoCommit:
        command.kind === "set-artifact-mirror-auto-commit"
          ? command.autoCommit
          : this.#settings.autoCommit,
      version: this.#settings.version + 1,
      updatedAt: this.#dependencies.clock(),
    });
    this.#dependencies.journal.append({
      aggregateType: ARTIFACT_MIRROR_AGGREGATE_TYPE,
      aggregateId: ARTIFACT_MIRROR_AGGREGATE_TYPE,
      eventName: ARTIFACT_MIRROR_EVENT_NAMES.settingChanged,
      payload: { settings: next },
    });
    this.#settings = next;
    return decodeArtifactMirrorResult({ kind: "mirror-settings", settings: next });
  }

  /**
   * Materialize one committed revision.
   *
   * Never throws to its caller: a revision already happened, and a file that
   * could not be written is reported as a receipt rather than by unwinding a
   * version. Every outcome — including doing nothing — is journaled, so "why is
   * there no file" is answerable.
   */
  async materialize(version: CanvasVersion): Promise<ArtifactMirrorReceipt> {
    const provenance = version.definition.provenance;
    const projectId = String(provenance.projectId);
    const destination = resolveArtifactDestination(this.#settings, projectId);
    const project = this.#dependencies.projects.read(projectId);

    const root = await this.#resolveDestinationRoot(destination, project?.checkoutRoot);
    const decision = decideMirrorWrite({
      destination,
      destinationRootResolved: root !== undefined,
      projectBindsRepository: project?.checkoutRoot !== undefined,
      outsideRootApproved: this.#dependencies.outsideRootApproved(destination),
      planMode: this.#dependencies.planMode(version),
    });
    if (decision.decision !== "write") {
      return this.#receipt(
        version,
        destination,
        [],
        decision.decision === "skip" ? "skipped" : "refused",
        decision.decision === "skip"
          ? "Mirroring is off for this Project."
          : mirrorRefusalText(decision.reason),
      );
    }

    const paths = artifactBundlePaths(
      {
        canvasId: String(version.canvasId),
        title: version.definition.title,
        mode: provenance.mode,
        projectName: project?.name ?? "project",
      },
      destination,
    );
    if (paths === undefined || root === undefined) {
      return this.#receipt(
        version,
        destination,
        [],
        "refused",
        mirrorRefusalText("destination-unavailable"),
      );
    }

    const files = buildArtifactBundle(version);
    const written: string[] = [];
    try {
      await this.#dependencies.files.write(`${root}/${paths.bundle}`, files.bundle);
      written.push(paths.bundle);
      for (const sidecar of paths.sidecars) {
        await this.#dependencies.files.write(
          `${root}/${sidecar.path}`,
          sidecar.format === "md" ? files.markdown : files.svg,
        );
        written.push(sidecar.path);
      }
    } catch {
      return this.#receipt(
        version,
        destination,
        [],
        "failed",
        "The mirrored files could not be written.",
      );
    }

    // A renamed artifact writes under a new name; the old one is removed rather
    // than left behind as a second, stale copy of the same document.
    const previous = this.#lastWrite.get(String(version.canvasId));
    for (const stale of previous?.paths ?? []) {
      if (previous?.root === root && written.includes(stale)) continue;
      await this.#dependencies.files
        .remove(`${previous?.root ?? root}/${stale}`)
        .catch(() => undefined);
    }
    this.#lastWrite.set(String(version.canvasId), { root, paths: written });

    return this.#receipt(version, destination, written, "written");
  }

  async #reimport(command: {
    readonly canvasId: CanvasId;
    readonly expectedVersionId: string;
  }): Promise<ArtifactMirrorResult> {
    const current = this.#dependencies.currentVersion(command.canvasId);
    if (current === undefined) {
      return this.#refused("file-missing", reimportRefusalText("file-missing"));
    }
    const known = this.#lastWrite.get(String(command.canvasId));
    const relativeBundle = known?.paths[0];
    if (known === undefined || relativeBundle === undefined) {
      return this.#refused("file-missing", reimportRefusalText("file-missing"));
    }
    const bundlePath = `${known.root}/${relativeBundle}`;
    const text = await this.#dependencies.files.read(bundlePath).catch(() => undefined);
    const parsed = text === undefined ? undefined : readArtifactBundle(text);
    const decision = decideArtifactReimport({
      canvasId: String(command.canvasId),
      // The journal's answer, not the caller's, is what makes this a real
      // staleness check rather than a comparison of a value with itself.
      currentVersionId: String(current.versionId),
      expectedVersionId: String(command.expectedVersionId),
      file:
        text === undefined
          ? { status: "missing" }
          : parsed === undefined
            ? { status: "read", bundleForCanvasId: undefined, changed: false }
            : {
                status: "read",
                bundleForCanvasId: parsed.header.canvasId,
                // What the file says now against what the artifact says now.
                // Comparing version ids would call an edited file unchanged
                // whenever the editor left the header alone, which is exactly
                // what a person editing the blocks does.
                changed: JSON.stringify(parsed.definition) !== JSON.stringify(current.definition),
              },
    });
    if (decision.decision === "refuse") {
      return this.#refused(decision.reason, reimportRefusalText(decision.reason));
    }
    const appended = this.#dependencies.appendVersionFromBundle({
      canvasId: command.canvasId,
      definition: parsed?.definition,
    });
    if (appended.kind === "denied") {
      return this.#refused("file-not-a-bundle", appended.message);
    }
    this.#dependencies.journal.append({
      aggregateType: ARTIFACT_MIRROR_AGGREGATE_TYPE,
      aggregateId: String(command.canvasId),
      eventName: ARTIFACT_MIRROR_EVENT_NAMES.reimported,
      payload: { canvasId: command.canvasId, versionId: appended.versionId, path: bundlePath },
    });
    return decodeArtifactMirrorResult({
      kind: "artifact-reimported",
      canvasId: command.canvasId,
      versionId: appended.versionId,
    });
  }

  async #resolveDestinationRoot(
    destination: ArtifactMirrorDestination,
    checkoutRoot: string | undefined,
  ): Promise<string | undefined> {
    if (destination.kind === "internal-only") return undefined;
    if (destination.kind === "global-folder") {
      return this.#dependencies.files.resolveRoot(destination.canonicalRoot);
    }
    return checkoutRoot === undefined
      ? undefined
      : this.#dependencies.files.resolveRoot(checkoutRoot);
  }

  #nextOverrides(command: {
    readonly kind: string;
    readonly projectId?: ProjectId;
    readonly destination?: ArtifactMirrorDestination;
  }): ArtifactMirrorSettings["overrides"] {
    const others = this.#settings.overrides.filter(
      (override) => String(override.projectId) !== String(command.projectId ?? ""),
    );
    if (
      command.kind === "set-artifact-mirror-override" &&
      command.projectId !== undefined &&
      command.destination !== undefined
    ) {
      return [...others, { projectId: command.projectId, destination: command.destination }];
    }
    if (command.kind === "clear-artifact-mirror-override") return others;
    return this.#settings.overrides;
  }

  #receipt(
    version: CanvasVersion,
    destination: ArtifactMirrorDestination,
    paths: ReadonlyArray<string>,
    outcome: ArtifactMirrorReceipt["outcome"],
    detail?: string,
  ): ArtifactMirrorReceipt {
    const receipt = decodeArtifactMirrorReceipt({
      canvasId: version.canvasId,
      versionId: version.versionId,
      projectId: version.definition.provenance.projectId,
      destination,
      paths,
      outcome,
      ...(detail === undefined ? {} : { detail }),
      observedAt: this.#dependencies.clock(),
    });
    this.#dependencies.journal.append({
      aggregateType: ARTIFACT_MIRROR_AGGREGATE_TYPE,
      aggregateId: String(version.canvasId),
      eventName: ARTIFACT_MIRROR_EVENT_NAMES.written,
      payload: { receipt },
    });
    return receipt;
  }

  #refused(
    reason: Extract<ArtifactMirrorResult, { readonly kind: "mirror-refused" }>["reason"],
    message: string,
  ): ArtifactMirrorResult {
    return decodeArtifactMirrorResult({ kind: "mirror-refused", reason, message });
  }
}
