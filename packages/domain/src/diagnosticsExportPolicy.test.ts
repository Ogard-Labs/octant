import { describe, expect, it } from "vitest";
import { decodeDiagnosticEvidencePacket, type DiagnosticEvidencePacket } from "@octant/contracts";
import {
  authorizeDiagnosticsExportActor,
  buildDiagnosticsExportReceipt,
  defaultDiagnosticsRecoveryAction,
  type DiagnosticsExportActorKind,
} from "./diagnosticsExportPolicy";

const samplePacket: DiagnosticEvidencePacket = decodeDiagnosticEvidencePacket({
  packetVersion: 1,
  packetId: "00000000-0000-4000-8000-0000000000aa",
  domain: "provider",
  failureCode: "provider-support-export",
  summary: "Provider request failed after retrying twice.",
  hostVersions: [{ component: "runtime", version: "v22.1.0" }],
  candidateVersions: [{ component: "runtime", version: "v22.1.0" }],
  correlations: [
    {
      correlationId: "00000000-0000-4000-8000-000000000001",
      observedAt: "2026-08-10T12:00:00.000Z",
    },
  ],
  recovery: [
    {
      action: "Verify provider credentials and network connectivity, then retry the request.",
      automated: false,
    },
  ],
  redactions: [],
  redacted: true,
  generatedAt: "2026-08-10T12:00:00.000Z",
});

describe("authorizeDiagnosticsExportActor", () => {
  it("allows only a local-window actor", () => {
    expect(authorizeDiagnosticsExportActor("local-window")).toEqual({ kind: "allowed" });
  });

  it.each<DiagnosticsExportActorKind>(["remote-device", "provider", "automation", "extension"])(
    "fails closed for %s",
    (actorKind) => {
      expect(authorizeDiagnosticsExportActor(actorKind)).toEqual({
        kind: "denied",
        reason: "actor-not-local-host",
      });
    },
  );
});

describe("defaultDiagnosticsRecoveryAction", () => {
  it("returns a safe, non-empty, domain-specific recovery hint for every supported domain", () => {
    const domains = [
      "provider",
      "storage",
      "network",
      "remote-auth",
      "migration",
      "confinement",
      "process-cleanup",
    ] as const;
    for (const domain of domains) {
      const action = defaultDiagnosticsRecoveryAction(domain);
      expect(action.length).toBeGreaterThan(0);
      expect(action).not.toMatch(/[/\\]/);
    }
  });
});

describe("buildDiagnosticsExportReceipt", () => {
  it("projects only bounded metadata from a sealed packet, never free text", () => {
    const receipt = buildDiagnosticsExportReceipt(
      samplePacket,
      "a".repeat(64),
      "2026-08-10T12:00:01.000Z",
    );
    expect(receipt).toEqual({
      packetId: samplePacket.packetId,
      domain: samplePacket.domain,
      failureCode: samplePacket.failureCode,
      redactions: samplePacket.redactions,
      contentDigest: "a".repeat(64),
      generatedAt: samplePacket.generatedAt,
      createdAt: "2026-08-10T12:00:01.000Z",
    });
    expect(Object.keys(receipt)).not.toContain("summary");
    expect(Object.keys(receipt)).not.toContain("recovery");
    expect(Object.keys(receipt)).not.toContain("correlations");
    expect(Object.keys(receipt)).not.toContain("hostVersions");
    expect(Object.keys(receipt)).not.toContain("candidateVersions");
  });
});
