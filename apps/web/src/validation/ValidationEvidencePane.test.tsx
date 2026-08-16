import { describe, expect, it } from "vitest";
import type { ValidationEvidenceSnapshot } from "@octant/contracts/validation-rpc";
import { renderToStaticMarkup } from "react-dom/server";
import { ValidationEvidencePane } from "./ValidationEvidencePane";

describe("ValidationEvidencePane", () => {
  it("renders loading state", () => {
    const html = renderToStaticMarkup(<ValidationEvidencePane status="loading" />);
    expect(html).toContain("Loading validation evidence");
    expect(html).toContain("validation-pane--loading");
  });

  it("renders waiting state", () => {
    const html = renderToStaticMarkup(<ValidationEvidencePane status="waiting" />);
    expect(html).toContain("Waiting for validation evidence");
    expect(html).toContain("validation-pane--waiting");
  });

  it("renders unavailable state with message and retry", () => {
    const html = renderToStaticMarkup(
      <ValidationEvidencePane
        status="unavailable"
        errorMessage="Service down"
        onRetry={() => {}}
      />,
    );
    expect(html).toContain("Validation evidence unavailable");
    expect(html).toContain("Service down");
    expect(html).toContain("Retry");
  });

  it("renders interrupted state with retry", () => {
    const html = renderToStaticMarkup(
      <ValidationEvidencePane status="interrupted" onRetry={() => {}} />,
    );
    expect(html).toContain("Validation evidence interrupted");
    expect(html).toContain("Retry");
  });

  it("renders failed state with alert message", () => {
    const html = renderToStaticMarkup(
      <ValidationEvidencePane status="failed" errorMessage="Auth denied" onRetry={() => {}} />,
    );
    expect(html).toContain("Validation evidence failed");
    expect(html).toContain("Auth denied");
    expect(html).toContain('role="alert"');
  });

  it.each([
    ["denied", "Validation evidence denied"],
    ["missing", "Validation evidence missing"],
    ["stale", "Validation evidence stale"],
    ["superseded", "Validation evidence superseded"],
  ] as const)("renders the distinct %s state", (status, label) => {
    const html = renderToStaticMarkup(
      <ValidationEvidencePane
        status={status}
        errorMessage={`${status} detail`}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain(label);
    expect(html).toContain(`${status} detail`);
  });

  it("renders empty state when no snapshot", () => {
    const html = renderToStaticMarkup(<ValidationEvidencePane status="ready" />);
    expect(html).toContain("No validation evidence yet");
  });

  it("renders snapshot with steps and timeline", () => {
    const snapshot = {
      authority: {
        hostId: "00000000-0000-0000-0000-000000000001",
        mode: "code" as const,
        projectId: "00000000-0000-0000-0000-000000000002",
        providerInstanceId: "00000000-0000-0000-0000-000000000003",
        extension: { kind: "core" as const },
      },
      sequence: 1,
      snapshotAt: "2026-07-25T10:00:00.000Z",
      timeline: [
        {
          sequence: 3,
          correlationId: "00000000-0000-0000-0000-000000000012",
          evidenceId: "00000000-0000-0000-0000-000000000010",
          planId: "00000000-0000-0000-0000-000000000011",
          stepId: "step-1",
          outcome: "passed" as const,
          sourceKind: "repository-test" as const,
          sourceReference: "test-suite-a",
          redacted: false,
          observedAt: "2026-07-25T10:00:00.000Z",
        },
      ],
      steps: [
        {
          sequence: 3,
          correlationId: "00000000-0000-0000-0000-000000000012",
          stepId: "step-1",
          description: "Run unit tests",
          outcome: "passed" as const,
          evidenceCount: 1,
          sourceKinds: ["repository-test" as const],
        },
      ],
      overallOutcome: "passed" as const,
    };
    const html = renderToStaticMarkup(
      <ValidationEvidencePane
        status="ready"
        snapshot={snapshot as unknown as ValidationEvidenceSnapshot}
      />,
    );
    expect(html).toContain("All checks passed");
    expect(html).toContain("Run unit tests");
    expect(html).toContain("test-suite-a");
    expect(html).toContain("repository-test");
  });

  it("renders redacted timeline entries", () => {
    const snapshot = {
      authority: {
        hostId: "00000000-0000-0000-0000-000000000001",
        mode: "code" as const,
        projectId: "00000000-0000-0000-0000-000000000002",
        providerInstanceId: "00000000-0000-0000-0000-000000000003",
        extension: { kind: "core" as const },
      },
      sequence: 1,
      snapshotAt: "2026-07-25T10:00:00.000Z",
      timeline: [
        {
          evidenceId: "00000000-0000-0000-0000-000000000010",
          planId: "00000000-0000-0000-0000-000000000011",
          stepId: "step-1",
          outcome: "passed" as const,
          sourceKind: "repository-test" as const,
          sourceReference: "redacted-ref",
          redacted: true,
          observedAt: "2026-07-25T10:00:00.000Z",
        },
      ],
      steps: [],
      overallOutcome: "passed" as const,
    };
    const html = renderToStaticMarkup(
      <ValidationEvidencePane
        status="ready"
        snapshot={snapshot as unknown as ValidationEvidenceSnapshot}
      />,
    );
    expect(html).toContain("Redacted");
  });
});
