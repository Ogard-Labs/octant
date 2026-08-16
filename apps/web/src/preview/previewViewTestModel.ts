import {
  decodePreviewChunk,
  decodePreviewChunkId,
  decodePreviewHostId,
  decodePreviewManifest,
  decodePreviewOpaqueRef,
  decodePreviewTarget,
  decodePreviewTargetId,
  type PreviewChunk,
  type PreviewChunkId,
  type PreviewContentBounds,
  type PreviewFidelity,
  type PreviewHostId,
  type PreviewManifest,
  type PreviewOpaqueRef,
  type PreviewTarget,
  type PreviewTargetId,
} from "@octant/contracts/previews";
import { decodeProjectId, type ProjectId } from "@octant/contracts/projects";
import { UtcTimestamp } from "@octant/contracts/events";

const targetId = decodePreviewTargetId("11111111-1111-4111-8111-111111111111") as PreviewTargetId;
const hostId = decodePreviewHostId("33333333-3333-4333-8333-333333333333") as PreviewHostId;
const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001") as ProjectId;
const chunkId = decodePreviewChunkId("22222222-2222-4222-8222-222222222222") as PreviewChunkId;
const opaqueRef = decodePreviewOpaqueRef("test-ref") as PreviewOpaqueRef;
const observedAt = "2026-07-23T00:00:00.000Z" as UtcTimestamp;
const sourceVersion = {
  contentSha256: "0".repeat(64) as never,
  byteSize: 1 as never,
  observedAt,
};

export function buildTarget(displayName: string): PreviewTarget {
  return decodePreviewTarget({
    targetId,
    projectId,
    hostId,
    kind: "file",
    opaqueRef,
    displayName,
  }) as PreviewTarget;
}

export function buildManifest(args: {
  readonly kind: PreviewManifest["kind"];
  readonly displayName: string;
  readonly fidelity?: PreviewFidelity;
  readonly bounds?: PreviewContentBounds;
}): PreviewManifest {
  return decodePreviewManifest({
    target: buildTarget(args.displayName),
    sourceVersion,
    kind: args.kind,
    sniffedMediaType: "application/octet-stream",
    byteSize: 1,
    fidelity: args.fidelity ?? { level: "limited", notice: "Limited-fidelity preview." },
    capabilities: {
      canSearch: true,
      canSelect: true,
      canZoom: false,
      canRevealInFinder: true,
      canOpenExternally: true,
      canQuickLook: true,
      canEditInMonaco: false,
    },
    bounds: args.bounds ?? {},
    producedAt: observedAt,
  }) as PreviewManifest;
}

export function buildChunk(args: {
  readonly kind: PreviewChunk["payload"]["kind"];
  readonly sequence: number;
  readonly descriptor: PreviewChunk["descriptor"];
  readonly payload: PreviewChunk["payload"];
  readonly isFinal?: boolean;
}): PreviewChunk {
  return decodePreviewChunk({
    chunkId,
    targetId,
    sourceVersion,
    kind: args.kind,
    sequence: args.sequence as never,
    descriptor: args.descriptor,
    payload: args.payload,
    isFinal: args.isFinal ?? false,
  }) as PreviewChunk;
}

export { chunkId };
