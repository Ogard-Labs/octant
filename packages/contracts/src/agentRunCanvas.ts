import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AgentRunParentThreadId } from "./agentRun";
import { CanvasId, CanvasVersionId } from "./canvasIdentity";
import { CanvasOriginThreadId } from "./canvasCards";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";

export const AgentRunCanvasSnapshotRequest = Schema.Struct({
  parentThreadId: AgentRunParentThreadId,
});
export type AgentRunCanvasSnapshotRequest = typeof AgentRunCanvasSnapshotRequest.Type;

export const AgentRunCanvasSnapshotResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    canvasId: CanvasId,
    versionId: CanvasVersionId,
    title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
    originThreadId: CanvasOriginThreadId,
    mode: OctantMode,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("denied"),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
  }),
]);
export type AgentRunCanvasSnapshotResult = typeof AgentRunCanvasSnapshotResult.Type;

export const decodeAgentRunCanvasSnapshotRequest = Schema.decodeUnknownSync(
  AgentRunCanvasSnapshotRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAgentRunCanvasSnapshotResult = Schema.decodeUnknownSync(
  AgentRunCanvasSnapshotResult,
  STRICT_DECODE_OPTIONS,
);
