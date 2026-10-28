import {
  decodeValidationEvidenceRecord,
  decodeValidationPlan,
  decodeValidationReport,
  type AppleBuildEvidence,
  type AppleDeviceEvidence,
  type AppleUploadEvidence,
  type ValidationEvidenceRecord,
  type ValidationOutcome,
  type ValidationPlan,
  type ValidationReport,
} from "@octant/contracts";
import { isAppleSimulatorInputKind } from "@octant/domain";

export interface ComposedAppleValidationEvents {
  readonly plan: ValidationPlan;
  readonly record: ValidationEvidenceRecord;
  readonly report: ValidationReport;
}

export function composeAppleValidationEvents(input: {
  readonly evidence: AppleBuildEvidence | AppleDeviceEvidence | AppleUploadEvidence;
  readonly startedAt: string;
  readonly newId: () => string;
}): ComposedAppleValidationEvents {
  const evidence = input.evidence;
  // A physical device's evidence is journaled beside the Simulator's under
  // steps of its own; it carries no typed input to redact.
  const device = "deviceId" in evidence;
  const upload = evidence.kind === "upload";
  const stepId = upload
    ? "apple-distribution-upload"
    : device
      ? `apple-device-${evidence.kind}`
      : `apple-${evidence.kind}`;
  const outcome = validationOutcome(evidence.outcome);
  const redactTyped = evidence.kind === "type-text";
  const simulatorInput =
    !("deviceId" in evidence) &&
    evidence.kind !== "upload" &&
    isAppleSimulatorInputKind(evidence.kind);
  const plan = decodeValidationPlan({
    planId: input.evidence.actionId,
    authority: input.evidence.authority,
    steps: [
      {
        stepId,
        description: upload
          ? "Upload a person-confirmed build to App Store Connect."
          : device
            ? `Run bounded Apple device ${evidence.kind}.`
            : `Run bounded Apple ${evidence.kind} validation.`,
        sources: [source(input.evidence)],
        expectedOutcome: "passed",
      },
    ],
    createdAt: input.startedAt,
    budgetMs: Math.max(1, Math.min(600_000, input.evidence.durationMs || 1)),
  });
  const uploadRecord = evidence.kind === "upload" ? uploadSummary(evidence) : undefined;
  const diagnosticsDetail = redactTyped
    ? input.evidence.diagnostics
        .map(({ severity, message }) => `${severity}: ${redactPossibleTypedText(message)}`)
        .join("\n")
        .slice(0, 8192)
    : input.evidence.diagnostics.length === 0
      ? undefined
      : input.evidence.diagnostics
          .map(({ severity, message }) => `${severity}: ${message}`)
          .join("\n")
          .slice(0, 8192);
  const detail =
    uploadRecord === undefined
      ? diagnosticsDetail
      : [uploadRecord, diagnosticsDetail]
          .filter((line) => line !== undefined)
          .join("\n")
          .slice(0, 8192);
  const record = decodeValidationEvidenceRecord({
    evidenceId: input.newId(),
    planId: plan.planId,
    stepId,
    source: source(input.evidence),
    outcome,
    authority: input.evidence.authority,
    observedAt: input.evidence.completedAt,
    ...(detail === undefined || detail.length === 0 ? {} : { detail }),
    // Typed Simulator input never stores characters in durable evidence.
    redacted: redactTyped || simulatorInput,
  });
  const report = decodeValidationReport({
    planId: plan.planId,
    authority: input.evidence.authority,
    evidence: [record],
    overallOutcome: outcome,
    completedAt: input.evidence.completedAt,
    stepResults: [{ stepId, outcome, evidenceCount: 1 }],
  });
  return { plan, record, report };
}

/**
 * The journaled record of an upload: who asked, the app, version, build, team,
 * the result, and App Store Connect's delivery identifier. Never the key or the
 * archive.
 */
function uploadSummary(evidence: AppleUploadEvidence): string {
  const requestedBy =
    evidence.requestedBy.kind === "agent" ? "the thread's agent" : evidence.requestedBy.kind;
  return [
    `Upload ${evidence.outcome}: ${evidence.upload.bundleIdentifier} ${evidence.upload.version} (${evidence.upload.buildNumber})`,
    `team ${evidence.upload.signing.teamId}`,
    `requested by ${requestedBy}, confirmed by a person at this Mac`,
    ...(evidence.deliveryId === undefined ? [] : [`delivery ${evidence.deliveryId}`]),
  ].join("; ");
}

function source(evidence: AppleBuildEvidence | AppleDeviceEvidence | AppleUploadEvidence) {
  return {
    kind: evidence.kind === "test" ? ("apple-test" as const) : ("apple-build" as const),
    reference: evidence.artifacts[0]?.reference ?? `apple-action-${String(evidence.actionId)}`,
    actionId: evidence.actionId,
    correlationId: evidence.correlationId,
  };
}

function validationOutcome(outcome: AppleBuildEvidence["outcome"]): ValidationOutcome {
  switch (outcome) {
    case "succeeded":
      return "passed";
    case "failed":
    case "process-died":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "interrupted";
    case "timed-out":
      return "inconclusive";
    case "unavailable":
    case "unauthorized":
    case "invalid-destination":
      return "unavailable";
  }
}

function redactPossibleTypedText(message: string): string {
  if (message.includes("redacted") || message.startsWith("type-text")) return message;
  return "type-text detail redacted";
}
