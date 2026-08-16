import { createHash, randomUUID } from "node:crypto";
import { release } from "node:os";
import {
  decodeDiagnosticFailureCode,
  decodeDiagnosticFailureDomain,
  decodeDiagnosticsExportReceipt,
  type DiagnosticFailureCode,
  type DiagnosticFailureDomain,
  type CorrelationId,
  type DiagnosticsExportOutcome,
  type DiagnosticsExportRequest,
} from "@octant/contracts";
import {
  buildDiagnosticsExportReceipt,
  buildDiagnosticsPacket,
  defaultDiagnosticsRecoveryAction,
  sealDiagnosticsExport,
  serializeDiagnosticsEvidencePacket,
} from "@octant/domain";
import {
  DIAGNOSTICS_EXPORT_RECEIPT_RECORDED,
  DIAGNOSTICS_FAILURE_INCIDENT_RECORDED,
  readDiagnosticsFailureIncident,
  readDiagnosticsExportReceipt,
} from "./persistence/diagnosticsExportProjection";
import type { Journal } from "./persistence/journal";
import type { SqliteConnection } from "./persistence/sqlitePort";
import { OCTANT_LOCAL_ACTOR_ID } from "./shellService";

/**
 * The single host-authoritative diagnostics export command. Both the
 * HTTP route (`./diagnosticsExportRoutes.ts`) and the CLI
 * (`./diagnosticsExportCli.ts`) call this exact function rather than
 * re-implementing packet assembly, so the redaction/sealing policy is
 * invoked identically and without bypass from every transport. Callers are
 * responsible for verifying the caller is an authorized local-window actor
 * (via `authorizeDiagnosticsExportActor`) before reaching this function —
 * exactly the same division of concerns every other product route in this
 * server uses (authenticate/authorize in the route, then call the shared
 * service).
 */

export interface DiagnosticsExportServiceDeps {
  readonly connection: SqliteConnection;
  readonly journal: Pick<Journal, "append">;
  /** The concrete Octant server build currently serving this request. */
  readonly octantVersion: string;
  /** ISO-8601 UTC clock; defaults to the real wall clock. */
  readonly clock?: () => string;
  /** UUID generator for the packet id; defaults to `randomUUID`. */
  readonly idGenerator?: () => string;
  /** UUID generator for journal event identities; defaults to `randomUUID`. */
  readonly eventIdGenerator?: () => string;
}

/**
 * Host component/version facts. Single-host V1 technical preview has no
 * separate candidate/host build split, so both packet fields reuse the same
 * facts; this is documented rather than fabricated, and a future release
 * channel can diverge them without changing this module's contract.
 */
function hostComponentVersions(
  octantVersion: string,
): ReadonlyArray<{ component: string; version: string }> {
  return [
    { component: "octant-server", version: octantVersion },
    { component: "node", version: process.version },
    { component: "os", version: release() },
  ];
}

/**
 * Records a bounded failure anchor at the operation source. Export only reads
 * these server-authored journal facts; neither the browser nor the CLI may
 * manufacture one from a submitted correlation id or free-text summary.
 */
export function recordDiagnosticsFailureIncident(
  input: {
    readonly correlationId: CorrelationId;
    readonly domain: DiagnosticFailureDomain;
    readonly failureCode: DiagnosticFailureCode;
    readonly observedAt: string;
  },
  deps: Pick<DiagnosticsExportServiceDeps, "journal" | "eventIdGenerator">,
): void {
  deps.journal.append({
    aggregate: { aggregateType: "diagnostics-incident", aggregateId: input.correlationId },
    expectedVersion: 0,
    events: [createDiagnosticsFailureIncidentEvent(input, deps)],
  });
}

/**
 * Builds the durable support anchor for an operation-owned journal append.
 *
 * A caller can append this alongside its own terminal event, on that
 * operation's aggregate, so a crash cannot commit a failed operation while
 * losing its exportable support anchor. `recordDiagnosticsFailureIncident`
 * above remains the standalone path for failure boundaries which do not have
 * an operation event to co-commit with.
 */
export function createDiagnosticsFailureIncidentEvent(
  input: {
    readonly correlationId: CorrelationId;
    readonly domain: DiagnosticFailureDomain;
    readonly failureCode: DiagnosticFailureCode;
    readonly observedAt: string;
  },
  deps: Pick<DiagnosticsExportServiceDeps, "eventIdGenerator">,
) {
  const eventIdGenerator = deps.eventIdGenerator ?? randomUUID;
  const domain = decodeDiagnosticFailureDomain(input.domain);
  const failureCode = decodeDiagnosticFailureCode(input.failureCode);
  return {
    eventId: eventIdGenerator(),
    eventName: DIAGNOSTICS_FAILURE_INCIDENT_RECORDED,
    eventVersion: 1 as const,
    correlationId: input.correlationId,
    actor: { kind: "system" as const, actorId: OCTANT_LOCAL_ACTOR_ID },
    occurredAt: input.observedAt,
    payload: { domain, failureCode, outcome: "failed" as const },
  };
}

export function exportDiagnosticsEvidence(
  request: DiagnosticsExportRequest,
  deps: DiagnosticsExportServiceDeps,
): DiagnosticsExportOutcome {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const idGenerator = deps.idGenerator ?? randomUUID;
  const eventIdGenerator = deps.eventIdGenerator ?? randomUUID;

  let incident;
  try {
    incident = readDiagnosticsFailureIncident(deps.connection, request.correlationId);
  } catch {
    return {
      kind: "failed",
      failure: {
        category: "persistence-failed",
        message: "Diagnostics export could not verify the reported failure.",
      },
    };
  }
  if (incident === undefined) {
    return {
      kind: "failed",
      failure: {
        category: "incomplete",
        message: "The reported failure could not be verified from the host journal.",
      },
    };
  }
  if (incident.domain !== request.domain || incident.outcome !== "failed") {
    return {
      kind: "failed",
      failure: {
        category: "invalid-input",
        message: "The reported failure does not match the selected diagnostic domain.",
      },
    };
  }

  const generatedAt = clock();
  const packetId = idGenerator();
  const hostVersions = hostComponentVersions(deps.octantVersion);

  const built = buildDiagnosticsPacket({
    packetId,
    domain: request.domain,
    failureCode: incident.failureCode,
    summary: request.summary,
    hostVersions,
    candidateVersions: hostVersions,
    correlations: [{ correlationId: request.correlationId, observedAt: incident.observedAt }],
    recovery: [{ action: defaultDiagnosticsRecoveryAction(request.domain), automated: false }],
    generatedAt,
  });

  if (built.kind === "failed") {
    return { kind: "failed", failure: built.failure };
  }

  const packetContents = serializeDiagnosticsEvidencePacket(built.packet);
  const contentDigest = createHash("sha256").update(packetContents).digest("hex");
  const createdAt = clock();

  let persistedReceipt: ReturnType<typeof decodeDiagnosticsExportReceipt> | undefined;
  try {
    const receiptFields = buildDiagnosticsExportReceipt(built.packet, contentDigest, createdAt);
    const receipt = decodeDiagnosticsExportReceipt(receiptFields);
    deps.journal.append({
      aggregate: { aggregateType: "diagnostics-export", aggregateId: receipt.packetId },
      expectedVersion: 0,
      events: [
        {
          eventId: eventIdGenerator(),
          eventName: DIAGNOSTICS_EXPORT_RECEIPT_RECORDED,
          eventVersion: 1,
          correlationId: request.correlationId,
          actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
          occurredAt: createdAt,
          payload: { receipt },
        },
      ],
    });
    persistedReceipt = readDiagnosticsExportReceipt(deps.connection, built.packet.packetId);
    if (persistedReceipt === undefined) {
      throw new Error("Diagnostics export receipt could not be confirmed after persistence.");
    }
  } catch (error) {
    const sealedFailure = sealDiagnosticsExport(built.packet, {
      kind: "failed",
      reason: error instanceof Error ? error.message : String(error),
    });
    // sealDiagnosticsExport always returns "failed" for a failed persistence
    // outcome, so this branch never fabricates a packet.
    return sealedFailure.kind === "failed"
      ? { kind: "failed", failure: sealedFailure.failure }
      : {
          kind: "failed",
          failure: {
            category: "persistence-failed",
            message: "Diagnostics export was not persisted.",
          },
        };
  }

  const sealed = sealDiagnosticsExport(built.packet, { kind: "persisted" });
  if (sealed.kind === "failed") {
    return { kind: "failed", failure: sealed.failure };
  }

  return { kind: "exported", packet: sealed.packet, receipt: persistedReceipt };
}
