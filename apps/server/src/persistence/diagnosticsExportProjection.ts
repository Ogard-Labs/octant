import {
  decodeDiagnosticsExportReceipt,
  decodeDiagnosticsExportReceiptRecorded,
  decodeDiagnosticsFailureIncidentRecorded,
  decodeDiagnosticsFailureIncidentRecordedV1,
  type DiagnosticFailureCode,
  type DiagnosticFailureDomain,
  type DiagnosticsExportReceipt,
  type EventEnvelope,
} from "@octant/contracts";
import type { Projection } from "./projection";
import type { SqliteConnection, SqliteStatement } from "./sqlitePort";

export const DIAGNOSTICS_FAILURE_INCIDENT_RECORDED_V1 = "diagnostics.failure-incident-recorded@1";
export const DIAGNOSTICS_FAILURE_INCIDENT_RECORDED = "diagnostics.failure-incident-recorded@2";
export const DIAGNOSTICS_EXPORT_RECEIPT_RECORDED = "diagnostics.export-receipt-recorded@1";
const LEGACY_FAILURE_CODE = "legacy-unknown";

interface DiagnosticsExportReceiptRow {
  readonly packet_id: string;
  readonly domain: string;
  readonly failure_code: string;
  readonly redactions_json: string;
  readonly content_digest: string;
  readonly generated_at: string;
  readonly created_at: string;
}

export interface DiagnosticsFailureIncident {
  readonly correlationId: string;
  readonly domain: DiagnosticFailureDomain;
  readonly failureCode: DiagnosticFailureCode;
  readonly outcome: "failed";
  readonly observedAt: string;
}

interface DiagnosticsFailureIncidentRow {
  readonly correlation_id: string;
  readonly domain: string;
  readonly failure_code: string;
  readonly outcome: "failed";
  readonly observed_at: string;
}

interface ProjectionStatements {
  readonly incident: SqliteStatement;
  readonly receipt: SqliteStatement;
}

/**
 * Rebuildable projection for both the authoritative failure anchors and the
 * bounded export receipts. It deliberately accepts only its two registered
 * journal event names; direct SQLite writes are not a diagnostics export path.
 */
export class DiagnosticsExportProjection implements Projection {
  readonly name = "diagnostics-exports";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];
  #statements = new WeakMap<SqliteConnection, ProjectionStatements>();

  reset(connection: SqliteConnection): void {
    connection.exec(
      "DELETE FROM diagnostics_export_receipt_projection; DELETE FROM diagnostics_failure_incident_projection;",
    );
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    const statements = this.#statementsFor(connection);
    if (
      event.eventName === DIAGNOSTICS_FAILURE_INCIDENT_RECORDED_V1 ||
      event.eventName === DIAGNOSTICS_FAILURE_INCIDENT_RECORDED
    ) {
      // `rootless-thread` is a retired aggregate type. Journals written before
      // threads required a Project still carry incidents stamped with it, and
      // replay decodes every row, so dropping it here would fail those rows and
      // quarantine the projection.
      if (
        event.eventVersion !== 1 ||
        !["diagnostics-incident", "chat-thread", "rootless-thread"].includes(event.aggregateType)
      ) {
        throw new Error("Diagnostics incident event envelope is inconsistent.");
      }
      const incident =
        event.eventName === DIAGNOSTICS_FAILURE_INCIDENT_RECORDED_V1
          ? {
              ...decodeDiagnosticsFailureIncidentRecordedV1(event.payload),
              failureCode: LEGACY_FAILURE_CODE,
            }
          : decodeDiagnosticsFailureIncidentRecorded(event.payload);
      if (
        event.aggregateType === "diagnostics-incident" &&
        String(event.aggregateId) !== String(event.correlationId)
      ) {
        throw new Error("Diagnostics incident aggregate does not match its correlation.");
      }
      statements.incident.run(
        event.correlationId,
        incident.domain,
        incident.failureCode,
        incident.outcome,
        event.occurredAt,
        event.globalSequence,
      );
      return;
    }

    if (event.eventName !== DIAGNOSTICS_EXPORT_RECEIPT_RECORDED) return;
    if (event.eventVersion !== 1 || event.aggregateType !== "diagnostics-export") {
      throw new Error("Diagnostics receipt event envelope is inconsistent.");
    }
    const receipt = decodeDiagnosticsExportReceiptRecorded(event.payload).receipt;
    if (String(event.aggregateId) !== String(receipt.packetId)) {
      throw new Error("Diagnostics receipt aggregate does not match its packet.");
    }
    statements.receipt.run(
      receipt.packetId,
      receipt.domain,
      receipt.failureCode,
      JSON.stringify(receipt.redactions),
      receipt.contentDigest,
      receipt.generatedAt,
      receipt.createdAt,
    );
  }

  #statementsFor(connection: SqliteConnection): ProjectionStatements {
    const cached = this.#statements.get(connection);
    if (cached !== undefined) return cached;
    const statements = {
      incident: connection.prepare(`
        INSERT INTO diagnostics_failure_incident_projection (
          correlation_id, domain, failure_code, outcome, observed_at, last_sequence
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (correlation_id) DO UPDATE SET
          domain = excluded.domain,
          failure_code = excluded.failure_code,
          outcome = excluded.outcome,
          observed_at = excluded.observed_at,
          last_sequence = excluded.last_sequence
        WHERE excluded.last_sequence > diagnostics_failure_incident_projection.last_sequence
      `),
      receipt: connection.prepare(`
        INSERT INTO diagnostics_export_receipt_projection (
          packet_id, domain, failure_code, redactions_json, content_digest, generated_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (packet_id) DO NOTHING
      `),
    };
    this.#statements.set(connection, statements);
    return statements;
  }
}

export function readDiagnosticsFailureIncident(
  connection: SqliteConnection,
  correlationId: string,
): DiagnosticsFailureIncident | undefined {
  const row = connection
    .prepare(`
      SELECT correlation_id, domain, failure_code, outcome, observed_at
      FROM diagnostics_failure_incident_projection
      WHERE correlation_id = ?
    `)
    .get(correlationId) as DiagnosticsFailureIncidentRow | undefined;
  if (row === undefined) return undefined;
  const incident = decodeDiagnosticsFailureIncidentRecorded({
    domain: row.domain,
    failureCode: row.failure_code,
    outcome: row.outcome,
  });
  return {
    correlationId: row.correlation_id,
    domain: incident.domain,
    failureCode: incident.failureCode,
    outcome: incident.outcome,
    observedAt: row.observed_at,
  };
}

export function readDiagnosticsExportReceipt(
  connection: SqliteConnection,
  packetId: string,
): DiagnosticsExportReceipt | undefined {
  const row = connection
    .prepare("SELECT * FROM diagnostics_export_receipt_projection WHERE packet_id = ?")
    .get(packetId) as DiagnosticsExportReceiptRow | undefined;
  if (row === undefined) return undefined;
  return decodeDiagnosticsExportReceipt({
    packetId: row.packet_id,
    domain: row.domain,
    failureCode: row.failure_code,
    redactions: JSON.parse(row.redactions_json),
    contentDigest: row.content_digest,
    generatedAt: row.generated_at,
    createdAt: row.created_at,
  });
}
