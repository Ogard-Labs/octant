import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasDefinition,
  decodeCanvasId,
  decodeCanvasVersionId,
  type CanvasActor,
  type CanvasDefinition,
  type CanvasId,
  type CanvasVersion,
  type CanvasVersionId,
} from "@octant/contracts/canvas";
import {
  decodeCanvasReviseDenialCode,
  decodeCanvasReviseReceiptId,
  decodeCanvasReviseRequest,
  decodeCanvasVersionHistory,
  decodeCanvasVersionHistoryEntry,
  type CanvasReviseDenialCode,
  type CanvasReviseRequest,
  type CanvasVersionHistoryEntry,
} from "@octant/contracts/canvas-revision";
import type { UtcTimestamp } from "@octant/contracts/events";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import { CanvasCardsPolicyRejected, clampCanvasAuthority } from "./canvasCardsPolicy";
import { assertCanvasVersionAppend } from "./canvasLifecyclePolicy";
import { validateCanvasDefinition } from "./canvasPolicy";

export class CanvasRevisionPolicyRejected extends Error {
  override readonly name = "CanvasRevisionPolicyRejected";

  constructor(
    readonly denialCode: CanvasReviseDenialCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(denialCode: CanvasReviseDenialCode, message: string): never {
  throw new CanvasRevisionPolicyRejected(denialCode, message);
}

function decodeOrReject<T>(
  decode: (input: unknown) => T,
  input: unknown,
  denialCode: CanvasReviseDenialCode,
  message: string,
): T {
  try {
    return decode(input);
  } catch {
    return reject(denialCode, message);
  }
}

function mapCardsDenial(error: CanvasCardsPolicyRejected): CanvasReviseDenialCode {
  const code = error.denialCode;
  if (code === "malformed-request" || code === "invalid-prompt" || code === "invalid-template") {
    return "malformed-request";
  }
  return decodeCanvasReviseDenialCode(code);
}

export function canvasReviseDenialReason(input: unknown): CanvasReviseDenialCode | null {
  let request: CanvasReviseRequest;
  try {
    request = decodeOrReject(
      decodeCanvasReviseRequest,
      input,
      "malformed-request",
      "Canvas revise request is malformed.",
    );
  } catch (error) {
    if (error instanceof CanvasRevisionPolicyRejected) return error.denialCode;
    return "malformed-request";
  }
  try {
    clampCanvasAuthority({
      requestedAuthority: request.requestedAuthority,
      scope: request.workspace,
    });
  } catch (error) {
    if (error instanceof CanvasCardsPolicyRejected) return mapCardsDenial(error);
    return "malformed-request";
  }
  return null;
}

export interface ClampRevisionProvenanceInput {
  readonly current: CanvasDefinition;
  readonly actor: CanvasActor;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly createdAt: UtcTimestamp;
}

/**
 * Preserve host, mode, Project, and thread provenance while recording the
 * revision actor, provider, model, and timestamp on the new immutable version.
 */
export function clampRevisionProvenance(input: ClampRevisionProvenanceInput): CanvasDefinition {
  const provenance = input.current.provenance;
  return decodeCanvasDefinition({
    ...input.current,
    provenance: {
      ...provenance,
      actor: input.actor,
      providerInstanceId: input.providerInstanceId,
      modelId: input.modelId,
      createdAt: input.createdAt,
    },
  });
}

/**
 * Deterministic prompt refinement for tests and bounded local revision. Appends
 * a first-party callout carrying the bounded prompt without granting new
 * authority or persisting secrets.
 */
export function applyPromptRefinement(
  definition: CanvasDefinition,
  prompt: string,
): CanvasDefinition {
  const blockId = `revision-${definition.blocks.length + 1}`;
  const callout = {
    blockId,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "callout",
    tone: "info",
    title: "Revision",
    text: prompt,
  } as const;
  return validateCanvasDefinition({
    ...definition,
    blocks: [...definition.blocks, callout],
  });
}

export interface BuildRevisionVersionInput {
  readonly canvasId: CanvasId;
  readonly current: CanvasVersion;
  readonly nextVersionId: CanvasVersionId;
  readonly prompt: string;
  readonly actor: CanvasActor;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly createdAt: UtcTimestamp;
}

export function buildRevisionVersion(input: BuildRevisionVersionInput): CanvasVersion {
  const refinedDefinition = applyPromptRefinement(
    clampRevisionProvenance({
      current: input.current.definition,
      actor: input.actor,
      providerInstanceId: input.providerInstanceId,
      modelId: input.modelId,
      createdAt: input.createdAt,
    }),
    input.prompt,
  );
  const nextEnvelope = {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    canvasId: input.canvasId,
    versionId: input.nextVersionId,
    sequence: input.current.sequence + 1,
    definition: refinedDefinition,
    createdBy: input.actor,
    createdAt: input.createdAt,
  };
  return assertCanvasVersionAppend(input.canvasId, input.current, nextEnvelope);
}

export function projectVersionHistoryEntry(
  version: CanvasVersion,
  promptSummary?: string,
): CanvasVersionHistoryEntry {
  const provenance = version.definition.provenance;
  const entry = {
    versionId: version.versionId,
    sequence: version.sequence,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    title: version.definition.title,
    createdAt: version.createdAt,
    createdBy: version.createdBy,
    providerInstanceId: provenance.providerInstanceId,
    modelId: provenance.modelId,
    ...(promptSummary === undefined ? {} : { promptSummary }),
  };
  return decodeCanvasVersionHistoryEntry(entry);
}

export function listCanvasVersionHistory(
  canvasId: CanvasId,
  versions: ReadonlyArray<CanvasVersion>,
  promptSummaries: ReadonlyMap<string, string> = new Map(),
): ReturnType<typeof decodeCanvasVersionHistory> {
  const sorted = [...versions].sort((left, right) => left.sequence - right.sequence);
  const current = sorted.at(-1);
  if (current === undefined) {
    reject("unavailable", "Canvas has no version history.");
  }
  const entries = sorted.map((version) =>
    projectVersionHistoryEntry(
      version,
      promptSummaries.get(String(version.versionId)) ?? undefined,
    ),
  );
  return decodeCanvasVersionHistory({
    canvasId,
    currentVersionId: current.versionId,
    entries,
  });
}

export interface AdmitCanvasReviseInput {
  readonly request: unknown;
  readonly current: CanvasVersion;
  readonly receiptId: unknown;
  readonly nextVersionId: unknown;
  readonly now: UtcTimestamp;
}

export function admitCanvasRevise(input: AdmitCanvasReviseInput): {
  readonly kind: "accepted";
  readonly next: CanvasVersion;
  readonly receipt: {
    readonly schemaVersion: 1;
    readonly kind: "canvas-revise-receipt";
    readonly receiptId: ReturnType<typeof decodeCanvasReviseReceiptId>;
    readonly requestId: CanvasReviseRequest["requestId"];
    readonly canvasId: CanvasId;
    readonly versionId: CanvasVersionId;
    readonly sequence: number;
    readonly outcome: "ready";
    readonly createdAt: UtcTimestamp;
  };
} {
  const request = decodeOrReject(
    decodeCanvasReviseRequest,
    input.request,
    "malformed-request",
    "Canvas revise request is malformed.",
  );
  try {
    clampCanvasAuthority({
      requestedAuthority: request.requestedAuthority,
      scope: request.workspace,
    });
  } catch (error) {
    if (error instanceof CanvasCardsPolicyRejected) {
      reject(mapCardsDenial(error), error.message);
    }
    reject("malformed-request", "Canvas revise authority is invalid.");
  }
  const provenance = input.current.definition.provenance;
  if (provenance.mode !== request.mode) {
    reject("mode-mismatch", "Canvas revise mode does not match the current canvas.");
  }
  if (String(provenance.threadId) !== String(request.originThreadId)) {
    reject("origin-thread-mismatch", "Canvas revise origin thread does not match the canvas.");
  }
  if (request.expectedSequence !== input.current.sequence) {
    reject("stale-version", "Canvas expected sequence does not match the current head version.");
  }
  const nextVersionId = decodeOrReject(
    decodeCanvasVersionId,
    input.nextVersionId,
    "malformed-request",
    "Canvas revision version identity is invalid.",
  );
  const receiptId = decodeOrReject(
    decodeCanvasReviseReceiptId,
    input.receiptId,
    "malformed-request",
    "Canvas revise receipt identity is invalid.",
  );
  const next = buildRevisionVersion({
    canvasId: decodeCanvasId(request.canvasId),
    current: input.current,
    nextVersionId,
    prompt: request.prompt,
    actor: request.actor,
    providerInstanceId: request.providerInstanceId,
    modelId: request.modelId,
    createdAt: input.now,
  });
  const receipt = {
    schemaVersion: 1 as const,
    kind: "canvas-revise-receipt" as const,
    receiptId,
    requestId: request.requestId,
    canvasId: request.canvasId,
    versionId: next.versionId,
    sequence: next.sequence,
    outcome: "ready" as const,
    createdAt: input.now,
  };
  return { kind: "accepted", next, receipt };
}

export const validateCanvasReviseDenialCode = decodeCanvasReviseDenialCode;
