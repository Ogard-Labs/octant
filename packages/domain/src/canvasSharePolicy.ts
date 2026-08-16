import {
  decodeCanvasStaticExportRequest,
  type CanvasRedactedProvenance,
  type CanvasStaticExportBlock,
  type CanvasStaticExportDocument,
  type CanvasStaticExportReceipt,
  type CanvasStaticExportRequest,
  type CanvasStaticExportSourceEntry,
} from "@octant/contracts/canvas-share";
import {
  decodeCanvasVersion,
  type CanvasBlock,
  type CanvasDefinition,
  type CanvasVersion,
} from "@octant/contracts/canvas";
import type { UtcTimestamp } from "@octant/contracts/events";

export type CanvasShareDenialCode =
  | "malformed-request"
  | "sharing-disabled"
  | "consent-required"
  | "scope-mismatch"
  | "stale-version"
  | "unsafe-payload"
  | "unsupported-channel";

export class CanvasSharePolicyRejected extends Error {
  override readonly name = "CanvasSharePolicyRejected";

  constructor(
    readonly denialCode: CanvasShareDenialCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: CanvasShareDenialCode, message: string): never {
  throw new CanvasSharePolicyRejected(code, message);
}

const SECRET_KEY_PATTERN =
  /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i;
const SECRET_VALUE_PATTERN =
  /(?:ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-proj-[A-Za-z0-9._-]{10,}|sk-[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|Basic\s+[A-Za-z0-9+/=]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const FILE_PATH_PATTERN =
  /(?:^|[\s"'`()\[\]{}<>|,;])(?:file:\/\/\/?[^\s"'`<>]+|\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+|\.\.(?:\/|\\)|[A-Za-z]:\\[^\s"'`<>]*)/i;
const CREDENTIAL_QUERY_KEY_PATTERN =
  /^(?:token|access_token|id_token|refresh_token|auth|authorization|signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token|api[_-]?key|key|password|passwd|secret|session|code|jwt)$/i;

export interface CanvasSharePolicyContext {
  readonly sharingEnabled: boolean;
  readonly hostId: string;
  readonly projectId: string;
  readonly nowIso: UtcTimestamp | string;
  /**
   * Authoritative local-user principal for the export request. When provided,
   * consent.acknowledgedBy must match this identity exactly.
   */
  readonly actor: {
    readonly kind: "local-user";
    readonly actorId: string;
  };
}

function extractCandidateUrls(value: string): string[] {
  const candidates = new Set<string>();
  const trimmed = value.trim();
  if (trimmed) candidates.add(trimmed);
  const embedded = value.match(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`<>]+/g) ?? [];
  for (const match of embedded) {
    candidates.add(match.replace(/[),.;]+$/g, ""));
  }
  return [...candidates];
}

function assertNoCredentialBearingUrl(value: string, path: string): void {
  for (const candidate of extractCandidateUrls(value)) {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }

    // file: URLs disclose host filesystem locations even without credentials.
    if (parsed.protocol === "file:") {
      reject("unsafe-payload", `Canvas export field ${path} contains a filesystem URL.`);
    }

    // Any scheme may carry userinfo credentials (for example postgres://user:pass@host/db).
    if (parsed.username !== "" || parsed.password !== "") {
      reject(
        "unsafe-payload",
        `Canvas export field ${path} contains a credential-bearing URL userinfo segment.`,
      );
    }

    for (const [key] of parsed.searchParams) {
      if (SECRET_KEY_PATTERN.test(key) || CREDENTIAL_QUERY_KEY_PATTERN.test(key)) {
        reject(
          "unsafe-payload",
          `Canvas export field ${path} contains a credential-bearing URL query parameter.`,
        );
      }
    }

    // Signed/query-token URLs sometimes hide credentials only in the fragment.
    if (parsed.hash.includes("=")) {
      const fragmentQuery = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
      const fragmentParams = new URLSearchParams(fragmentQuery);
      for (const [key] of fragmentParams) {
        if (SECRET_KEY_PATTERN.test(key) || CREDENTIAL_QUERY_KEY_PATTERN.test(key)) {
          reject(
            "unsafe-payload",
            `Canvas export field ${path} contains a credential-bearing URL fragment parameter.`,
          );
        }
      }
    }
  }
}

function assertNoSecretShape(value: unknown, path: string): void {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return;
  }
  if (typeof value === "string") {
    if (SECRET_VALUE_PATTERN.test(value) || FILE_PATH_PATTERN.test(value)) {
      reject(
        "unsafe-payload",
        `Canvas export field ${path} contains a forbidden secret or path shape.`,
      );
    }
    assertNoCredentialBearingUrl(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretShape(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        reject("unsafe-payload", `Canvas export field ${path}.${key} uses a forbidden secret key.`);
      }
      assertNoSecretShape(entry, `${path}.${key}`);
    }
  }
}

function sanitizeBlock(block: CanvasBlock): CanvasStaticExportBlock {
  // Drop live source ids from reference-like blocks so the offline snapshot
  // cannot be used to re-resolve host-local authority later.
  switch (block.kind) {
    case "citation":
    case "code-excerpt":
    case "diff":
    case "source-reference":
    case "artifact-reference":
    case "file-reference":
    case "preview-reference":
    case "browser-reference":
    case "evidence-reference":
    case "image": {
      const { sourceId: _sourceId, ...rest } = block as CanvasBlock & { sourceId?: string };
      assertNoSecretShape(rest, `block.${block.blockId}`);
      return rest as CanvasStaticExportBlock;
    }
    default:
      assertNoSecretShape(block, `block.${block.blockId}`);
      return block as CanvasStaticExportBlock;
  }
}

function redactProvenance(definition: CanvasDefinition): CanvasRedactedProvenance {
  const provenance = definition.provenance;
  return {
    hostId: provenance.hostId,
    projectId: provenance.projectId,
    mode: provenance.mode,
    threadId: provenance.threadId,
    createdAt: provenance.createdAt,
    providerLabel: "provider",
    modelLabel: (() => {
      const modelLabel = String(provenance.modelId);
      assertNoSecretShape(modelLabel, "provenance.modelLabel");
      return modelLabel;
    })(),
    actorKind: provenance.actor.kind,
  };
}

function redactSources(definition: CanvasDefinition): CanvasStaticExportSourceEntry[] {
  return definition.sourceManifest.map((entry) => {
    assertNoSecretShape(entry.displayName, "source.displayName");
    assertNoSecretShape(entry.opaqueRef, "source.opaqueRef");
    return {
      sourceId: entry.sourceId,
      kind: entry.kind,
      displayName: entry.displayName,
      opaqueRef: entry.opaqueRef,
    };
  });
}

/**
 * Validate explicit consent and host/project binding before any export body is
 * built. Local-only hosts keep full Canvas use when sharingEnabled is false.
 */
export function validateCanvasStaticExportRequest(input: {
  readonly request: unknown;
  readonly current: CanvasVersion;
  readonly context: CanvasSharePolicyContext;
}): CanvasStaticExportRequest {
  let request: CanvasStaticExportRequest;
  try {
    request = decodeCanvasStaticExportRequest(input.request);
  } catch {
    reject("malformed-request", "Canvas static export request is malformed.");
  }

  if (!input.context.sharingEnabled) {
    reject("sharing-disabled", "Canvas sharing is disabled; local Canvas use remains available.");
  }
  if (request.channel !== "static-export") {
    reject("unsupported-channel", "Only static Canvas export is available in this slice.");
  }
  if (
    request.consent.acknowledgedOfflineSnapshot !== true ||
    request.consent.acknowledgedNoCredentials !== true
  ) {
    reject("consent-required", "Canvas static export requires explicit dual consent.");
  }
  if (request.consent.acknowledgedBy.kind !== "local-user") {
    reject(
      "consent-required",
      "Canvas static export consent must be acknowledged by a local user.",
    );
  }
  if (input.context.actor.kind !== "local-user") {
    reject("consent-required", "Canvas static export requires an authenticated local-user caller.");
  }
  if (
    request.consent.acknowledgedBy.kind !== input.context.actor.kind ||
    String(request.consent.acknowledgedBy.actorId) !== String(input.context.actor.actorId)
  ) {
    reject(
      "consent-required",
      "Canvas static export consent must match the authenticated local-user caller.",
    );
  }
  if (String(request.canvasId) !== String(input.current.canvasId)) {
    reject("scope-mismatch", "Canvas export does not match the Canvas identity.");
  }
  if (String(request.versionId) !== String(input.current.versionId)) {
    reject("scope-mismatch", "Canvas export does not match the Canvas version identity.");
  }
  if (request.expectedSequence !== input.current.sequence) {
    reject("stale-version", "Canvas export expected sequence is stale.");
  }
  if (
    request.hostId !== input.context.hostId ||
    request.hostId !== input.current.definition.provenance.hostId
  ) {
    reject("scope-mismatch", "Canvas export host does not match the authoritative host.");
  }
  if (
    String(request.projectId) !== String(input.context.projectId) ||
    String(request.projectId) !== String(input.current.definition.provenance.projectId)
  ) {
    reject("scope-mismatch", "Canvas export Project does not match the authoritative Project.");
  }
  return request;
}

export function buildCanvasStaticExportDocument(input: {
  readonly request: CanvasStaticExportRequest;
  readonly current: CanvasVersion;
  readonly exportedAt: UtcTimestamp | string;
}): CanvasStaticExportDocument {
  const definition = input.current.definition;
  const blocks = definition.blocks.map((block) => sanitizeBlock(block));
  assertNoSecretShape(definition.title, "title");
  const exportedAtRaw = String(input.exportedAt);
  if (
    !Number.isFinite(Date.parse(exportedAtRaw)) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(exportedAtRaw)
  ) {
    reject("malformed-request", "Canvas export timestamp is invalid.");
  }
  const exportedAt = exportedAtRaw as UtcTimestamp;

  return {
    schemaVersion: 1,
    kind: "canvas-static-export-document",
    exportId: input.request.exportId,
    canvasId: input.current.canvasId,
    versionId: input.current.versionId,
    sequence: input.current.sequence,
    exportedAt,
    title: definition.title,
    channel: "static-export",
    sharingEnabled: true,
    provenance: redactProvenance(definition),
    sourceManifest: redactSources(definition),
    blocks,
    threatModelId: "canvas-share-static-export-v1",
  };
}

export function buildCanvasStaticExportReceipt(input: {
  readonly request: unknown;
  readonly current: unknown;
  readonly context: CanvasSharePolicyContext;
}): CanvasStaticExportReceipt {
  let current: CanvasVersion;
  try {
    current = decodeCanvasVersion(input.current);
  } catch {
    reject("malformed-request", "Canvas version for export is malformed.");
  }
  const request = validateCanvasStaticExportRequest({
    request: input.request,
    current,
    context: input.context,
  });
  const exportedAt = input.context.nowIso as UtcTimestamp;
  const document = buildCanvasStaticExportDocument({
    request,
    current,
    exportedAt,
  });
  if (request.note !== undefined) {
    assertNoSecretShape(request.note, "note");
  }
  return {
    schemaVersion: 1,
    kind: "canvas-static-export-receipt",
    exportId: request.exportId,
    canvasId: current.canvasId,
    versionId: current.versionId,
    sequence: current.sequence,
    exportedAt,
    channel: "static-export",
    document,
    consent: request.consent,
    ...(request.note ? { note: request.note } : {}),
  };
}

export const CANVAS_SHARE_THREAT_MODEL_ID = "canvas-share-static-export-v1" as const;

export const CANVAS_SHARE_THREAT_MODEL = {
  id: CANVAS_SHARE_THREAT_MODEL_ID,
  title: "Canvas static export threat model",
  assets: [
    "Canvas title, blocks, and redacted provenance",
    "Opaque source references without host paths",
    "Operator consent receipt",
  ],
  nonGoals: [
    "Authenticated browser snapshots",
    "Public or anonymous share links",
    "Cross-host authority or live credential export",
  ],
  threats: [
    {
      id: "T1",
      name: "Credential leakage in export payload",
      mitigation:
        "Dual consent plus secret-key/value and credential-bearing URL sanitization before document build",
    },
    {
      id: "T2",
      name: "Path or root disclosure via source manifest",
      mitigation:
        "Export only opaqueRef/displayName/kind; drop live source resolution ids from blocks",
    },
    {
      id: "T3",
      name: "Silent export without operator intent",
      mitigation:
        "Require local-user dual consent bound to the authenticated caller on every request",
    },
    {
      id: "T4",
      name: "Stale or cross-project export",
      mitigation:
        "Bind canvasId, versionId, sequence, hostId, and projectId to the authoritative version",
    },
    {
      id: "T5",
      name: "Sharing disabled bypass",
      mitigation:
        "Fail closed when sharingEnabled is false while leaving local Canvas fully usable",
    },
  ],
} as const;
