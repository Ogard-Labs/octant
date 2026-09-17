import { Schema } from "effect";
import { AgentRunParentThreadId } from "./agentRun";
import { CanvasId, CanvasVersionId } from "./canvasIdentity";
import { CanvasOriginThreadId } from "./canvasCards";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const AgentRunCanvasSnapshotRequest = Schema.Struct({
  parentThreadId: AgentRunParentThreadId,
}).annotations(strict);
export type AgentRunCanvasSnapshotRequest = typeof AgentRunCanvasSnapshotRequest.Type;

export const AgentRunCanvasSnapshotResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    canvasId: CanvasId,
    versionId: CanvasVersionId,
    title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
    originThreadId: CanvasOriginThreadId,
    mode: OctantMode,
    projectId: ProjectId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("denied"),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
  }).annotations(strict),
);
export type AgentRunCanvasSnapshotResult = typeof AgentRunCanvasSnapshotResult.Type;

export const decodeAgentRunCanvasSnapshotRequest = Schema.decodeUnknownSync(
  AgentRunCanvasSnapshotRequest,
);
export const decodeAgentRunCanvasSnapshotResult = Schema.decodeUnknownSync(
  AgentRunCanvasSnapshotResult,
);
