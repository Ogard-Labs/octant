import type { CanvasId } from "@octant/contracts/canvas";
import { canvasExportFolderRefusalText, judgeCanvasExportFolder } from "@octant/domain";
import type { CanvasExportHostPorts } from "@octant/plugin-api/canvas-export";
import type { PagePublisherOffer } from "@octant/plugin-api/page-publishing";
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
import { createPageExportTarget, pagePublisher } from "./pageExportTarget";

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
  /**
   * The host ports a destination built from a `CanvasExportTargetFactory`
   * receives. A destination that publishes through a provider asks
   * `ports.pagePublishing` which enabled instances can, names one on its
   * card, and publishes through the grant the export service hands it after
   * approval; it is built from these ports alone, as a plugin's contribution
   * would be, and the ports themselves can publish nothing.
   */
  readonly ports: CanvasExportHostPorts;
}

export function canvasExportTargetBindings(
  registration: CanvasExportTargetRegistration,
  canvasId: CanvasId,
): ReadonlyArray<CanvasExportTargetBinding> {
  const availability = () => folderAvailability(registration, registration.folderFor(canvasId));
  const bindings: CanvasExportTargetBinding[] = [
    {
      facts: activationFacts(availability()),
      target: createFolderExportTarget({
        availability,
        files: registration.files,
        newTempId: registration.newTempId,
      }),
    },
  ];
  const gist = registration.gist;
  if (gist !== undefined) {
    bindings.push({
      facts: gistActivationFacts(gist.availability()),
      target: createGistExportTarget(gist),
    });
  }
  // The page destination is listed only while some enabled provider can
  // publish pages, read per listing because which account is signed in can
  // change while the host runs; a host with none lists no such target.
  const publisher = pagePublisher(registration.ports);
  if (publisher !== undefined) {
    bindings.push({
      facts: pageActivationFacts(publisher.availability),
      target: createPageExportTarget(registration.ports),
    });
  }
  return bindings;
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

/**
 * The page destination's activation facts. A listed account with no sign-in
 * is `connected: false`, offered honestly as not-connected, and an account
 * that cannot publish pages is a standing refusal with the reason the driver
 * gave. A host whose port lists no publisher never reaches here: that target
 * is omitted, as a destination whose package is not installed is.
 */
export function pageActivationFacts(
  availability: PagePublisherOffer["availability"],
): CanvasExportActivationFacts {
  const facts: CanvasExportActivationFacts = {
    installed: true,
    trusted: true,
    desiredEnabled: true,
    effectiveState: { kind: "effective" },
    connected: availability.kind !== "not-signed-in",
  };
  return availability.kind === "refused"
    ? { ...facts, standingRefusal: availability.reason }
    : facts;
}
