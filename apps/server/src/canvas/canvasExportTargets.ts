import type { CanvasId } from "@octant/contracts/canvas";
import { canvasExportFolderRefusalText, judgeCanvasExportFolder } from "@octant/domain";
import {
  offerCanvasExportTargets,
  type CanvasExportActivationFacts,
} from "@octant/plugin-host/canvas-export-contributions";
import type { CanvasExportFilePort } from "./canvasExportFilePort";
import type { CanvasExportTargetBinding } from "./canvasExportService";
import { isInsideHomeDirectory } from "./artifactMirrorFilePort";
import { createFolderExportTarget, type FolderExportAvailability } from "./folderExportTarget";
import {
  createGistExportTarget,
  type GistExportAvailability,
  type GistExportTargetDependencies,
} from "./gistExportTarget";

/**
 * In-tree export destinations.
 *
 * Every destination here reaches the system through the same published port a
 * plugin's contribution does — it is offered through `offerCanvasExportTargets`
 * and called only after approval — so shipping one in-tree grants it nothing a
 * third party could not have. A second in-tree destination is a second entry in
 * this list and nothing else.
 */
export interface CanvasExportTargetRegistration {
  /** The folder this Canvas exports to, or nothing before one is chosen. */
  readonly folderFor: (canvasId: CanvasId) => string | undefined;
  readonly files: CanvasExportFilePort;
  readonly home: string;
  /**
   * Whether the host holds the standing grant for writing outside a home
   * folder. It has no surface yet, so this fails closed rather than assuming
   * yes — the rule the artifact mirror's global folder already follows.
   */
  readonly standingOutsideApproval: boolean;
  readonly newTempId: () => string;
  /**
   * The GitHub Gist destination, absent when this host has no GitHub export at
   * all. Its availability is read per Canvas, because whether GitHub is
   * connected can change while the host runs.
   */
  readonly gist?: GistExportTargetDependencies;
}

export function canvasExportTargetBindings(
  registration: CanvasExportTargetRegistration,
  canvasId: CanvasId,
): ReadonlyArray<CanvasExportTargetBinding> {
  const availability = () => folderAvailability(registration, registration.folderFor(canvasId));
  const folder: CanvasExportTargetBinding = {
    facts: activationFacts(availability()),
    target: createFolderExportTarget({
      availability,
      files: registration.files,
      newTempId: registration.newTempId,
    }),
  };
  const gist = registration.gist;
  if (gist === undefined) return [folder];
  return [
    folder,
    { facts: gistActivationFacts(gist.availability()), target: createGistExportTarget(gist) },
  ];
}

/** The offered list for one Canvas, through the same policy every destination passes. */
export function offeredCanvasExportTargets(
  registration: CanvasExportTargetRegistration,
  canvasId: CanvasId,
) {
  return offerCanvasExportTargets(
    canvasExportTargetBindings(registration, canvasId).map((binding) => ({
      contribution: binding.target.contribution,
      facts: binding.facts,
    })),
  );
}

/**
 * Whether the chosen folder can be written right now, and why not when it
 * cannot. A folder that has been removed or had its permissions taken away is
 * reported honestly rather than discovered during a write.
 */
export function folderAvailability(
  registration: CanvasExportTargetRegistration,
  folder: string | undefined,
): FolderExportAvailability {
  if (folder === undefined) return { kind: "not-chosen" };
  const verdict = judgeCanvasExportFolder({
    folder,
    writable: registration.files.isWritableFolder(folder),
    insideHome: isInsideHomeDirectory(folder, registration.home),
    standingOutsideApproval: registration.standingOutsideApproval,
  });
  return verdict.status === "accepted"
    ? { kind: "ready", folder: verdict.folder }
    : { kind: "refused", reason: canvasExportFolderRefusalText(verdict.reason) };
}

export function activationFacts(
  availability: FolderExportAvailability,
): CanvasExportActivationFacts {
  const facts: CanvasExportActivationFacts = {
    installed: true,
    trusted: true,
    desiredEnabled: true,
    effectiveState: { kind: "effective" },
    connected: availability.kind !== "not-chosen",
  };
  return availability.kind === "refused"
    ? { ...facts, standingRefusal: availability.reason }
    : facts;
}

/**
 * The gist destination's activation facts. A host with no GitHub connection is
 * `connected: false` — offered honestly as not-connected rather than hidden —
 * and an insecure credential store is a standing refusal, the same state the
 * other GitHub capabilities report.
 */
export function gistActivationFacts(
  availability: GistExportAvailability,
): CanvasExportActivationFacts {
  const facts: CanvasExportActivationFacts = {
    installed: true,
    trusted: true,
    desiredEnabled: true,
    effectiveState: { kind: "effective" },
    connected: availability.kind !== "not-connected",
  };
  return availability.kind === "refused"
    ? { ...facts, standingRefusal: availability.reason }
    : facts;
}
