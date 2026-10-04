/**
 * The artifact bundle a mirror writes.
 *
 * This is the 0029 document: identity in `octant`, the definition beside it,
 * fixed header key order, two-space indentation, and a trailing newline. A
 * replica entry carries this document as its payload. It is not a second
 * bundle, and nothing here writes a file.
 */

import { Schema } from "effect";
import { CanvasDefinition, CanvasId, CanvasVersionId } from "./canvas";
import { UtcTimestamp } from "./events";
import { HostId } from "./host";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const PositiveInt = Schema.Int.pipe(Schema.positive());

export const ARTIFACT_BUNDLE_FORMAT = "octant.artifact-bundle/1" as const;

/**
 * Header key order matches the mirror writer. A revision that changes one
 * sentence should change one line, so this order is part of the document.
 */
export const ArtifactBundleHeader = Schema.Struct({
  format: Schema.Literal(ARTIFACT_BUNDLE_FORMAT),
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  sequence: PositiveInt,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  mode: OctantMode,
  projectId: ProjectId,
  hostId: HostId,
  createdAt: UtcTimestamp,
}).annotations(strict);
export type ArtifactBundleHeader = typeof ArtifactBundleHeader.Type;

export const ArtifactBundle = Schema.Struct({
  octant: ArtifactBundleHeader,
  definition: CanvasDefinition,
}).annotations(strict);
export type ArtifactBundle = typeof ArtifactBundle.Type;

export const decodeArtifactBundle = Schema.decodeUnknownSync(ArtifactBundle);

/**
 * The bundle as the mirror writes it.
 *
 * Header keys are emitted in the mirror's order. The definition keeps the key
 * order it already has, which is the same choice the mirror makes when it
 * stringifies the definition it was given.
 */
export function encodeArtifactBundle(bundle: ArtifactBundle): string {
  const header: ArtifactBundleHeader = {
    format: bundle.octant.format,
    canvasId: bundle.octant.canvasId,
    versionId: bundle.octant.versionId,
    sequence: bundle.octant.sequence,
    title: bundle.octant.title,
    mode: bundle.octant.mode,
    projectId: bundle.octant.projectId,
    hostId: bundle.octant.hostId,
    createdAt: bundle.octant.createdAt,
  };
  return `${JSON.stringify({ octant: header, definition: bundle.definition }, null, 2)}\n`;
}
