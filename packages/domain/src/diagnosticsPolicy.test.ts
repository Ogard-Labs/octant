import { describe, expect, it } from "vitest";
import { decodeDiagnosticEvidencePacket } from "@octant/contracts";
import {
  buildDiagnosticsPacket,
  redactDiagnosticText,
  sealDiagnosticsExport,
  type RawDiagnosticInput,
} from "./diagnosticsPolicy";

const validInput: RawDiagnosticInput = {
  packetId: "00000000-0000-4000-8000-0000000000aa",
  domain: "remote-auth",
  failureCode: "remote-pairing-rejected",
  summary: "Pairing rejected before the session opened.",
  hostVersions: [{ component: "@octant/server", version: "1.4.2" }],
  candidateVersions: [{ component: "@octant/server", version: "1.5.0-rc.1" }],
  correlations: [
    {
      correlationId: "00000000-0000-4000-8000-000000000001",
      observedAt: "2026-08-03T12:00:00.000Z",
    },
  ],
  recovery: [{ action: "Re-run pairing from the desktop host.", automated: false }],
  generatedAt: "2026-08-03T12:00:01.000Z",
};

describe("redactDiagnosticText", () => {
  it("leaves already-safe text unchanged with no tags", () => {
    const result = redactDiagnosticText("Handshake timed out after 30s.");
    expect(result.text).toBe("Handshake timed out after 30s.");
    expect(result.tags).toEqual([]);
  });

  it("redacts a bearer credential", () => {
    const result = redactDiagnosticText("Rejected Authorization: Bearer abcdef123456 token");
    expect(result.text).not.toContain("abcdef123456");
    expect(result.text).toContain("[redacted-credential]");
    expect(result.tags).toContain("credential");
  });

  it("redacts a private key block", () => {
    const result = redactDiagnosticText(
      "Loaded key -----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
    );
    expect(result.text).not.toContain("PRIVATE KEY");
    expect(result.tags).toContain("private-key");
  });

  it("redacts credentialed URL userinfo", () => {
    const result = redactDiagnosticText("Reached https://user:s3cr3t@host.example/session");
    expect(result.text).not.toContain("s3cr3t");
    expect(result.tags).toContain("credential");
  });

  it("redacts an sk- style token", () => {
    const result = redactDiagnosticText("Provider key sk-abcdefghijklmnop123456 invalid");
    expect(result.text).not.toContain("sk-abcdefghijklmnop123456");
    expect(result.tags).toContain("credential");
  });

  it("redacts a multipart sk-proj- provider key across hyphen segments", () => {
    const result = redactDiagnosticText("Provider key sk-proj-abcdefghijklmnop rejected");
    expect(result.text).not.toContain("sk-proj-abcdefghijklmnop");
    expect(result.text).toContain("[redacted-credential]");
    expect(result.tags).toContain("credential");
  });

  it("redacts pairing material", () => {
    const result = redactDiagnosticText("pairing-code: 8F3K-2Q9Z expired");
    expect(result.text).not.toContain("8F3K-2Q9Z");
    expect(result.tags).toContain("pairing-material");
  });

  it("redacts session material", () => {
    const result = redactDiagnosticText("session-token=deadbeefcafebabe dropped");
    expect(result.text).not.toContain("deadbeefcafebabe");
    expect(result.tags).toContain("session-material");
  });

  it("redacts absolute home roots", () => {
    const result = redactDiagnosticText("Denied write to /Users/alex/private/notes.md");
    expect(result.text).not.toContain("/Users/alex");
    expect(result.tags).toContain("sensitive-root");
  });

  it("produces deterministic, sorted, unique tags", () => {
    const a = redactDiagnosticText("Bearer abcdef123456 then Bearer zzzzzz999999");
    const b = redactDiagnosticText("Bearer abcdef123456 then Bearer zzzzzz999999");
    expect(a.tags).toEqual(b.tags);
    expect(a.tags).toEqual([...new Set(a.tags)].sort());
  });
});

describe("buildDiagnosticsPacket", () => {
  it("builds a complete, decodable, secret-free packet", () => {
    const result = buildDiagnosticsPacket(validInput);
    expect(result.kind).toBe("packet");
    if (result.kind !== "packet") return;
    expect(result.packet.redacted).toBe(true);
    expect(result.packet.domain).toBe("remote-auth");
    // The packet must itself decode against the contract schema.
    expect(() => decodeDiagnosticEvidencePacket(result.packet)).not.toThrow();
  });

  it("is deterministic for identical input", () => {
    const first = buildDiagnosticsPacket(validInput);
    const second = buildDiagnosticsPacket(validInput);
    expect(first).toEqual(second);
  });

  it("redacts secrets from the summary and records the redaction tag", () => {
    const result = buildDiagnosticsPacket({
      ...validInput,
      summary: "Rejected Authorization: Bearer abcdef123456 token",
    });
    expect(result.kind).toBe("packet");
    if (result.kind !== "packet") return;
    expect(result.packet.summary).not.toContain("abcdef123456");
    expect(result.packet.redactions).toContain("credential");
  });

  it("fails closed on a natural-language password assignment", () => {
    const result = buildDiagnosticsPacket({
      ...validInput,
      summary: "My password is hunter2 while signing in.",
    });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.category).toBe("unredactable");
  });

  it("fails closed on a short natural-language password assignment", () => {
    const result = buildDiagnosticsPacket({
      ...validInput,
      summary: "My password is 1234 while signing in.",
    });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.category).toBe("unredactable");
  });

  it("fails closed on an unsupported domain", () => {
    const result = buildDiagnosticsPacket({ ...validInput, domain: "telemetry" });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.category).toBe("unsupported-domain");
  });

  it("refuses to fabricate a failure packet for a successful outcome", () => {
    const result = buildDiagnosticsPacket({ ...validInput, succeeded: true });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.category).toBe("misleading-success");
  });

  it("fails closed when correlation evidence is missing", () => {
    const result = buildDiagnosticsPacket({ ...validInput, correlations: [] });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.category).toBe("incomplete");
  });

  it("fails closed when host versions are missing", () => {
    const result = buildDiagnosticsPacket({ ...validInput, hostVersions: [] });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.category).toBe("incomplete");
  });

  it("fails closed when no actionable recovery fact is present", () => {
    const result = buildDiagnosticsPacket({ ...validInput, recovery: [] });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.category).toBe("incomplete");
  });

  it("fails closed on an invalid failure code token", () => {
    const result = buildDiagnosticsPacket({ ...validInput, failureCode: "Not A Token" });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.category).toBe("invalid-input");
  });

  it("fails closed when a host version fact carries a credential", () => {
    const result = buildDiagnosticsPacket({
      ...validInput,
      hostVersions: [{ component: "sk-proj-abcdefghijklmnop", version: "1.0.0" }],
    });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.category).toBe("unredactable");
  });

  it("fails closed when a candidate version fact carries a credential", () => {
    const result = buildDiagnosticsPacket({
      ...validInput,
      candidateVersions: [{ component: "@octant/server", version: "sk-abcdefghijklmnop1234" }],
    });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.category).toBe("unredactable");
  });

  it("fails closed on arbitrary private content that matches no secret pattern", () => {
    const result = buildDiagnosticsPacket({
      ...validInput,
      summary: '{"thread":"private plans","body":"do not export this"}',
    });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.category).toBe("unredactable");
  });

  it.each(["The pairing code is 8F3K-2Q9Z expired.", "The pairing ticket is ticket-1234 expired."])(
    "fails closed rather than sealing pairing material: %s",
    (summary) => {
      const result = buildDiagnosticsPacket({ ...validInput, summary });
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") return;
      expect(result.failure.category).toBe("unredactable");
    },
  );

  it("fails closed on multi-line free text that cannot become a single safe phrase", () => {
    const result = buildDiagnosticsPacket({
      ...validInput,
      summary: "First private line\nSecond private line",
    });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.category).toBe("unredactable");
  });
});

describe("sealDiagnosticsExport", () => {
  it("seals a packet when persistence succeeded", () => {
    const built = buildDiagnosticsPacket(validInput);
    expect(built.kind).toBe("packet");
    if (built.kind !== "packet") return;
    const sealed = sealDiagnosticsExport(built.packet, { kind: "persisted" });
    expect(sealed.kind).toBe("sealed");
    if (sealed.kind !== "sealed") return;
    expect(sealed.packet).toEqual(built.packet);
  });

  it("fails closed with no partial packet when persistence failed", () => {
    const built = buildDiagnosticsPacket(validInput);
    expect(built.kind).toBe("packet");
    if (built.kind !== "packet") return;
    const sealed = sealDiagnosticsExport(built.packet, {
      kind: "failed",
      reason: "disk full",
    });
    expect(sealed.kind).toBe("failed");
    if (sealed.kind !== "failed") return;
    expect(sealed.failure.category).toBe("persistence-failed");
    expect(sealed).not.toHaveProperty("packet");
    expect(sealed.failure.message).toContain("disk full");
  });

  it("redacts a sensitive path or token from a persistence failure reason", () => {
    const built = buildDiagnosticsPacket(validInput);
    expect(built.kind).toBe("packet");
    if (built.kind !== "packet") return;
    const sealed = sealDiagnosticsExport(built.packet, {
      kind: "failed",
      reason: "EACCES writing /Users/alex/Library/octant.db with token sk-abcdefghijklmnop1234",
    });
    expect(sealed.kind).toBe("failed");
    if (sealed.kind !== "failed") return;
    expect(sealed.failure.category).toBe("persistence-failed");
    expect(sealed.failure.message).not.toContain("/Users/alex");
    expect(sealed.failure.message).not.toContain("sk-abcdefghijklmnop1234");
  });

  it("collapses an unredactable persistence reason to a closed generic detail", () => {
    const built = buildDiagnosticsPacket(validInput);
    expect(built.kind).toBe("packet");
    if (built.kind !== "packet") return;
    const sealed = sealDiagnosticsExport(built.packet, {
      kind: "failed",
      reason: '{"path":"/home/alex/private","note":"leak me"}',
    });
    expect(sealed.kind).toBe("failed");
    if (sealed.kind !== "failed") return;
    expect(sealed.failure.message).toContain("a redacted internal error");
    expect(sealed.failure.message).not.toContain("/home/alex");
  });
});
