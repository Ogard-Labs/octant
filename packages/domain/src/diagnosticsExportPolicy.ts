import type { DiagnosticEvidencePacket, DiagnosticFailureDomain } from "@octant/contracts";

/**
 * Pure authority and receipt-shaping policy for the authenticated redacted
 * evidence export transport. The diagnostics export command itself
 * lives in `apps/server` and the redaction/sealing policy it must invoke
 * without bypass is `./diagnosticsPolicy`; this module only
 * decides who may trigger that command and what bounded metadata a sealed
 * export may persist.
 */

/**
 * Every kind of caller the diagnostics export command could ever be reached
 * by. Only a local authenticated user (`local-window`) may generate an
 * evidence packet — a remote device, a provider process, an automation/agent
 * run, and an extension must all fail closed.
 */
export type DiagnosticsExportActorKind =
  | "local-window"
  | "remote-device"
  | "provider"
  | "automation"
  | "extension";

export type DiagnosticsExportAuthorization =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly reason: "actor-not-local-host" };

/**
 * Single source of truth every transport (HTTP route, CLI) must call before
 * invoking the diagnostics redaction/sealing policy. A caller that reaches
 * `buildDiagnosticsPacket`/`sealDiagnosticsExport` without first getting
 * `{ kind: "allowed" }` from here is a defect, not a supported path.
 */
export function authorizeDiagnosticsExportActor(
  actorKind: DiagnosticsExportActorKind,
): DiagnosticsExportAuthorization {
  return actorKind === "local-window"
    ? { kind: "allowed" }
    : { kind: "denied", reason: "actor-not-local-host" };
}

const DEFAULT_RECOVERY_ACTIONS: Readonly<Record<DiagnosticFailureDomain, string>> = {
  provider: "Verify provider credentials and network connectivity, then retry the request.",
  storage: "Run the database verify command and restore from the latest backup if needed.",
  network: "Check network connectivity and retry the request.",
  "remote-auth": "Re-pair the remote device and verify the paired host clock.",
  migration: "Review the migration backup and retry after restoring if needed.",
  confinement: "Verify the bound project root and sandbox permissions.",
  "process-cleanup": "Restart Octant to clear orphaned process state.",
};

/**
 * Generic, safe, domain-specific recovery guidance for a self-service export.
 * The text is a fixed, reviewed phrase (not derived from user or host free
 * text), so it can never smuggle unredacted content into a packet.
 */
export function defaultDiagnosticsRecoveryAction(domain: DiagnosticFailureDomain): string {
  return DEFAULT_RECOVERY_ACTIONS[domain];
}

export interface DiagnosticsExportReceiptFields {
  readonly packetId: string;
  readonly domain: DiagnosticFailureDomain;
  readonly failureCode: string;
  readonly redactions: ReadonlyArray<string>;
  readonly contentDigest: string;
  readonly generatedAt: string;
  readonly createdAt: string;
}

/**
 * Project only bounded, closed-vocabulary metadata from a sealed packet into
 * a persistable receipt. The summary, recovery text, correlations, and
 * version facts never appear here — only identifiers, the redaction tag set,
 * and a content digest of the sealed packet, so the durable store can never
 * hold free text or private content even by accident.
 */
export function buildDiagnosticsExportReceipt(
  packet: DiagnosticEvidencePacket,
  contentDigest: string,
  createdAt: string,
): DiagnosticsExportReceiptFields {
  return {
    packetId: packet.packetId,
    domain: packet.domain,
    failureCode: packet.failureCode,
    redactions: packet.redactions,
    contentDigest,
    generatedAt: packet.generatedAt,
    createdAt,
  };
}
