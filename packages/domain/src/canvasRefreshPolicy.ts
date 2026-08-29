import {
  decodeCanvasRefreshRequest,
  type CanvasRefreshRequest,
  type CanvasRefreshSourceResult,
  type CanvasRefreshOutcome,
} from "@octant/contracts/canvas-refresh";
import {
  decodeCanvasVersion,
  type CanvasVersion,
  type CanvasSourceManifestEntry,
  type CanvasActor,
} from "@octant/contracts/canvas";
import { type CanvasWorkspaceScope } from "@octant/contracts/canvas-cards";
import { clampCanvasAuthority } from "./canvasCardsPolicy";
import { assertCanvasVersionAppend } from "./canvasLifecyclePolicy";

export type CanvasRefreshDenialCode =
  | "malformed-request"
  | "unavailable"
  | "unauthorized"
  | "scope-mismatch"
  | "mode-mismatch"
  | "origin-thread-mismatch"
  | "stale-version"
  | "revoked"
  | "offline"
  | "incompatible"
  | "cancelled";

export class CanvasRefreshPolicyRejected extends Error {
  override readonly name = "CanvasRefreshPolicyRejected";

  constructor(
    readonly denialCode: CanvasRefreshDenialCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: CanvasRefreshDenialCode, message: string): never {
  throw new CanvasRefreshPolicyRejected(code, message);
}

function sameWorkspace(left: CanvasWorkspaceScope, right: CanvasWorkspaceScope): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Recipe parameters are bounded to server-owned opaque/ref references by the
// contract schema; this policy guard independently rejects any free-form value
// that reaches a receipt, so a secret-shaped value can never be journaled.
function assertNoSecrets(request: CanvasRefreshRequest): void {
  for (const parameter of request.recipe.parameters) {
    if (!/^(?:opaque|ref):[A-Za-z0-9._:-]+$/i.test(parameter.value)) {
      reject(
        "malformed-request",
        "Canvas refresh recipe parameters must be server-owned opaque references; raw values are not accepted.",
      );
    }
  }
}

function assertUniqueSources(request: CanvasRefreshRequest): void {
  const seen = new Set<string>();
  for (const source of request.recipe.sourceManifest) {
    const sourceId = String(source.sourceId);
    if (seen.has(sourceId)) {
      reject("malformed-request", "Canvas refresh recipe contains a duplicate source.");
    }
    seen.add(sourceId);
    if (source.hostId !== request.hostId) {
      reject("scope-mismatch", "Canvas refresh source host does not match the recipe host.");
    }
    if (String(source.projectId) !== String(request.recipe.workspace.projectId ?? "")) {
      // Chat workspaces are virtual and carry a null workspace Project; their
      // source manifest is still bound to the owning Canvas Project and is
      // checked against provenance by the server before this policy runs.
      if (request.recipe.workspace.projectId !== null) {
        reject("scope-mismatch", "Canvas refresh source Project does not match the recipe.");
      }
    }
  }
}

export interface CanvasRefreshValidationContext {
  readonly mode: "chat" | "work" | "code";
  readonly projectId: string | null;
  readonly hostId?: string;
  readonly workspace?: CanvasWorkspaceScope;
}

/**
 * Reauthorize a refresh against the immutable Canvas provenance and current
 * active workspace. The callback-based provider/extension/credential checks
 * run after this pure boundary, so a renderer cannot widen authority by
 * changing a recipe field.
 */
export function validateCanvasRefreshRequest(input: {
  readonly request: unknown;
  readonly current: CanvasVersion;
  readonly context: CanvasRefreshValidationContext;
}): CanvasRefreshRequest {
  let request: CanvasRefreshRequest;
  try {
    request = decodeCanvasRefreshRequest(input.request);
  } catch {
    reject("malformed-request", "Canvas refresh request is malformed.");
  }
  const provenance = input.current.definition.provenance;
  if (String(request.recipe.canvasId) !== String(input.current.canvasId)) {
    reject("scope-mismatch", "Canvas refresh recipe does not match the Canvas.");
  }
  if (request.expectedSequence !== input.current.sequence) {
    reject("stale-version", "Canvas refresh expected sequence is stale.");
  }
  if (request.hostId !== provenance.hostId || request.recipe.hostId !== provenance.hostId) {
    reject("scope-mismatch", "Canvas refresh host does not match the Canvas.");
  }
  if (input.context.hostId !== undefined && request.hostId !== input.context.hostId) {
    reject("scope-mismatch", "Canvas refresh host does not match the active host.");
  }
  if (request.mode !== provenance.mode || request.recipe.mode !== provenance.mode) {
    reject("mode-mismatch", "Canvas refresh mode does not match the Canvas.");
  }
  if (input.context.mode !== request.mode) {
    reject("mode-mismatch", "Canvas refresh mode does not match the active workspace.");
  }
  if (String(request.originThreadId) !== String(provenance.threadId)) {
    reject("origin-thread-mismatch", "Canvas refresh thread does not match the Canvas.");
  }
  if (String(request.recipe.originThreadId) !== String(provenance.threadId)) {
    reject("origin-thread-mismatch", "Canvas refresh recipe thread does not match the Canvas.");
  }
  if (String(input.context.projectId ?? "") !== String(provenance.projectId ?? "")) {
    reject("scope-mismatch", "Canvas refresh Project does not match the active workspace.");
  }
  if (!sameWorkspace(request.workspace, request.recipe.workspace)) {
    reject("scope-mismatch", "Canvas refresh workspace differs from its approved recipe.");
  }
  if (
    input.context.workspace !== undefined &&
    !sameWorkspace(request.workspace, input.context.workspace)
  ) {
    reject("scope-mismatch", "Canvas refresh workspace does not match the active server scope.");
  }
  if (
    String(request.providerInstanceId) !== String(provenance.providerInstanceId) ||
    String(request.recipe.providerInstanceId) !== String(provenance.providerInstanceId)
  ) {
    reject("unauthorized", "Canvas refresh provider is no longer authorized.");
  }
  if (request.modelId !== provenance.modelId || request.recipe.modelId !== provenance.modelId) {
    reject("unauthorized", "Canvas refresh model is no longer authorized.");
  }
  try {
    clampCanvasAuthority({
      requestedAuthority: request.requestedAuthority,
      scope: request.workspace,
    });
  } catch (error) {
    reject(
      "unauthorized",
      error instanceof Error ? error.message : "Canvas refresh authority is invalid.",
    );
  }
  assertNoSecrets(request);
  assertUniqueSources(request);
  if (request.recipe.sourceManifest.length === 0) {
    reject(
      "malformed-request",
      "Canvas refresh recipes must name at least one canonical source; source-free regeneration is unavailable.",
    );
  }
  return request;
}

export function classifyCanvasRefreshOutcome(
  sources: ReadonlyArray<Pick<CanvasRefreshSourceResult, "status">>,
): CanvasRefreshOutcome {
  if (sources.every((source) => source.status === "ready")) return "ready";
  if (sources.some((source) => source.status === "interrupted")) return "cancelled";
  if (sources.every((source) => source.status === "failed")) return "failed";
  return "partial";
}

export interface BuildCanvasRefreshVersionInput {
  readonly canvasId: CanvasVersion["canvasId"];
  readonly current: CanvasVersion;
  readonly nextVersionId: CanvasVersion["versionId"];
  readonly request: CanvasRefreshRequest;
  readonly sources: ReadonlyArray<CanvasRefreshSourceResult>;
  readonly refreshedDefinition?: CanvasVersion["definition"];
  readonly actor?: CanvasActor;
  readonly createdAt: CanvasVersion["createdAt"];
}

function refreshedSourceManifest(
  manifest: ReadonlyArray<CanvasSourceManifestEntry>,
  sources: ReadonlyArray<CanvasRefreshSourceResult>,
): ReadonlyArray<CanvasSourceManifestEntry> {
  const observations = new Map<string, NonNullable<CanvasRefreshSourceResult["observedVersion"]>>();
  for (const source of sources) {
    if (source.status !== "ready") continue;
    const observedVersion = source.observedVersion;
    if (observedVersion === undefined) continue;
    observations.set(String(source.sourceId), observedVersion);
  }
  return manifest.map((entry) => {
    const observedVersion = observations.get(String(entry.sourceId));
    return observedVersion === undefined ? entry : { ...entry, sourceVersion: observedVersion };
  });
}

/** Build the next immutable Canvas version only after every source is ready. */
export function buildCanvasRefreshVersion(input: BuildCanvasRefreshVersionInput): CanvasVersion {
  const outcome = classifyCanvasRefreshOutcome(input.sources);
  if (outcome !== "ready") {
    reject("unavailable", "Canvas refresh did not produce a complete version.");
  }
  if (input.sources.length === 0 && input.refreshedDefinition === undefined) {
    reject("unavailable", "A source-free Canvas refresh must provide regenerated Canvas content.");
  }
  const next = decodeCanvasVersion({
    schemaVersion: input.current.schemaVersion,
    canvasId: input.canvasId,
    versionId: input.nextVersionId,
    sequence: input.current.sequence + 1,
    definition: {
      ...(input.refreshedDefinition ?? input.current.definition),
      provenance: {
        ...input.current.definition.provenance,
        createdAt: input.createdAt,
      },
      sourceManifest: refreshedSourceManifest(
        input.current.definition.sourceManifest,
        input.sources,
      ),
    },
    createdBy: input.actor ?? input.current.createdBy,
    createdAt: input.createdAt,
  });
  return assertCanvasVersionAppend(input.canvasId, input.current, next);
}
